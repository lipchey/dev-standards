// E5 — the worktree selector. The deep-review engine never lands a branch (ADR-012:
// no local merge verb), but it must place the fix work in the RIGHT worktree, and
// it must do so without ever silently reusing or clobbering a directory it does not
// own. It creates a dedicated `deep-review/<slug>` worktree via an ENGINE-LOCAL
// fixed-argv `git worktree add` (the slug sanitizer + worktree-path helper are
// extracted into ./feature-slug.ts; the add is engine-local by necessity).
//
// Every irreversible boundary is enforced DETERMINISTICALLY before any mutation:
//   - the slug is sanitized (an unsafe operand -> SlugError -> EXIT_USAGE at the edge);
//   - the base branch must resolve (a read-only HEAD read; a detached/no HEAD and a
//     non-repo cwd both fail closed with EXIT_WRONG_STATE, no partial add);
//   - the computed path must resolve UNDER the parent (an inline confinement guard
//     replicating new-feature.ts's parent check — re-implemented, never imported);
//   - an EXISTING directory at the target is VALIDATED, never assumed: it is reused
//     only if it is THIS repo's worktree on exactly `deep-review/<slug>`. A plain
//     dir, a foreign worktree, or a worktree on a DIFFERENT branch (the S21
//     collision: a feature `feature/deep-review-<slug>` occupying the same
//     `deep-review-<slug>` directory) is REFUSED with EXIT_WRONG_STATE and no mutation.
//
// Effects (fs + git spawn) live behind the injected `deps` seam so the selection
// logic is testable; every git call is fixed-argv `spawnSync` with `shell: false`.

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from './types.ts';
import type { MachineError } from './types.ts';
import { sanitizeFeatureSlug, defaultFeatureWorktree } from './feature-slug.ts';

// Bound the machine-readable stderr_tail (mirrors slice.ts / workflow trailers).
const STDERR_TAIL_MAX = 2000;

// The engine's fixed worktree-BRANCH prefix (the only part fixed by the body); the
// `deep-review-<slug>` directory name is a deliberate engine convention (a prefixed
// name via defaultFeatureWorktree so it cannot collide with a feature worktree of
// the same bare slug).
const BRANCH_PREFIX = 'deep-review/';
const DIR_PREFIX = 'deep-review-';

// ── Effects seam ───────────────────────────────────────────────────────────────

// The result of a fixed-argv spawn. `status` is the process exit code, or null when
// the process failed to spawn. Re-declared locally (identical to slice.ts) so this
// module stays self-contained — E6 imports from here, not the other way round.
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The injected effects. `spawn` runs git (fixed argv, never a shell); `existsSync`
// and `realpath` are the fs reads (real-path normalization is needed because
// `git worktree list` reports symlink-resolved paths).
export interface WorktreeDeps {
  cwd: string;
  existsSync: (p: string) => boolean;
  realpath: (p: string) => string;
  spawn: (file: string, args: readonly string[], options: { cwd: string }) => SpawnResult;
}

// What `selectWorktree` returns at the command edge. Optional fields are OMITTED
// (never undefined) under exactOptionalPropertyTypes via conditional spreads.
export interface WorktreeResult {
  exitCode: number;
  mode?: 'dedicated';
  worktree?: string;
  branch?: string;
  machineError?: MachineError;
}

