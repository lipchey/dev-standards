// E3 — the atomic slice engine. This is the ONLY part of the deep-review engine
// that MUTATES a git repo, so every irreversible boundary is enforced
// DETERMINISTICALLY (never assumed): a mode gate, an eligibility gate, a path-
// safety gate, and a scope gate all run BEFORE any test spawn or git mutation,
// and every git call is fixed-argv `spawnSync` with `shell: false` (no string is
// ever interpolated into a shell, and `git add` is ALWAYS scoped to explicit
// slice paths — `git add -A`/`.` never appear).
//
// `commitSlice` implements the §2.4 contract in seven ordered steps:
//   1. load + validate findings; mode gate; locate finding; eligibility gate.
//   2. path-safety gate (per-finding "invalid") + test_cmd fail-closed re-check.
//   3. deterministic scope gate (the worktree's dirty set MUST be a subset of the
//      slice).
//   4. spawn the finding's test_cmd (fixed argv, shell:false).
//   5. GREEN (test exit 0): `git add -- <slice>` then a commit whose LAST line is
//      the trailer `Deep-Review-Slice: <id>`; status "fixed", sha = new HEAD.
//   6. RED (test non-zero): `git checkout HEAD -- <slice>` (revert only the
//      slice), status "fix-failed", NO commit.
//   7. any git error -> EXIT_FAILURE carrying a §2.4 MachineError naming the
//      failing step.
//
// Effects (git/test spawn + findings fs) live behind an injected `deps` seam so
// the engine logic is unit-testable; the real defaults run git in the worktree
// and read/write findings through the validating findings-io boundary.

import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from './types.ts';
import type { FindingRecord, FindingsFile, MachineError } from './types.ts';
import { assertSafeRepoPath, FindingsValidationError, readFindings, writeFindings } from './findings-io.ts';
import { isNoTouch } from './no-touch.ts';

// The git-commit trailer key (pinned so call sites read by name and never drift).
// The slice commit message's LAST line is exactly `Deep-Review-Slice: <id>`, the
// durable per-slice provenance record (mirrors workflow's Workflow-Phase trailer).
export const SLICE_TRAILER_KEY = 'Deep-Review-Slice';

// Bound the machine-readable stderr_tail so a runaway stderr cannot bloat the
// emitted JSON line (matches workflow/src/trailers.ts STDERR_TAIL_MAX).
const STDERR_TAIL_MAX = 2000;

// True if the string carries any C0 control char (0x00-0x1F) or DEL (0x7F). Used
// to reject a test_cmd argv that could smuggle a terminator. Written as a codepoint
// scan (not a regex literal) so no control byte ever appears in this source.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// ── Effects seam ───────────────────────────────────────────────────────────────

// The result of a fixed-argv spawn. `status` is the process exit code, or null
// when the process failed to spawn (treated as a non-green result, never as 0).
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The injected effects. `spawn` runs BOTH git and the finding's test_cmd (fixed
// argv, never a shell); `cwd` is the worktree root; findings read/write go
// through the validating findings-io boundary by default.
export interface SliceDeps {
  cwd: string;
  // The §2.5 no-touch set (BASELINE ∪ the repo's project-facts extensions). The
  // findings file is UNTRUSTED, so the engine re-enforces the no-touch floor here
  // rather than trusting the recorded classification/status: a slice may name a
  // no-touch path even when finding.file is editable. The CLI builds this with the
  // SAME wiring as check-path/classify.
  noTouchSet: readonly string[];
  spawn: (file: string, args: readonly string[], options: { cwd: string }) => SpawnResult;
  readFindings: (path: string) => FindingsFile;
  writeFindings: (path: string, file: FindingsFile) => void;
}

// What `commitSlice` returns at the command edge: an exit code plus, on a git
// failure only, the §2.4 machine-readable error the CLI prints as the last
// stderr line. `machineError` is OMITTED (never undefined) under
// exactOptionalPropertyTypes when there is no error.
export interface SliceResult {
  exitCode: number;
  machineError?: MachineError;
}

