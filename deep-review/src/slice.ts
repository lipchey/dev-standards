// E3 + Phase 5 §5.1 — the atomic slice engine. This is the ONLY part of the
// deep-review engine that MUTATES a git repo, so every irreversible boundary is
// enforced DETERMINISTICALLY (never assumed): a mode gate, an eligibility gate, a
// path-safety gate, a no-touch gate, and a scope gate all run BEFORE any test spawn
// or git mutation, and every git call is fixed-argv `spawn` with `shell: false`
// (`git add`/`git commit` are ALWAYS scoped to explicit slice paths — `-A`/`.`
// never appear, and every path-bearing argv runs under `--literal-pathspecs`).
//
// Phase 5 moves the per-finding TEST RUN off the live run-worktree entirely: the
// slice is validated in a ONE-SHOT throwaway worktree (`git worktree add <tmp>
// HEAD` → replay the staged slice delta → run the finding's verify scope there →
// teardown ALWAYS in a `finally`). The live tree is never touched by the untrusted
// test, so there is no separate rollback mechanism to build:
//   - green (verify exit 0)      -> commit the staged slice in the run-worktree with
//                                   the trailer, status "fixed" (+ sha), and NULL out
//                                   any prior verification in the SAME findings write;
//   - red (verify clean non-zero) -> status "fix-failed"; nothing to roll back;
//   - operational (spawn fault / timeout / missing shim / harness setup failure)
//                                 -> status "infra-blocked" + infra_error, NEVER
//                                    "fix-failed" (an operational failure is not a
//                                    test verdict).
//
// At the very start commit-slice also RECONCILES: a slice commit whose trailer sits
// in the run's ancestry (`descriptor.initial_head_sha..HEAD`) but whose finding is
// not yet "fixed" (a crash between the commit and the findings write) is repaired to
// fixed+sha before any new work.
//
// Run identity (verifyDescriptor + findings binding) is enforced at the CLI edge
// BEFORE this runs; the verified descriptor + the run deadline + the reports
// confinement root arrive on `deps`. Effects (git/verify spawn + findings fs) live
// behind the injected seam so the engine logic is unit-testable.

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE, EXIT_DESCRIPTOR_MISMATCH } from './types.ts';
import type { FindingRecord, FindingsFileV2, MachineError } from './types.ts';
import { assertSafeRepoPath, FindingsValidationError, readFindings, mutateFindings } from './findings-io.ts';
import { isNoTouch } from './no-touch.ts';
import { runProcess } from '../../runner/src/exec.ts';
import type { RunProcessResult } from '../../runner/src/exec.ts';
import { realWorktreeDeps, setupWorktreeTooling, isWorktreeTooling } from './worktree.ts';
import type { DeepReviewContext, RunDescriptor } from './descriptor.ts';
import type { Deadline } from './deadline.ts';

// The git-commit trailer key (pinned so call sites read by name and never drift).
// The slice commit message's LAST line is exactly `Deep-Review-Slice: <id>`, the
// durable per-slice provenance record read by both the commit path and the
// reconciliation trailer-scan (an engine-local git-trailer convention).
export const SLICE_TRAILER_KEY = 'Deep-Review-Slice';

// Per git-spawn timeout cap (ms); the run deadline tightens it further per call.
const GIT_CAP_MS = 120_000;

// §F8 teardown budget (ms). Validation-worktree teardown gets its OWN FIXED budget, NOT
// the run deadline's remaining time: after a deadline timeout the run budget is spent, so
// a remainingMs-bounded teardown would be guaranteed to fail and leak the worktree.
const TEARDOWN_TIMEOUT_MS = 10_000;

// Bound the machine-readable stderr_tail / infra_error so a runaway stream cannot
// bloat the emitted JSON (the shared 2000-char trailer cap).
const STDERR_TAIL_MAX = 2000;

// ── Effects seam ───────────────────────────────────────────────────────────────

