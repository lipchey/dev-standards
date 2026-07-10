// E5 + Phase 5 §5.2 — the worktree selector. The deep-review engine never lands a branch
// (ADR-012: no local merge verb), but it must place the fix work in the RIGHT worktree, create
// it reproducibly, and never silently reuse or clobber a directory it does not own.
//
// It creates a dedicated `deep-review/<slug>` worktree via an ENGINE-LOCAL fixed-argv
// `git worktree add`. Phase 5 hardens the creation into an identity-anchored, all-or-nothing
// sequence:
//   1. capture the base as ref + SHA and `worktree add` FROM the captured SHA (not the branch
//      name, which could move between resolve and add);
//   2. assert the new worktree's HEAD == the captured base SHA;
//   3. set up tooling (consumer repos: submodule init + symlink the main checkout's built dist /
//      node_modules / .tools when the build stamp matches the pinned submodule SHA);
//   4. write the run descriptor LAST — its presence is the "worktree ready" marker.
// Any failure AFTER `worktree add` rolls back exactly what THIS call created (branch + worktree);
// a pre-existing worktree is reused ONLY when it carries a valid descriptor AND live tooling.
//
// Every irreversible boundary is enforced DETERMINISTICALLY before any mutation (slug sanitize,
// base resolution, parent confinement, existing-dir validation). Effects (fs + git spawn) live
// behind the injected `deps` seam; every git call is fixed-argv `spawnSync` with `shell: false`
// and a timeout bounded by the run deadline.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from './types.ts';
import type { MachineError } from './types.ts';
import { sanitizeFeatureSlug, defaultFeatureWorktree } from './feature-slug.ts';
import type { Deadline } from './deadline.ts';
import { createDeadline } from './deadline.ts';
import { writeDescriptor, verifyDescriptor } from './descriptor.ts';
import type { RunDescriptor, DescriptorVerdict, DescriptorDeps } from './descriptor.ts';

// Bound the machine-readable stderr_tail (mirrors slice.ts).
const STDERR_TAIL_MAX = 2000;

// Per-spawn timeout cap (ms). Generous headroom for `worktree add` + a submodule checkout; the
// run deadline tightens it further per call.
const GIT_CAP_MS = 120_000;

// §F8 rollback/teardown budget (ms): fixed + independent of the run deadline (see rollbackCreated).
const TEARDOWN_TIMEOUT_MS = 10_000;

// The engine's fixed worktree-BRANCH prefix; the `deep-review-<slug>` directory name is a
// deliberate engine convention (prefixed via defaultFeatureWorktree so it cannot collide with a
// feature worktree of the same bare slug).
const BRANCH_PREFIX = 'deep-review/';
const DIR_PREFIX = 'deep-review-';

// The consumer submodule path the engine ships inside; tooling wires a fresh worktree of the
// CONSUMER repo to the main checkout's built copy of this submodule.
const SUBMODULE_PATH = 'vendor/dev-standards';
// The single build stamp both bundles share (runner/dist/.built-from == the pinned submodule SHA
// the main checkout was built from). A worktree reuses the main checkout's dist only when this
// stamp matches the worktree's own pinned submodule SHA.
const BUILT_FROM_REL = 'vendor/dev-standards/runner/dist/.built-from';
// The artifacts symlinked from the main checkout into a fresh consumer worktree.
const SYMLINK_TARGETS = [
  'vendor/dev-standards/runner/dist',
  'vendor/dev-standards/deep-review/dist',
  'node_modules',
  '.tools',
] as const;

// ── Effects seam ───────────────────────────────────────────────────────────────