// The real default spawn: fixed argv, `shell: false`, never a shell string. A
// spawn-level failure (binary missing, cwd gone) maps to `status: null` so the
// caller treats it as a non-green result rather than confusing it with exit 0.
const defaultSpawn: SliceDeps['spawn'] = (file, args, options) => {
  const r = spawnSync(file, args, {
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

// The production deps: git + test spawn at the real edge, findings through the
// validating findings-io boundary. `cwd` is the worktree the slice lives in.
export function realSliceDeps(cwd: string, noTouchSet: readonly string[] = []): SliceDeps {
  return {
    cwd,
    noTouchSet,
    spawn: defaultSpawn,
    readFindings: (path) => readFindings(path),
    writeFindings: (path, file) => {
      writeFindings(path, file);
    },
  };
}

// ── Git edge (fixed argv, shell:false) ─────────────────────────────────────────

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// A failing git step. Carries the §2.4 MachineError fields (`command` — the git
// argv, never a shell string — `stderr_tail`, `step`). `kind` is a cross-realm
// tag (a bundled copy can defeat `instanceof`), mirroring workflow's GitError.
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

// Runs one git command through the spawn seam; returns stdout, or throws a
// GitStepError (naming `step`) on a non-zero/failed-to-spawn result. The argv is
// passed verbatim (paths come after `--`); no shell, ever.
function runGit(deps: SliceDeps, args: string[], step: string): string {
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

// True iff `relPath` is tracked in HEAD (so `git checkout HEAD -- <path>` can
// restore it). Implemented via `git cat-file -e HEAD:<path>`, whose exit code is 0
// when a blob exists at that tree path and non-zero otherwise. Run through the
// spawn seam DIRECTLY (not runGit) because a non-zero exit is the expected ANSWER
// ("not in HEAD"), not a git error to surface.
function existsInHead(deps: SliceDeps, relPath: string): boolean {
  return deps.spawn('git', ['cat-file', '-e', `HEAD:${relPath}`], { cwd: deps.cwd }).status === 0;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

// Fail-closed re-validation of a test_cmd: a NON-EMPTY array of NON-EMPTY
// control-free strings. findings-io already enforces this, but the engine never
// spawns a malformed argv — defense in depth against an unvalidated injection.
function isValidTestCmd(cmd: readonly string[]): boolean {
  return (
    Array.isArray(cmd) &&
    cmd.length > 0 &&
    cmd.every((arg) => typeof arg === 'string' && arg.length > 0 && !hasControlChar(arg))
  );
}

// Parses `git status --porcelain -z --no-renames --untracked-files=all` into the
// EXACT set of dirty repo-relative paths. With `-z` each record is `XY <path>`
// NUL-terminated (no quoting), and `--no-renames` reports a rename as a delete +
// an untracked add — two ordinary records — so there is never an extra
// NUL-separated original-path field to misalign on. `--untracked-files=all` lists
// every untracked file INDIVIDUALLY (a file in a brand-new directory shows as
// `dir/file`, never the collapsing `dir/` entry), so the scope gate compares real
// file paths against the slice and a new-dir slice file is not false-refused.
function parseDirtyPaths(out: string): string[] {
  const paths: string[] = [];
  const NUL = String.fromCharCode(0);
  for (const record of out.split(NUL)) {
    if (record === '') continue;
    const p = record.slice(3); // skip the 2 status chars + the separating space
    if (p !== '') paths.push(p);
  }
  return paths;
}

// Parses `git diff --cached --name-only -z` into the EXACT set of STAGED
// repo-relative paths. Unlike `git status --porcelain`, this output carries NO
// 2-char status prefix — each record is the bare path, NUL-terminated (no
// quoting under `-z`) — so the whole record IS the path. Used by the post-test
// re-gate to inspect what an untrusted test_cmd may have added to the index.
function parseStagedPaths(out: string): string[] {
  const paths: string[] = [];
  const NUL = String.fromCharCode(0);
  for (const record of out.split(NUL)) {
    if (record !== '') paths.push(record);
  }
  return paths;
}

// The slice commit message: a deterministic subject derived ONLY from the
// validated finding id (a slug, so no newline can break the layout), with the
// trailer as the exact LAST line.
function buildSliceMessage(finding: FindingRecord): string {
  const subject = `deep-review: apply fixable-now slice ${finding.id}`;
  return `${subject}\n\n${SLICE_TRAILER_KEY}: ${finding.id}`;
}

// ── The engine ─────────────────────────────────────────────────────────────────

export function commitSlice(findingId: string, findingsPath: string, deps: SliceDeps): SliceResult {
  // Step 1 — load + validate; mode gate; locate; eligibility gate. ALL of this
  // runs BEFORE any spawn or git: a wrong-mode, missing, or ineligible finding is
  // refused with no side effect on the repo.
  const findings = deps.readFindings(findingsPath);
  if (findings.mode !== 'review-and-refactor') return { exitCode: EXIT_WRONG_STATE };
  const finding = findings.findings.find((f) => f.id === findingId);
  if (finding === undefined) return { exitCode: EXIT_WRONG_STATE };
  if (finding.classification !== 'fixable-now' || finding.status !== 'pending') {
    return { exitCode: EXIT_WRONG_STATE };
  }

  // Step 2 — path-safety gate. Every path that could reach a git argv is checked
  // BEFORE git runs. On an unsafe path the finding is marked "invalid", persisted,
  // and refused with no git touched. (findings-io already downgrades unsafe-path
  // findings to "invalid" on read — which the eligibility gate above also catches
  // — so this is fail-closed defense in depth that re-asserts the invariant at the
  // last moment before a path is handed to git.)
  const slice = finding.slice_files;
  try {
    assertSafeRepoPath(finding.file);
    for (const p of slice) assertSafeRepoPath(p);
  } catch (error) {
    if (error instanceof FindingsValidationError && error.rule === 'path-unsafe') {
      finding.status = 'invalid';
      deps.writeFindings(findingsPath, findings);
      return { exitCode: EXIT_WRONG_STATE };
    }
    throw error;
  }

  // No-touch gate. The findings file is UNTRUSTED, so the recorded
  // classification/status cannot be trusted and slice_files may name a no-touch
  // path even when finding.file is editable. Re-enforce the §2.5 floor at the last
  // moment before any git: if finding.file OR ANY slice path is no-touch, refuse
  // with NO git and NO findings write. This is the ENFORCEMENT the classifier's
  // routing only mirrors.
  if (
    isNoTouch(finding.file, deps.noTouchSet) ||
    slice.some((p) => isNoTouch(p, deps.noTouchSet))
  ) {
    return { exitCode: EXIT_WRONG_STATE };
  }

  // test_cmd fail-closed re-check: never spawn a malformed argv (status unchanged,
  // no git, no write).
  if (!isValidTestCmd(finding.test_cmd)) return { exitCode: EXIT_WRONG_STATE };

  const sliceSet = new Set(slice);
  try {
    // Step 3 — deterministic scope gate. The worktree's dirty set MUST be a subset
    // of the slice; any dirty path outside the slice means the change is not
    // isolated, so we refuse with NO test run and NO git mutation. This replaces
    // AI discipline with enforcement.
    const dirty = parseDirtyPaths(
      runGit(deps, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'], 'status'),
    );
    for (const p of dirty) {
      if (!sliceSet.has(p)) return { exitCode: EXIT_WRONG_STATE };
    }

    // Step 4 — run the finding's verification command (fixed argv, shell:false) in
    // the worktree. A non-zero OR failed-to-spawn (null) status is NOT green.
    const cmdFile = finding.test_cmd[0];
    if (cmdFile === undefined) return { exitCode: EXIT_WRONG_STATE };
    const test = deps.spawn(cmdFile, finding.test_cmd.slice(1), { cwd: deps.cwd });

    // Step 4.5 — post-test STAGED-index re-gate. test_cmd is UNTRUSTED and runs
    // with full worktree/index write access, so it can stage paths AFTER the
    // pre-test scope gate (step 3) ran. Because `git commit` (no pathspec) commits
    // the WHOLE index, a test_cmd that does `git add <out-of-slice|no-touch>` could
    // otherwise smuggle that path into the slice commit. So BEFORE branching on the
    // test result, re-read the STAGED index and refuse (EXIT_WRONG_STATE, NO commit,
    // NO fix-failed record — surface it) if ANY staged path is outside the slice OR
    // is no-touch. The STAGED index specifically (not the worktree) is checked so a
    // legitimate test_cmd that writes transient UNSTAGED artifacts (coverage, logs)
    // outside the slice is tolerated; only staged out-of-slice/no-touch changes are
    // refused. The diff command takes no path operands, so no --literal-pathspecs is
    // needed here. `--no-renames` is REQUIRED: with rename detection on (the git
    // default `diff.renames=true`), a test_cmd that renames a no-touch file INTO a
    // slice path (`git mv .github/workflows/x src/x && git add -A`) would surface as a
    // single rename naming only the in-slice destination, HIDING the staged no-touch
    // deletion — so the gate must see the delete+add pair (mirrors the pre-test scope
    // gate at step 3, which also passes --no-renames). This runs on BOTH the green and
    // red branches: a smuggled stage is refused regardless of the test's exit code.
    const staged = parseStagedPaths(
      runGit(deps, ['diff', '--cached', '--name-only', '-z', '--no-renames'], 'status'),
    );
    // The `!sliceSet.has(p)` disjunct is the live guard here (a test_cmd that stages
    // an OUT-OF-SLICE path — including a no-touch one — is refused). The
    // `isNoTouch(p)` disjunct is intentional belt-and-suspenders: any IN-slice
    // no-touch path is already refused by the eligibility/no-touch gate above (step
    // 2) before any spawn, so it cannot be the SOLE refusal cause today; it is kept
    // so this gate stays correct even if a future change let an in-slice no-touch
    // path reach the staged index post-test.
    for (const p of staged) {
      if (!sliceSet.has(p) || isNoTouch(p, deps.noTouchSet)) {
        return { exitCode: EXIT_WRONG_STATE };
      }
    }

    if (test.status === 0) {
      // Step 5 — GREEN. Stage EXACTLY the slice paths (never `-A`/`.`), then commit
      // SCOPED to those same paths so the recorded tree can contain ONLY the slice
      // even if something slipped into the index — belt-and-suspenders behind the
      // step-4.5 gate. The commit message's last line is the trailer; the resulting
      // sha is recorded. `--literal-pathspecs` forbids git from interpreting any
      // magic/glob in a path operand even if one slipped past assertSafeRepoPath.
      runGit(deps, ['--literal-pathspecs', 'add', '--', ...slice], 'add');
      runGit(deps, ['--literal-pathspecs', 'commit', '-m', buildSliceMessage(finding), '--', ...slice], 'commit');
      finding.sha = runGit(deps, ['rev-parse', 'HEAD'], 'rev-parse').trim();
      finding.status = 'fixed';
      deps.writeFindings(findingsPath, findings);
      return { exitCode: EXIT_OK };
    }

    // Step 6 — RED. Revert ONLY the slice paths, handling each by tracked-ness so a
    // newly-CREATED slice file is never left on disk: a path tracked-in-HEAD is
    // restored with `git checkout HEAD -- <paths>`; a path NOT in HEAD (created by
    // the attempted fix, never `git add`ed on the red path so still unstaged) cannot
    // be reverted by checkout — its pathspec is not in HEAD and would abort the whole
    // checkout — so it is REMOVED from the worktree with `git clean -f`. Never carry a
    // broken slice forward, never commit. Membership is tested per path via cat-file.
    const trackedInHead: string[] = [];
    const untracked: string[] = [];
    for (const p of slice) {
      if (existsInHead(deps, p)) trackedInHead.push(p);
      else untracked.push(p);
    }
    if (trackedInHead.length > 0) {
      runGit(deps, ['--literal-pathspecs', 'checkout', 'HEAD', '--', ...trackedInHead], 'checkout');
    }
    if (untracked.length > 0) {
      runGit(deps, ['--literal-pathspecs', 'clean', '-f', '--', ...untracked], 'clean');
    }
    // Assert the revert left NO slice path dirty. A residual dirty slice path means
    // the broken change was not fully undone, so surface it as a git error rather
    // than falsely recording a clean fix-failed.
    const residual = parseDirtyPaths(
      runGit(deps, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'], 'status'),
    );
    for (const p of residual) {
      if (sliceSet.has(p)) {
        throw new GitStepError('revert', 'git revert (slice)', '', `slice path "${p}" still dirty after revert`);
      }
    }
    finding.status = 'fix-failed';
    deps.writeFindings(findingsPath, findings);
    return { exitCode: EXIT_OK };
  } catch (error) {
    // Step 7 — any git error becomes EXIT_FAILURE + a §2.4 MachineError naming the
    // failing step. Findings are NOT written on an error outcome.
    if (error instanceof GitStepError) {
      return { exitCode: EXIT_FAILURE, machineError: machineErrorOf(error) };
    }
    throw error;
  }
}