// The result of a fixed-argv git spawn. `status` is the process exit code, or null
// when the process failed to spawn / was killed.
interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The injected effects. `spawn` runs git ONLY (fixed argv, never a shell; `input`
// feeds a patch on stdin for `git apply`); `runProcess` runs the verify shim in the
// throwaway worktree (the W2 generic executor, so a spawn fault / timeout is a
// distinct `operational` verdict, never confused with a red test). `mutate` is the
// SOLE findings writer (the confinement root is bound on `reportsRootAbs`).
export interface SliceDeps {
  cwd: string;
  // The config-resolved verify shim path (default `verify`), spawned in the throwaway
  // validation worktree as `<tmp>/<entry>`.
  entry: string;
  // The verified run descriptor (identity gate ran at the CLI edge). null only if
  // the gate was bypassed — the engine then fails closed.
  descriptor: RunDescriptor | null;
  deadline: Deadline;
  reportsRootAbs: string;
  // The §2.5 no-touch set (BASELINE ∪ the repo's project-facts extensions). The
  // findings file is UNTRUSTED, so the engine re-enforces the no-touch floor here
  // rather than trusting the recorded classification/status.
  noTouchSet: readonly string[];
  spawn: (
    file: string,
    args: readonly string[],
    options: { cwd: string; input?: string; timeout?: number },
  ) => SpawnResult;
  runProcess: (input: { argv: string[]; cwd: string; timeoutMs: number }) => RunProcessResult;
  /* Consumer validation needs copied dist, shallow dependency mirrors, and .tools before verify;
     core-repo validation remains a no-op at this boundary. */
  setupTooling: (wtPath: string) => void;
  // A fresh, non-existent path for the throwaway validation worktree.
  tmpWorktreePath: () => string;
  readFindings: (path: string) => FindingsFileV2;
  // `expectedRevision` (F2 CAS) is the revision read at the START of the read-work-write
  // span; the sole mutator refuses (EXIT_FINDINGS_CONFLICT) if the file moved on under
  // the lock.
  mutate: (
    path: string,
    fn: (file: FindingsFileV2) => FindingsFileV2,
    expectedRevision?: number,
  ) => FindingsFileV2;
  // Non-fatal diagnostic sink (F8: a validation-worktree teardown that could not be
  // confirmed on the red path is warned, not folded into the verdict).
  warn: (message: string) => void;
}

// What `commitSlice` returns at the command edge: an exit code plus, on a git
// failure only, the §2.4 machine-readable error the CLI prints as the last stderr
// line. `machineError` is OMITTED (never undefined) under exactOptionalPropertyTypes.
export interface SliceResult {
  exitCode: number;
  machineError?: MachineError;
}

// The real default git spawn: fixed argv, `shell: false`, timeout-bounded, `input`
// piped when present. A spawn-level failure / timeout maps to `status: null`.
const defaultSpawn: SliceDeps['spawn'] = (file, args, options) => {
  const r = spawnSync(file, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout,
    ...(options.input === undefined ? {} : { input: options.input }),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) {
    return { status: null, stdout: '', stderr: r.error instanceof Error ? r.error.message : String(r.error) };
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// A fresh throwaway worktree path under the OS temp dir. `git worktree add` creates
// the leaf, so the path must NOT already exist (uuid-suffixed) while its parent does.
function defaultTmpWorktreePath(): string {
  return path.join(os.tmpdir(), `deep-review-validate-${crypto.randomUUID()}`);
}

// The production deps: git + verify spawn at the real edge, findings through the
// validating findings-io boundary. `ctx` carries the verified descriptor, the run
// deadline, and the reports confinement root.
export function realSliceDeps(cwd: string, ctx: DeepReviewContext, noTouchSet: readonly string[] = []): SliceDeps {
  return {
    cwd,
    entry: ctx.verifyEntry,
    descriptor: ctx.descriptor,
    deadline: ctx.deadline,
    reportsRootAbs: ctx.reportsRootAbs,
    noTouchSet,
    spawn: defaultSpawn,
    runProcess,
    setupTooling: (wtPath) => setupWorktreeTooling({ ...realWorktreeDeps(cwd), deadline: ctx.deadline }, wtPath),
    tmpWorktreePath: defaultTmpWorktreePath,
    readFindings: (p) => readFindings(p),
    mutate: (p, fn, expectedRevision) =>
      mutateFindings(p, { reportsRootAbs: ctx.reportsRootAbs }, fn, undefined, expectedRevision),
    warn: (message) => process.stderr.write(`${message}\n`),
  };
}

// ── Git edge (fixed argv, shell:false, deadline-bounded) ─────────────────────────

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// The per-call git timeout: the fixed cap, tightened to the deadline's remaining
// budget. Floored at 1ms so an exhausted budget yields an immediate timeout
// (spawnSync treats 0 as "no timeout").
function spawnTimeout(deadline: Deadline): number {
  return Math.max(1, Math.min(GIT_CAP_MS, deadline.remainingMs()));
}

// A failing git step. Carries the §2.4 MachineError fields (`command` — the git
// argv, never a shell string — `stderr_tail`, `step`). `kind` is a cross-realm tag
// (a bundled copy can defeat `instanceof`), mirroring the sibling GitStepError idiom.
class GitStepError extends Error {
  readonly kind = 'slice-git-error' as const;
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

// Runs one git command through the spawn seam in `cwd`; returns stdout, or throws a
// GitStepError (naming `step`) on a non-zero/failed-to-spawn result. The argv is
// passed verbatim (paths come after `--`); no shell, ever.
function runGit(deps: SliceDeps, args: string[], step: string, cwd: string, input?: string): string {
  const command = `git ${args.join(' ')}`;
  const result = deps.spawn('git', args, {
    cwd,
    timeout: spawnTimeout(deps.deadline),
    ...(input === undefined ? {} : { input }),
  });
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

// ── Pure helpers ───────────────────────────────────────────────────────────────

// Parses `git status --porcelain -z --no-renames --untracked-files=all` into the
// EXACT set of dirty repo-relative paths. With `-z` each record is `XY <path>`
// NUL-terminated (no quoting), and `--no-renames` reports a rename as a delete +
// an untracked add — two ordinary records — so there is never an extra
// NUL-separated original-path field to misalign on. `--untracked-files=all` lists
// every untracked file INDIVIDUALLY (a file in a brand-new directory shows as
// `dir/file`, never the collapsing `dir/` entry), so the scope gate compares real
// file paths against the slice and a new-dir slice file is not false-refused.
interface DirtyPath {
  path: string;
  untracked: boolean;
}

function parseDirtyPaths(out: string): DirtyPath[] {
  const paths: DirtyPath[] = [];
  const NUL = String.fromCharCode(0);
  for (const record of out.split(NUL)) {
    if (record === '') continue;
    const untracked = record.slice(0, 2) === '??'; /* the 2 status chars; `??` == untracked */
    const p = record.slice(3); // skip the 2 status chars + the separating space
    if (p !== '') paths.push({ path: p, untracked });
  }
  return paths;
}

// §F6/G3 restores the INDEX for exactly the slice paths to the pre-`add` snapshot, WITHOUT
// touching the working tree, so a red/operational/git-error refusal never leaves the slice
// staged (which would clobber a user's partial staging). Best-effort: a restore hiccup must
// not flip a red verdict into a git error (the e2e proves it actually works). `snapshotZ` is
// `git ls-files -s -z -- <slice>` captured BEFORE the stage.
//
// `git add` collapses an unmerged (UU) file's stages 1/2/3 into a single stage-0 entry;
// replaying the snapshot's stage-1/2/3 records over that stage-0 entry FAILS unless the
// stage-0 entry is removed first. So the restore stream PREPENDS a mode-0 removal record for
// EVERY slice path (clears the post-add stage-0 entry), THEN the snapshot records re-add the
// original stage(s) — all in ONE --index-info call. A new file (no snapshot record) is left
// simply removed from the index → back to untracked in the working tree, so the removal record
// subsumes the previous separate --force-remove.
function restoreIndexSafe(deps: SliceDeps, slice: readonly string[], snapshotZ: string): void {
  try {
    const NUL = String.fromCharCode(0);
    const ZERO_SHA = '0'.repeat(40);
    const removals = slice.map((p) => `0 ${ZERO_SHA}\t${p}${NUL}`).join('');
    const stream = removals + snapshotZ;
    if (stream.length > 0) {
      runGit(deps, ['update-index', '-z', '--index-info'], 'restore-index', deps.cwd, stream);
    }
  } catch {
    /* best-effort index restore; a leaked staged blob is recoverable and never blocks the verdict */
  }
}

// The slice commit message: a deterministic subject derived ONLY from the validated
// finding id (a slug, so no newline can break the layout), with the trailer as the
// exact LAST line (the reconciliation scan reads it back by key).
function buildSliceMessage(finding: FindingRecord): string {
  const subject = `deep-review: apply fixable-now slice ${finding.id}`;
  return `${subject}\n\n${SLICE_TRAILER_KEY}: ${finding.id}`;
}

// ── Findings status transitions (immutable; drop stale infra_error) ─────────────

function replaceFinding(
  file: FindingsFileV2,
  id: string,
  fn: (finding: FindingRecord) => FindingRecord,
): FindingsFileV2 {
  return { ...file, findings: file.findings.map((f) => (f.id === id ? fn(f) : f)) };
}

function toFixed(finding: FindingRecord, sha: string): FindingRecord {
  const { infra_error: _dropped, ...rest } = finding;
  return { ...rest, status: 'fixed', sha };
}

function toFixFailed(finding: FindingRecord): FindingRecord {
  const { infra_error: _dropped, ...rest } = finding;
  return { ...rest, status: 'fix-failed', sha: '' };
}

function toInvalid(finding: FindingRecord): FindingRecord {
  const { infra_error: _dropped, ...rest } = finding;
  return { ...rest, status: 'invalid', sha: '' };
}

function toInfraBlocked(finding: FindingRecord, reason: string): FindingRecord {
  return { ...finding, status: 'infra-blocked', sha: '', infra_error: tailOf(reason) };
}

// ── Reconciliation (§W4.3) ──────────────────────────────────────────────────────

// Scans the slice trailers in the run's OWN ancestry (`initial_head..HEAD`, NOT the
// whole graph — a foreign branch's trailer is out of range and ignored), mapping
// each recorded slice id to its commit SHA. `git log -z` NUL-terminates each log
// entry; the format packs `<sha><US><trailer-value>` per entry (US = 0x1F).
function scanSliceTrailers(deps: SliceDeps, initialHead: string): Map<string, string> {
  const US = String.fromCharCode(0x1f);
  const NUL = String.fromCharCode(0);
  const out = runGit(
    deps,
    ['log', '-z', `--format=%H%x1f%(trailers:key=${SLICE_TRAILER_KEY},valueonly=true)`, `${initialHead}..HEAD`],
    'reconcile',
    deps.cwd,
  );
  const map = new Map<string, string>();
  for (const record of out.split(NUL)) {
    if (record === '') continue;
    const sep = record.indexOf(US);
    if (sep === -1) continue;
    const sha = record.slice(0, sep);
    const id = record.slice(sep + 1).trim();
    // Newest-first: git log lists tip-first, so the first SHA seen for an id wins.
    if (id !== '' && !map.has(id)) map.set(id, sha);
  }
  return map;
}

// Repairs any finding whose slice commit already landed (its trailer is in ancestry)
// but whose status was never written to "fixed" — the crash-between-commit-and-write
// window. Only writes when there is something to repair (no gratuitous revision bump).
function reconcile(deps: SliceDeps, findingsPath: string): void {
  if (deps.descriptor === null) return;
  const trailerMap = scanSliceTrailers(deps, deps.descriptor.initial_head_sha);
  if (trailerMap.size === 0) return;
  const current = deps.readFindings(findingsPath);
  const stale = current.findings.some((f) => trailerMap.has(f.id) && f.status !== 'fixed');
  if (!stale) return;
  deps.mutate(findingsPath, (file) => ({
    ...file,
    findings: file.findings.map((f) => {
      const sha = trailerMap.get(f.id);
      return sha !== undefined && f.status !== 'fixed' ? toFixed(f, sha) : f;
    }),
  }));
}

// ── The one-shot validation worktree ────────────────────────────────────────────

type Verdict =
  | { kind: 'green' }
  | { kind: 'red' }
  | { kind: 'operational'; reason: string };

// Tears down the throwaway validation worktree under an INDEPENDENT fixed budget (§F8).
// Returns undefined on success, or a short failure reason (never throws) so a teardown
// hiccup cannot flip a red/operational verdict into a git error.
function teardownWorktree(deps: SliceDeps, tmp: string): string | undefined {
  try {
    const result = deps.spawn('git', ['worktree', 'remove', '--force', '--', tmp], {
      cwd: deps.cwd,
      timeout: TEARDOWN_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      return tailOf(result.stderr) || `git worktree remove exited with status ${result.status}`;
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Applies the staged slice delta onto the throwaway worktree's index + working tree.
// An empty delta is a no-op (git apply errors on empty input, so short-circuit).
function applyDelta(deps: SliceDeps, tmp: string, delta: string): void {
  if (delta.trim() === '') return;
  const result = deps.spawn('git', ['apply', '--index'], {
    cwd: tmp,
    input: delta,
    timeout: spawnTimeout(deps.deadline),
  });
  if (result.status !== 0) {
    throw new GitStepError('validate-apply', 'git apply --index', tailOf(result.stderr), `git apply --index failed (status ${result.status})`);
  }
}

function harnessReason(error: unknown): string {
  if (error instanceof GitStepError) return `${error.step}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

// Runs the finding's verify scope against HEAD+slice in a throwaway worktree, tearing
// it down ALWAYS (finally) even when setup throws. ANY harness setup failure
// (worktree add / apply / tooling) is `operational` (the fix could not be verified),
// never a red-test verdict. A runProcess `operational` (spawn fault / timeout /
// missing shim / exhausted budget) is likewise operational.
function runValidation(deps: SliceDeps, delta: string, scope: '--fast' | '--full'): Verdict {
  const tmp = deps.tmpWorktreePath();
  let created = false;
  let verdict: Verdict = { kind: 'operational', reason: 'validation did not complete' };
  let teardownError: string | undefined;
  try {
    runGit(deps, ['worktree', 'add', '--', tmp, 'HEAD'], 'validate-add', deps.cwd);
    created = true;
    applyDelta(deps, tmp, delta);
    deps.setupTooling(tmp);
    const result = deps.runProcess({
      argv: [path.join(tmp, deps.entry), scope],
      cwd: tmp,
      timeoutMs: deps.deadline.remainingMs(),
    });
    verdict =
      result.kind === 'ok'
        ? { kind: 'green' }
        : result.kind === 'red'
          ? { kind: 'red' }
          : { kind: 'operational', reason: result.stderrTail || 'verify did not produce a verdict' };
  } catch (error) {
    verdict = { kind: 'operational', reason: harnessReason(error) };
  } finally {
    // §F8 teardown under its own fixed budget; a leaked worktree is prunable and never
    // blocks the verdict.
    if (created) teardownError = teardownWorktree(deps, tmp);
  }

  // §F8/G6 surface an unconfirmed teardown: fold it into the operational reason (so it lands
  // in infra_error), else WARN — on the red AND the green path (G6: a leaked validation
  // worktree must not pass silently on green either). The verdict / commit is never changed.
  if (teardownError !== undefined) {
    if (verdict.kind === 'operational') {
      verdict = { kind: 'operational', reason: `${verdict.reason}; validation worktree teardown failed: ${teardownError}` };
    } else {
      deps.warn(`deep-review: validation worktree teardown failed: ${teardownError}`);
    }
  }
  return verdict;
}

// ── The engine ─────────────────────────────────────────────────────────────────

export function commitSlice(findingId: string, findingsPath: string, deps: SliceDeps): SliceResult {
  // Run identity is verified at the CLI edge BEFORE this runs; a null descriptor
  // means the gate was bypassed -> fail closed with no mutation.
  if (deps.descriptor === null) return { exitCode: EXIT_DESCRIPTOR_MISMATCH };

  // §F6 index snapshot for the slice paths, captured BEFORE staging so a non-green
  // outcome can restore the index without touching the working tree. `undefined` until
  // the stage runs, so the catch never restores over an error that predates it.
  let indexSnapshot: string | undefined;
  let stagedSlice: readonly string[] = [];

  try {
    // Reconciliation FIRST: a slice commit already in the run's ancestry whose
    // finding was never written to "fixed" (a crash between commit and write) is
    // repaired to fixed+sha before any new work.
    reconcile(deps, findingsPath);

    // Step 1 — load + validate; mode gate; locate; eligibility gate. ALL before any
    // spawn or repo mutation.
    const findings = deps.readFindings(findingsPath);
    // §F2 the revision to guard the final status write against: the read-work-write span
    // (stage + throwaway-worktree validation) is where a concurrent classify/slice could
    // race, so the closing mutate CAS-checks this baseline.
    const baseRevision = findings.revision;
    if (findings.mode !== 'review-and-refactor') return { exitCode: EXIT_WRONG_STATE };
    const finding = findings.findings.find((f) => f.id === findingId);
    if (finding === undefined) return { exitCode: EXIT_WRONG_STATE };
    if (finding.classification !== 'fixable-now' || finding.status !== 'pending') {
      return { exitCode: EXIT_WRONG_STATE };
    }

    // Step 2 — path-safety gate (defense in depth: findings-io already downgrades an
    // unsafe path to `invalid`, which the eligibility gate above would refuse). Any
    // path that could reach a git argv is checked BEFORE git runs.
    const slice = finding.slice_files;
    try {
      assertSafeRepoPath(finding.file);
      for (const p of slice) assertSafeRepoPath(p);
    } catch (error) {
      if (error instanceof FindingsValidationError && error.rule === 'path-unsafe') {
        deps.mutate(findingsPath, (file) => replaceFinding(file, findingId, toInvalid));
        return { exitCode: EXIT_WRONG_STATE };
      }
      throw error;
    }

    // No-touch gate. The findings file is UNTRUSTED: refuse if finding.file OR ANY
    // slice path is no-touch, with NO git and NO findings write. This is the
    // ENFORCEMENT the classifier's routing only mirrors.
    if (isNoTouch(finding.file, deps.noTouchSet) || slice.some((p) => isNoTouch(p, deps.noTouchSet))) {
      return { exitCode: EXIT_WRONG_STATE };
    }

    const scope = finding.test_ref === 'verify:full' ? '--full' : '--fast';
    const sliceSet = new Set(slice);

    /*
     * Step 3 — deterministic scope gate. The live worktree's dirty set (staged + unstaged) MUST be
     * a subset of the slice; any out-of-slice dirt means the change is not isolated, so refuse with
     * NO test run and NO mutation. The engine's own worktree-tooling footprint is excluded
     * (isWorktreeTooling): the .tools symlink + the wired submodule always, and a node_modules path
     * ONLY when git reports it UNTRACKED — mirror content is always untracked, whereas a TRACKED
     * node_modules edit is real user work and must still refuse. The scoped stage/commit below can
     * never sweep the exempted footprint in.
     */
    const dirty = parseDirtyPaths(
      runGit(deps, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'], 'status', deps.cwd),
    );
    for (const { path: p, untracked } of dirty) {
      if (!sliceSet.has(p) && !isWorktreeTooling(p, untracked)) return { exitCode: EXIT_WRONG_STATE };
    }

    // Step 4 — snapshot the slice index (§F6), then stage EXACTLY the slice (never
    // -A/.), so the delta transferred to the validation worktree is precisely the slice.
    // Capture that staged delta (`--binary` base85-armors any binary content, so utf8
    // capture round-trips). The scope gate above already proved nothing out-of-slice is
    // dirty, and the green commit is itself scoped to the slice, so the committed tree
    // can only ever contain the slice.
    indexSnapshot = runGit(deps, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...slice], 'ls-files', deps.cwd);
    stagedSlice = slice;
    runGit(deps, ['--literal-pathspecs', 'add', '--', ...slice], 'add', deps.cwd);
    // Scope the captured delta to the slice paths (not a bare `diff --cached`): the scope
    // gate now EXEMPTS the engine's own tooling footprint, so a staged tooling entry could
    // otherwise leak into the validation delta while the path-scoped commit below excludes
    // it — validating a tree the commit never produces. `-- <slice>` keeps the delta ==
    // the slice, matching the scoped add/commit.
    const delta = runGit(deps, ['--literal-pathspecs', 'diff', '--cached', '--binary', '--', ...slice], 'diff', deps.cwd);

    // Step 5 — validate the slice in a ONE-SHOT worktree (the live tree is never
    // touched by the untrusted test); teardown is guaranteed in runValidation.
    const verdict = runValidation(deps, delta, scope);

    if (verdict.kind === 'operational') {
      // An operational failure is NOT a red test: infra-blocked + infra_error, never
      // fix-failed. §F6: restore the slice index so a user's partial staging survives.
      restoreIndexSafe(deps, slice, indexSnapshot);
      deps.mutate(
        findingsPath,
        (file) => replaceFinding(file, findingId, (f) => toInfraBlocked(f, verdict.reason)),
        baseRevision,
      );
      return { exitCode: EXIT_OK };
    }
    if (verdict.kind === 'red') {
      // A genuine red test -> fix-failed. §F6: restore the slice index (the test ran in
      // the throwaway worktree; the live index is put back exactly as the human left it).
      restoreIndexSafe(deps, slice, indexSnapshot);
      deps.mutate(findingsPath, (file) => replaceFinding(file, findingId, toFixFailed), baseRevision);
      return { exitCode: EXIT_OK };
    }

    // Step 6 — GREEN. Commit the staged slice SCOPED to the slice paths (the tree can
    // contain ONLY the slice), record fixed+sha, and NULL any prior verification in
    // the SAME write (this new commit moved HEAD past it).
    runGit(deps, ['--literal-pathspecs', 'commit', '-m', buildSliceMessage(finding), '--', ...slice], 'commit', deps.cwd);
    const sha = runGit(deps, ['rev-parse', 'HEAD'], 'rev-parse', deps.cwd).trim();
    deps.mutate(
      findingsPath,
      (file) => ({
        ...replaceFinding(file, findingId, (f) => toFixed(f, sha)),
        verification: null,
      }),
      baseRevision,
    );
    return { exitCode: EXIT_OK };
  } catch (error) {
    // Any git error becomes EXIT_FAILURE + a §2.4 MachineError naming the failing
    // step. Findings are NOT written on a git-error outcome. §F6: if we had staged the
    // slice before the failure, restore the index so the error does not leave it staged.
    if (indexSnapshot !== undefined) restoreIndexSafe(deps, stagedSlice, indexSnapshot);
    if (error instanceof GitStepError) {
      return { exitCode: EXIT_FAILURE, machineError: machineErrorOf(error) };
    }
    throw error;
  }
}