// The result of a fixed-argv spawn. `status` is the process exit code, or null when the process
// failed to spawn / was killed. Re-declared locally (identical to slice.ts) so this module stays
// self-contained.
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The injected effects. `spawn` runs git (fixed argv, never a shell); `existsSync` and `realpath`
// are fs reads (real-path normalization is needed because `git worktree list` reports
// symlink-resolved paths). The Phase 5 optional seams (deadline / tooling / descriptor / clock)
// default to real fs + crypto + `writeDescriptor`; tests inject them to force post-add failures,
// assert tooling ran, and pin the descriptor's run_id / created_at.
export interface WorktreeDeps {
  cwd: string;
  existsSync: (p: string) => boolean;
  realpath: (p: string) => string;
  spawn: (file: string, args: readonly string[], options: { cwd: string; timeout?: number }) => SpawnResult;
  deadline?: Deadline;
  symlink?: (target: string, linkPath: string) => void;
  readFileMaybe?: (p: string) => string | null;
  writeDescriptorFn?: (descriptor: RunDescriptor) => void;
  setupTooling?: (deps: WorktreeDeps, wtPath: string) => void;
  // §G4 the git-side identity gate used on the REUSE path; defaults to the real
  // `verifyDescriptor`. Injected in tests to assert the run deadline is threaded so its git
  // spawns are timeout-bounded (an unbounded git read could otherwise hang the reuse path).
  verifyDescriptorFn?: (wtPath: string, over?: Partial<DescriptorDeps>) => DescriptorVerdict;
  genRunId?: () => string;
  now?: () => string;
}

// What `selectWorktree` returns at the command edge. Optional fields are OMITTED (never undefined)
// under exactOptionalPropertyTypes via conditional spreads.
export interface WorktreeResult {
  exitCode: number;
  mode?: 'dedicated';
  worktree?: string;
  branch?: string;
  machineError?: MachineError;
}