// The real default spawn: fixed argv, `shell: false`. A spawn-level failure maps to
// `status: null` so the caller treats it as a non-zero (failed) result.
const defaultSpawn: WorktreeDeps['spawn'] = (file, args, options) => {
  const r = spawnSync(file, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) {
    return { status: null, stdout: '', stderr: r.error instanceof Error ? r.error.message : String(r.error) };
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// The production deps: real fs + the real fixed-argv git spawn. deep-review's
// worktrees always land under `../worktrees` off HEAD (no manifest config feeds
// this). Mirrors slice.ts `realSliceDeps` / report.ts `realReportDeps`.
export function realWorktreeDeps(cwd: string): WorktreeDeps {
  return {
    cwd,
    existsSync: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    spawn: defaultSpawn,
  };
}

// ── Confinement guard (engine-local; replicates new-feature.ts:158-164) ────────

// Asserts `wtPath` resolves to `parent` itself or a path strictly under it. A
// re-implementation of the workflow helper's parent confinement (that helper is
// private — never imported); the same `resolve` + `startsWith(parent + sep)` check.
export function assertUnderParent(wtPath: string, parent: string): void {
  const resolved = path.resolve(wtPath);
  const resolvedParent = path.resolve(parent);
  if (resolved !== resolvedParent && !resolved.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new Error(`worktree escapes configured parent: ${wtPath}`);
  }
}

// ── Git edge (fixed argv, shell:false) ─────────────────────────────────────────

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// A failing git step, carrying the §2.4 MachineError fields (mirrors slice.ts
// GitStepError). `kind` is a cross-realm tag so a bundled copy can be recognized.
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

// Runs one git command through the spawn seam; returns stdout, or throws a
// GitStepError (naming `step`) on a non-zero/failed-to-spawn result. Used ONLY for
// the mutating `worktree add` — the read-only validation checks below call the
// spawn seam directly because a non-zero exit there is the expected ANSWER
// ("not our worktree"), not a git error to surface.
function runGit(deps: WorktreeDeps, args: string[], step: string): string {
  const command = `git ${args.join(' ')}`;
  const result = deps.spawn('git', args, { cwd: deps.cwd });
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

// Best-effort real-path normalization for comparing a computed path against the
// symlink-resolved paths `git worktree list` reports. Falls back to a plain resolve
// when the path does not exist (so a comparison can still proceed, just non-equal).
function realOf(deps: WorktreeDeps, p: string): string {
  try {
    return deps.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

// ── Existing-directory validation (the S21 collision gate) ─────────────────────

// True iff `git worktree list --porcelain` records a worktree at `wtPath` (after
// real-path normalization) checked out on exactly `refs/heads/<branch>`. Parses the
// porcelain block format (`worktree <path>` … `branch refs/heads/<name>`, blocks
// separated by blank lines; the final block may have no trailing blank line).
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

// Validates an EXISTING directory at `wtPath` before any reuse. Returns a
// dedicated-reuse result ONLY when `wtPath` is THIS repo's worktree on exactly
// `branch`; ANY mismatch (plain dir, foreign worktree, or a worktree on a different
// branch — the S21 collision) returns EXIT_WRONG_STATE with NO mutation. All checks
// are read-only and run through the spawn seam directly (a non-zero exit is the
// expected "not our worktree" answer, not a surfaced git error).
function validateExistingWorktree(deps: WorktreeDeps, wtPath: string, branch: string): WorktreeResult {
  // (a) the directory must be a git checkout on exactly our branch. `-C <wtPath>`
  // searches from the directory; a plain dir (not in any repo) fails here.
  const head = deps.spawn('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: deps.cwd });
  if (head.status !== 0 || head.stdout.trim() !== branch) return { exitCode: EXIT_WRONG_STATE };
  // (b) and THIS repo must own that worktree on that branch (a worktree of a
  // DIFFERENT repo would not appear in this repo's list).
  const list = deps.spawn('git', ['worktree', 'list', '--porcelain'], { cwd: deps.cwd });
  if (list.status !== 0 || !listAssociatesBranch(deps, list.stdout, wtPath, branch)) {
    return { exitCode: EXIT_WRONG_STATE };
  }
  return { exitCode: EXIT_OK, mode: 'dedicated', worktree: wtPath, branch };
}

// ── Parent + base resolution ───────────────────────────────────────────────────

// Resolves the worktree parent (absolute) and the base branch. The parent is always
// `../worktrees` and the base is the current HEAD, read read-only. A non-repo cwd or
// a detached/no HEAD yields `undefined` (the caller fails closed, EXIT_WRONG_STATE).
function resolveParentAndBase(deps: WorktreeDeps): { parent: string; base: string } | undefined {
  const head = deps.spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: deps.cwd });
  if (head.status !== 0) return undefined;
  const base = head.stdout.trim();
  if (base === '' || base === 'HEAD') return undefined; // not a repo / detached -> no resolvable base
  return { parent: path.resolve(deps.cwd, '../worktrees'), base };
}

// ── The selector ───────────────────────────────────────────────────────────────

export function selectWorktree(slug: string, deps: WorktreeDeps): WorktreeResult {
  // 1. sanitize the slug. An unsafe operand throws SlugError -> mapped to EXIT_USAGE
  // at the CLI edge (argv-level), so it is NOT caught here.
  const safeSlug = sanitizeFeatureSlug(slug);

  // 2. resolve parent + base; a non-repo cwd or a detached/no HEAD fails closed.
  const resolved = resolveParentAndBase(deps);
  if (resolved === undefined) return { exitCode: EXIT_WRONG_STATE };
  const { parent, base } = resolved;

  // 3. compute the (prefixed) worktree dir + the fixed branch.
  const wtPath = defaultFeatureWorktree(parent, `${DIR_PREFIX}${safeSlug}`);
  const branch = `${BRANCH_PREFIX}${safeSlug}`;

  // 4. confinement guard (engine-local): refuse a path that escapes the parent.
  try {
    assertUnderParent(wtPath, parent);
  } catch {
    return { exitCode: EXIT_WRONG_STATE };
  }

  // 5. collision/idempotency gate: an existing dir is VALIDATED, never assumed. A
  // clean match (our worktree on our branch) is reused without a second add; any
  // mismatch is refused with no mutation.
  if (deps.existsSync(wtPath)) {
    return validateExistingWorktree(deps, wtPath, branch);
  }

  // 6. create the engine-local worktree. A `--` separates options from the two
  // positional operands (`<path> <commit-ish>`) so an option-like `base` (e.g. a
  // config `base_branch` beginning with `-`) can never be misparsed as a git option
  // — `git worktree add`'s operands are NOT pathspecs, so `--literal-pathspecs`
  // would give them no protection; the `--` does (base is also rejected up front in
  // resolveParentAndBase). Any git error -> EXIT_FAILURE + a §2.4 machine error.
  try {
    runGit(deps, ['worktree', 'add', '-b', branch, '--', wtPath, base], 'worktree-add');
    return { exitCode: EXIT_OK, mode: 'dedicated', worktree: wtPath, branch };
  } catch (error) {
    if (error instanceof GitStepError) {
      return { exitCode: EXIT_FAILURE, machineError: machineErrorOf(error) };
    }
    throw error;
  }
}