// The real default spawn: fixed argv, `shell: false`, timeout-bounded. A spawn-level failure /
// timeout maps to `status: null` so the caller treats it as a non-zero (failed) result.
const defaultSpawn: WorktreeDeps['spawn'] = (file, args, options) => {
  const r = spawnSync(file, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) {
    return { status: null, stdout: '', stderr: r.error instanceof Error ? r.error.message : String(r.error) };
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// The production deps: real fs + the real fixed-argv git spawn. deep-review's worktrees always
// land under `../worktrees` off HEAD (no manifest config feeds this).
export function realWorktreeDeps(cwd: string): WorktreeDeps {
  return {
    cwd,
    existsSync: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    spawn: defaultSpawn,
  };
}

// ── Confinement guard (engine-local) ───────────────────────────────────────────

// Asserts `wtPath` resolves to `parent` itself or a path strictly under it.
export function assertUnderParent(wtPath: string, parent: string): void {
  const resolved = path.resolve(wtPath);
  const resolvedParent = path.resolve(parent);
  if (resolved !== resolvedParent && !resolved.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new Error(`worktree escapes configured parent: ${wtPath}`);
  }
}

// ── Git edge (fixed argv, shell:false, deadline-bounded) ─────────────────────────

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// The per-call spawn timeout: the fixed cap, tightened to the deadline's remaining budget. Floored
// at 1ms so an exhausted budget yields an immediate timeout (spawnSync treats 0 as "no timeout").
function spawnTimeout(deps: WorktreeDeps): number {
  if (deps.deadline === undefined) return GIT_CAP_MS;
  return Math.max(1, Math.min(GIT_CAP_MS, deps.deadline.remainingMs()));
}

// A read-only git spawn in `cwd` (defaults to the engine cwd), timeout-bounded.
function spawnGit(deps: WorktreeDeps, args: string[], cwd: string = deps.cwd): SpawnResult {
  return deps.spawn('git', args, { cwd, timeout: spawnTimeout(deps) });
}

// A failing git step, carrying the §2.4 MachineError fields (mirrors slice.ts GitStepError).
class GitStepError extends Error {
  readonly kind = 'worktree-git-error' as const;
  readonly command: string;
  readonly stderr_tail: string;
  readonly step: string;
  constructor(step: string, command: string, stderrTail: string, message: string) {
    super(message);
    this.name = 'GitStepError';
    this.step = step;
    this.command = command;
    this.stderr_tail = stderrTail;
    Object.setPrototypeOf(this, GitStepError.prototype);
  }
}

// Runs one git command through the spawn seam in `cwd`; returns stdout, or throws a GitStepError
// (naming `step`) on a non-zero/failed-to-spawn result. Used for the mutating steps + the
// post-add identity reads — the read-only VALIDATION checks below call the spawn seam directly
// (a non-zero exit there is the expected ANSWER, not a git error to surface).
function runGit(deps: WorktreeDeps, args: string[], step: string, cwd: string = deps.cwd): string {
  const command = `git ${args.join(' ')}`;
  const result = spawnGit(deps, args, cwd);
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new GitStepError(step, command, tailOf(result.stderr), `${command} failed (status ${result.status}): ${detail}`);
  }
  return result.stdout;
}

function machineErrorOf(error: GitStepError): MachineError {
  return {
    command: error.command,
    step: error.step,
    message: error.message,
    stderr_tail: error.stderr_tail,
  };
}

function realOf(deps: WorktreeDeps, p: string): string {
  try {
    return deps.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

// ── Consumer worktree tooling (submodule + symlinks) ────────────────────────────

// A tooling failure: the main checkout's built submodule does not match this worktree's pin, so
// symlinking its dist would run a STALE engine. Loud, with the bootstrap instruction — never a
// silent skip.
export class ToolingError extends Error {
  readonly kind = 'worktree-tooling-error' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ToolingError';
    Object.setPrototypeOf(this, ToolingError.prototype);
  }
}

function readFileMaybe(deps: WorktreeDeps, p: string): string | null {
  if (deps.readFileMaybe !== undefined) return deps.readFileMaybe(p);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function makeSymlink(deps: WorktreeDeps, target: string, linkPath: string): void {
  if (deps.symlink !== undefined) {
    deps.symlink(target, linkPath);
    return;
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
}

// Detects whether `wtPath` tracks the `vendor/dev-standards` submodule (a consumer repo). Returns
// the worktree's pinned submodule SHA when present, or null for a repo without that gitlink (core
// itself) — where tooling is a no-op.
//
// §F9 FAIL-CLOSED: "not a consumer" (null) is returned ONLY by a SUCCESSFUL check that proved the
// absence of the gitlink — an `ls-files -s` that exits 0 with either no entry or an entry whose
// tree mode is not 160000. ANY spawn fault / non-zero exit / timeout is a GitStepError (machine
// error), NEVER a silent null-collapse: collapsing a failed probe to "core repo" would skip tooling
// and run a STALE engine against the untrusted findings file.
function pinnedSubmoduleSha(deps: WorktreeDeps, wtPath: string): string | null {
  const command = `git -C ${wtPath} --literal-pathspecs ls-files -s -- ${SUBMODULE_PATH}`;
  const ls = spawnGit(deps, ['-C', wtPath, '--literal-pathspecs', 'ls-files', '-s', '--', SUBMODULE_PATH]);
  if (ls.status !== 0) {
    throw new GitStepError('consumer-detect', command, tailOf(ls.stderr), `${command} failed (status ${ls.status})`);
  }
  const line = ls.stdout.trim();
  if (line === '') return null; // proven: no gitlink entry -> a core repo, not a consumer
  // `git ls-files -s` prints `<mode> <object> <stage>\t<path>`; a submodule gitlink has mode 160000.
  const match = /^(\d+) ([0-9a-f]+) \d+\t/.exec(line);
  if (match === null) {
    throw new GitStepError('consumer-detect', command, tailOf(line), `${command} returned an unparseable index entry`);
  }
  const [, mode, sha] = match;
  if (mode !== '160000') return null; // present but not a gitlink -> not a consumer submodule
  return sha ?? null;
}

// The main checkout path is the parent of the shared git-common-dir (a worktree's common-dir is
// `<main>/.git`).
function mainCheckoutOf(deps: WorktreeDeps, wtPath: string): string | null {
  const common = spawnGit(deps, ['-C', wtPath, 'rev-parse', '--git-common-dir']);
  if (common.status !== 0) return null;
  const raw = common.stdout.trim();
  const abs = path.isAbsolute(raw) ? raw : path.resolve(wtPath, raw);
  return path.dirname(realOf(deps, abs));
}

// Sets up a fresh consumer worktree: init the submodule, then (when the main checkout's build
// stamp matches this worktree's pinned submodule SHA) symlink the built dist / node_modules /
// .tools from the main checkout. A stamp mismatch throws ToolingError (run bootstrap). A repo with
// no `vendor/dev-standards` gitlink (core itself) is a no-op.
export function setupWorktreeTooling(deps: WorktreeDeps, wtPath: string): void {
  const pinned = pinnedSubmoduleSha(deps, wtPath);
  if (pinned === null) return; // no consumer gitlink -> nothing to wire

  runGit(deps, ['-C', wtPath, 'submodule', 'update', '--init', '--', SUBMODULE_PATH], 'submodule-init', wtPath);

  const main = mainCheckoutOf(deps, wtPath);
  if (main === null) throw new ToolingError('cannot resolve the main checkout to wire worktree tooling');

  const stamp = (readFileMaybe(deps, path.join(main, BUILT_FROM_REL)) ?? '').trim();
  if (stamp !== pinned) {
    throw new ToolingError(
      `main checkout at ${main} was built from dev-standards ${stamp || '(no stamp)'}, but this worktree pins ${pinned}; ` +
        'run scripts/ds-bootstrap.sh in the main checkout, then re-run select-worktree',
    );
  }

  for (const rel of SYMLINK_TARGETS) {
    makeSymlink(deps, path.join(main, rel), path.join(wtPath, rel));
  }
}

// Reuse-time liveness: the wired tooling targets must still resolve (a consumer worktree whose
// main checkout moved would have dangling symlinks). A repo with no gitlink is trivially alive.
function toolingAlive(deps: WorktreeDeps, wtPath: string): boolean {
  const pinned = pinnedSubmoduleSha(deps, wtPath);
  if (pinned === null) return true;
  return SYMLINK_TARGETS.every((rel) => deps.existsSync(path.join(wtPath, rel)));
}

// ── Existing-directory validation (the S21 collision gate + descriptor reuse gate) ─

function listAssociatesBranch(deps: WorktreeDeps, porcelain: string, wtPath: string, branch: string): boolean {
  const targetReal = realOf(deps, wtPath);
  const wantRef = `refs/heads/${branch}`;
  let blockPath: string | undefined;
  let blockBranch: string | undefined;
  const matches = (): boolean =>
    blockPath !== undefined && blockBranch === wantRef && realOf(deps, blockPath) === targetReal;
  for (const line of porcelain.split('\n')) {
    if (line === '') {
      if (matches()) return true;
      blockPath = undefined;
      blockBranch = undefined;
      continue;
    }
    if (line.startsWith('worktree ')) blockPath = line.slice('worktree '.length);
    else if (line.startsWith('branch ')) blockBranch = line.slice('branch '.length);
  }
  return matches();
}

function refuse(message: string): WorktreeResult {
  return {
    exitCode: EXIT_WRONG_STATE,
    machineError: { command: 'deep-review select-worktree', message, stderr_tail: '' },
  };
}

// Validates an EXISTING directory at `wtPath` before any reuse. Reuse is granted ONLY when it is
// THIS repo's worktree on exactly `branch`, it carries a VALID run descriptor, and its tooling is
// live. A plain dir, a foreign worktree, a worktree on a different branch (the S21 collision), a
// descriptor-less worktree (pre-v0.4.0 or aborted setup), or dead tooling is REFUSED with
// EXIT_WRONG_STATE and NO mutation — never a silent reuse.
function validateExistingWorktree(deps: WorktreeDeps, wtPath: string, branch: string): WorktreeResult {
  const head = spawnGit(deps, ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.status !== 0 || head.stdout.trim() !== branch) return { exitCode: EXIT_WRONG_STATE };
  const list = spawnGit(deps, ['worktree', 'list', '--porcelain']);
  if (list.status !== 0 || !listAssociatesBranch(deps, list.stdout, wtPath, branch)) {
    return { exitCode: EXIT_WRONG_STATE };
  }
  // NEW (§5.2): a descriptor-less or identity-mismatched worktree is NOT silently reused.
  // §G4 thread the run deadline so verifyDescriptor's git reads are timeout-bounded (an
  // unbounded read on the reuse path could hang the run past its budget).
  const verify = deps.verifyDescriptorFn ?? verifyDescriptor;
  const verdict = verify(wtPath, deps.deadline !== undefined ? { deadline: deps.deadline } : undefined);
  if (!verdict.ok) {
    return refuse(
      `existing worktree at ${wtPath} is not reusable: ${verdict.reason}; remove it (git worktree remove) and re-run select-worktree`,
    );
  }
  if (!toolingAlive(deps, wtPath)) {
    return refuse(
      `existing worktree at ${wtPath} has stale tooling (a symlinked artifact no longer resolves); remove it and re-run select-worktree`,
    );
  }
  return { exitCode: EXIT_OK, mode: 'dedicated', worktree: wtPath, branch };
}

// ── Base resolution (ref + SHA) ─────────────────────────────────────────────────

// Resolves the worktree parent (`../worktrees`) and the base as ref + SHA. The base ref is the
// current symbolic HEAD (a detached/no HEAD or a non-repo cwd fails closed -> the caller returns
// EXIT_WRONG_STATE); the SHA is captured NOW so the `worktree add` operand is a fixed commit, not
// a branch name that could move between resolve and add.
function resolveBase(deps: WorktreeDeps): { parent: string; baseRef: string; baseSha: string } | undefined {
  const ref = spawnGit(deps, ['symbolic-ref', 'HEAD']);
  if (ref.status !== 0) return undefined; // detached HEAD / not a repo -> no resolvable base
  const baseRef = ref.stdout.trim();
  if (baseRef === '') return undefined;
  const sha = spawnGit(deps, ['rev-parse', 'HEAD']);
  if (sha.status !== 0) return undefined;
  const baseSha = sha.stdout.trim();
  if (baseSha === '') return undefined;
  return { parent: path.resolve(deps.cwd, '../worktrees'), baseRef, baseSha };
}

// ── Post-add identity (read through the worktree spawn seam) ─────────────────────

interface WorktreeIdentity {
  gitDir: string;
  gitCommonDir: string;
  toplevel: string;
  initialHeadSha: string;
}

// Reads the new worktree's realpath-normalized git identity + initial HEAD, via the SAME spawn
// seam as the rest of the module (so a test's injected git intercepts these too). Throws
// GitStepError on any failure (the caller rolls back).
function readWorktreeIdentity(deps: WorktreeDeps, wtPath: string): WorktreeIdentity {
  const gitDirRaw = runGit(deps, ['-C', wtPath, 'rev-parse', '--absolute-git-dir'], 'identity-git-dir', wtPath).trim();
  const commonRaw = runGit(deps, ['-C', wtPath, 'rev-parse', '--git-common-dir'], 'identity-common-dir', wtPath).trim();
  const topRaw = runGit(deps, ['-C', wtPath, 'rev-parse', '--show-toplevel'], 'identity-toplevel', wtPath).trim();
  const initialHeadSha = runGit(deps, ['-C', wtPath, 'rev-parse', 'HEAD'], 'identity-head', wtPath).trim();
  return {
    gitDir: realOf(deps, gitDirRaw),
    gitCommonDir: realOf(deps, path.isAbsolute(commonRaw) ? commonRaw : path.resolve(wtPath, commonRaw)),
    toplevel: realOf(deps, topRaw),
    initialHeadSha,
  };
}

// Rolls back exactly what THIS call created: the worktree dir + the engine branch. Best-effort
// (force), never throwing — the caller is already reporting the primary failure. §F8: rollback runs
// on its OWN fixed budget, NOT the run deadline's remaining time, since a deadline-timeout failure
// leaves the run budget spent and a remainingMs-bounded rollback would be guaranteed to fail.
// §G5: BOTH spawns SHARE that one fixed budget (not 10s each → up to 20s), and any removal that
// could not be confirmed is COLLECTED and returned (undefined when both succeeded) so the caller
// appends it to the primary error — a silently-swallowed rollback error leaks a half-set-up worktree.
function rollbackCreated(deps: WorktreeDeps, wtPath: string, branch: string): string | undefined {
  const budget = createDeadline(TEARDOWN_TIMEOUT_MS / 1000);
  const failures: string[] = [];
  const wt = deps.spawn('git', ['worktree', 'remove', '--force', '--', wtPath], {
    cwd: deps.cwd,
    timeout: Math.max(1, budget.remainingMs()),
  });
  if (wt.status !== 0) failures.push(`worktree remove failed (${tailOf(wt.stderr) || `status ${wt.status}`})`);
  const br = deps.spawn('git', ['branch', '-D', branch], {
    cwd: deps.cwd,
    timeout: Math.max(1, budget.remainingMs()),
  });
  if (br.status !== 0) failures.push(`branch delete failed (${tailOf(br.stderr) || `status ${br.status}`})`);
  return failures.length > 0 ? failures.join('; ') : undefined;
}

// ── The selector ───────────────────────────────────────────────────────────────

export function selectWorktree(slug: string, deps: WorktreeDeps): WorktreeResult {
  // 1. sanitize the slug. An unsafe operand throws SlugError -> mapped to EXIT_USAGE at the CLI
  // edge (argv-level), so it is NOT caught here.
  const safeSlug = sanitizeFeatureSlug(slug);

  // 2. resolve parent + base (ref + SHA); a non-repo cwd or a detached/no HEAD fails closed.
  const resolved = resolveBase(deps);
  if (resolved === undefined) return { exitCode: EXIT_WRONG_STATE };
  const { parent, baseRef, baseSha } = resolved;

  // 3. compute the (prefixed) worktree dir + the fixed branch.
  const wtPath = defaultFeatureWorktree(parent, `${DIR_PREFIX}${safeSlug}`);
  const branch = `${BRANCH_PREFIX}${safeSlug}`;

  // 4. confinement guard (engine-local): refuse a path that escapes the parent.
  try {
    assertUnderParent(wtPath, parent);
  } catch {
    return { exitCode: EXIT_WRONG_STATE };
  }

  // 5. collision/idempotency gate: an existing dir is VALIDATED (branch + ownership + descriptor +
  // tooling), never assumed. A clean match is reused without a second add; any mismatch is refused
  // with no mutation.
  if (deps.existsSync(wtPath)) {
    return validateExistingWorktree(deps, wtPath, branch);
  }

  // 6. create the engine-local worktree FROM THE CAPTURED SHA. `--` separates options from the two
  // positional operands so the SHA can never be misparsed as an option. Any git error here (before
  // the worktree exists) -> EXIT_FAILURE + a §2.4 machine error, no rollback needed.
  try {
    runGit(deps, ['worktree', 'add', '-b', branch, '--', wtPath, baseSha], 'worktree-add');
  } catch (error) {
    if (error instanceof GitStepError) return { exitCode: EXIT_FAILURE, machineError: machineErrorOf(error) };
    throw error;
  }

  // 7. everything past this point is post-add: on ANY failure, roll back what THIS call created.
  try {
    const identity = readWorktreeIdentity(deps, wtPath);
    if (identity.initialHeadSha !== baseSha) {
      throw new GitStepError(
        'worktree-add',
        `git worktree add -b ${branch} -- ${wtPath} ${baseSha}`,
        '',
        `worktree HEAD ${identity.initialHeadSha} != captured base ${baseSha} (base moved during add)`,
      );
    }

    // tooling BEFORE the descriptor (descriptor = "ready" marker).
    (deps.setupTooling ?? setupWorktreeTooling)(deps, wtPath);

    // descriptor LAST.
    const descriptor: RunDescriptor = {
      schema: 1,
      run_id: (deps.genRunId ?? (() => crypto.randomUUID()))(),
      created_at: (deps.now ?? (() => new Date().toISOString()))(),
      canonical_root: identity.toplevel,
      git_dir: identity.gitDir,
      git_common_dir: identity.gitCommonDir,
      branch_ref: `refs/heads/${branch}`,
      base_ref: baseRef,
      base_sha: baseSha,
      initial_head_sha: identity.initialHeadSha,
    };
    (deps.writeDescriptorFn ?? ((d: RunDescriptor) => writeDescriptor(d)))(descriptor);

    return { exitCode: EXIT_OK, mode: 'dedicated', worktree: wtPath, branch };
  } catch (error) {
    // ANY post-add failure (identity assert, tooling, descriptor write) rolls back what THIS call
    // created and surfaces a clean §2.4 machine error — a half-set-up worktree must never survive,
    // and the failure must never escape as a raw throw. §G5: a rollback that could not fully clean
    // up is appended to the primary error's message so the leak is never silent.
    const rollbackFailure = rollbackCreated(deps, wtPath, branch);
    const suffix = rollbackFailure === undefined ? '' : `; rollback incomplete: ${rollbackFailure}`;
    if (error instanceof GitStepError) {
      const machineError = machineErrorOf(error);
      return { exitCode: EXIT_FAILURE, machineError: { ...machineError, message: `${machineError.message}${suffix}` } };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: EXIT_FAILURE,
      machineError: { command: 'deep-review select-worktree', message: `${message}${suffix}`, stderr_tail: '' },
    };
  }
}
