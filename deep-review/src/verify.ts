// E7 + Phase 5 §5.2 — the final verify gate. After all fix slices are committed and
// BEFORE the ADR-012 handoff, the deep-review runtime runs the run-worktree's verify
// shim ONCE. A GREEN run (exit 0) records the verification stamp and clears the
// refactor to proceed to handoff; a RED run (any non-zero exit) means verify found
// problems, so the whole refactor is `needs-human` (EXIT_NEEDS_HUMAN = 13) and
// NOTHING lands; a missing / non-executable shim (a failed spawn / null status) is a
// TOOL failure, not a verify verdict, so it fails closed with EXIT_FAILURE + a §2.4
// MachineError naming step "verify".
//
// The shim spawn is the SAME §2 contract as before: FIXED ARGV (`[scope]`, scope ∈
// {--fast,--full}), an ABSOLUTE entry path (`<cwd>/<verifyEntry>`, `verifyEntry` from
// `deep_review.verify_entry`, default `verify`), `cwd` = the worktree
// root, `shell: false`. Phase 5 adds exactly two deltas: (1) the spawn timeout is
// bounded by the run deadline; (2) on GREEN the engine writes
// `verification: {sha: HEAD, scope, completed_at}` through the sole findings mutator
// (a later slice commit NULLs it). A spawn fault stays a machine error — never a
// green stamp.
//
// Verification-state invariants (BUG-01 / BUG-02, 2026-07-16):
//   - BUG-01: a green stamp is written ONLY when the tree is clean of non-tooling dirt
//     BEFORE and AFTER the shim, HEAD is unchanged across the run, and `git status` is
//     unchanged across the run. A shim run over uncommitted work (then restored) must NOT
//     certify the clean HEAD. The dirt check reuses nonToolingDirtyPaths, the same helper
//     the self-review capture gate uses.
//   - BUG-02: every attempt invalidates any PRIOR green stamp before the shim runs, so a
//     later red / timeout / signal / post-verify HEAD-read failure leaves NO usable green.
//     Only this attempt's own green result re-writes the stamp, so handoff reflects the
//     LATEST attempt.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_NEEDS_HUMAN } from './types.ts';
import type { FindingsFileV2, MachineError, TestRef } from './types.ts';
import { mutateFindings, readFindings } from './findings-io.ts';
import { nonToolingDirtyPaths } from './worktree.ts';
import type { DeepReviewContext } from './descriptor.ts';
import type { Deadline } from './deadline.ts';

// Bound the machine-readable stderr_tail (mirrors slice.ts / worktree.ts / handoff.ts).
const STDERR_TAIL_MAX = 2000;

// ── Effects seam ───────────────────────────────────────────────────────────────

// The result of a fixed-argv spawn. `status` is the process exit code, or null when
// the process failed to spawn (a missing / non-executable shim) or was killed
// (signal / deadline timeout). Re-declared locally (identical to slice.ts).
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The injected effects. `spawn` runs BOTH the verify shim (file = `<cwd>/<entry>`) and
// the fixed-argv git HEAD read (file = `git`), never a shell; `scope` is the
// ALREADY-VALIDATED scope flag the CLI resolved; `entry` is the config-resolved verify
// shim path (default `verify`). `mutate` is the sole findings writer; `findingsPath` is
// the run's findings file; `deadline` bounds the spawn; `now` stamps `completed_at`.
export interface VerifyDeps {
  cwd: string;
  scope: '--fast' | '--full';
  entry: string;
  findingsPath: string;
  deadline: Deadline;
  spawn: (file: string, args: readonly string[], options: { cwd: string; timeout?: number }) => SpawnResult;
  // §F2: the pre-spawn read whose revision guards the stamp write (a concurrent slice
  // could land a fix — and bump the revision — while the shim runs).
  readFindings: (path: string) => FindingsFileV2;
  // BUG-01: the worktree's `git status --porcelain`, used to reject a green stamp taken over a
  // dirty tree (the shim would certify uncommitted work, not HEAD). Throws on a git failure.
  // OPTIONAL: the pure runFinalVerify unit tests stub only `spawn`, so an absent seam means the
  // tree is treated as clean; realVerifyDeps always wires the real read.
  getStatus?: () => string;
  mutate: (
    path: string,
    fn: (file: FindingsFileV2) => FindingsFileV2,
    expectedRevision?: number,
  ) => FindingsFileV2;
  now: () => string;
}

// What `runFinalVerify` returns at the command edge: an exit code plus, on a spawn
// failure ONLY, the §2.4 machine-readable error. `machineError` is OMITTED (never
// undefined) under exactOptionalPropertyTypes when there is no error.
export interface VerifyResult {
  exitCode: number;
  machineError?: MachineError;
}

// The real default spawn: fixed argv, `shell: false`, timeout-bounded, never a shell
// string. A spawn-level failure maps to `status: null`.
const defaultSpawn: VerifyDeps['spawn'] = (file, args, options) => {
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

// The production deps: the real fixed-argv verify + git spawn, the sole findings
// mutator (confined under `ctx.reportsRootAbs`), the run deadline, and a real clock.
export function realVerifyDeps(
  cwd: string,
  scope: '--fast' | '--full',
  findingsPath: string,
  ctx: DeepReviewContext,
): VerifyDeps {
  return {
    cwd,
    scope,
    entry: ctx.verifyEntry,
    findingsPath,
    deadline: ctx.deadline,
    spawn: defaultSpawn,
    readFindings: (p) => readFindings(p),
    // BUG-01 real `git status --porcelain`, deadline-bounded (fixed argv, shell:false). A git
    // failure THROWS a VerifyGitError -> machine error; it is never silently read as a clean tree.
    getStatus: () => {
      const r = defaultSpawn('git', ['status', '--porcelain'], { cwd, timeout: spawnTimeout(ctx.deadline) });
      if (r.status !== 0) {
        throw new VerifyGitError('git status --porcelain', `git status --porcelain failed (status ${r.status}): ${r.stderr.trim()}`);
      }
      return r.stdout;
    },
    mutate: (p, fn, expectedRevision) =>
      mutateFindings(p, { reportsRootAbs: ctx.reportsRootAbs }, fn, undefined, expectedRevision),
    now: () => new Date().toISOString(),
  };
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// The per-call spawn timeout: the deadline's remaining budget, floored at 1ms so an
// exhausted budget yields an immediate timeout (spawnSync treats 0 as "no timeout").
function spawnTimeout(deadline: Deadline): number {
  return Math.max(1, deadline.remainingMs());
}

// A git read failure inside the verify gate, carrying the exact command for the §2.4 machine
// error. Thrown by readHead and by realVerifyDeps' status read so verifyGitError can name the
// failing command precisely.
class VerifyGitError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = 'VerifyGitError';
    this.command = command;
    Object.setPrototypeOf(this, VerifyGitError.prototype);
  }
}

// The current HEAD of the worktree (a fixed-argv git read), or throws VerifyGitError on a git
// failure. Reached on every attempt (pre-shim) and again on a GREEN verify (post-shim).
function readHead(deps: VerifyDeps): string {
  const r = deps.spawn('git', ['rev-parse', 'HEAD'], { cwd: deps.cwd, timeout: spawnTimeout(deps.deadline) });
  if (r.status !== 0) throw new VerifyGitError('git rev-parse HEAD', `git rev-parse HEAD failed (status ${r.status}): ${r.stderr.trim()}`);
  const sha = r.stdout.trim();
  if (sha === '') throw new VerifyGitError('git rev-parse HEAD', 'git rev-parse HEAD returned no sha');
  return sha;
}

// Converts a git-read throw (HEAD or `git status`) into a §2.4 machine error naming step "verify".
// A VerifyGitError carries the exact command; an injected seam that throws a plain Error falls back
// to the HEAD command label (the only other reader).
function verifyGitError(error: unknown): VerifyResult {
  return {
    exitCode: EXIT_FAILURE,
    machineError: {
      command: error instanceof VerifyGitError ? error.command : 'git rev-parse HEAD',
      step: 'verify',
      message: error instanceof Error ? error.message : String(error),
      stderr_tail: '',
    },
  };
}

// A verify-state refusal (dirty tree, moved HEAD, or a tree that changed across the run): NO green
// stamp is written, so handoff stays blocked. EXIT_FAILURE + a §2.4 machine error, mirroring the
// pre-existing "HEAD moved" branch — a dirty/changed tree is the same class as a moved HEAD (the
// stamp could not honestly certify preHead).
function treeStateError(command: string, message: string): VerifyResult {
  return {
    exitCode: EXIT_FAILURE,
    machineError: { command, step: 'verify', message, stderr_tail: '' },
  };
}

// Runs the final verify gate. The shim is spawned ONCE with fixed argv `[scope]`, an
// ABSOLUTE entry path, cwd = the worktree root, shell:false, deadline-bounded.
export function runFinalVerify(deps: VerifyDeps): VerifyResult {
  const entry = path.join(deps.cwd, deps.entry);
  // No status seam wired (pure runFinalVerify unit tests stub only `spawn`) -> treat the tree as
  // clean; realVerifyDeps always wires the real `git status --porcelain` read.
  const readStatus = deps.getStatus ?? ((): string => '');

  // BUG-02: invalidate any PRIOR green stamp at the START of the attempt — before the shim and
  // before every early return below (dirty tree, red, timeout/signal, HEAD-read failure). A prior
  // green must never outlive a later failed/aborted attempt; only this attempt's own green result
  // re-writes it. Skip the write when there is nothing to invalidate, so a first (normal) verify
  // stays a single findings write. §F2: the revision anchors the green write's CAS.
  const pre = deps.readFindings(deps.findingsPath);
  let baseRevision = pre.revision;
  if (pre.verification !== null) {
    // Un-CAS'd on purpose: clear the stale stamp regardless of a concurrent revision bump, then
    // re-anchor the CAS on the post-invalidation revision.
    baseRevision = deps.mutate(deps.findingsPath, (file) => ({ ...file, verification: null })).revision;
  }

  // §F3 + BUG-01: capture HEAD + porcelain status BEFORE the shim. The verdict certifies only the
  // tree at (preHead, clean status); either moving during the run makes a green a lie.
  let preHead: string;
  let preStatus: string;
  try {
    preHead = readHead(deps);
    preStatus = readStatus();
  } catch (error) {
    return verifyGitError(error);
  }

  // BUG-01: a worktree dirty with non-tooling work means the shim would certify uncommitted
  // changes, not the committed preHead the stamp binds to. Fail closed BEFORE the shim, reusing the
  // same nonToolingDirtyPaths helper the self-review capture gate uses.
  const preDirty = nonToolingDirtyPaths(preStatus);
  if (preDirty.length > 0) {
    return treeStateError(
      'git status --porcelain',
      `worktree has uncommitted non-tooling changes (${preDirty.length}); commit or discard before verify (a green stamp must certify a clean HEAD)`,
    );
  }

  const result = deps.spawn(entry, [deps.scope], { cwd: deps.cwd, timeout: spawnTimeout(deps.deadline) });

  // Exit 0 -> GREEN: re-read HEAD + status and confirm NOTHING changed during the run (HEAD stable,
  // tree still clean AND unchanged), then record {sha: preHead, scope, completed_at} through the
  // sole mutator (CAS-guarded on baseRevision). A HEAD/status read failure here is a git error,
  // surfaced as a machine error (never a false green).
  if (result.status === 0) {
    let postHead: string;
    let postStatus: string;
    try {
      postHead = readHead(deps);
      postStatus = readStatus();
    } catch (error) {
      return verifyGitError(error);
    }
    if (postHead !== preHead) {
      return treeStateError('git rev-parse HEAD', 'HEAD moved during verification; rerun');
    }
    // BUG-01: the tree must still be clean AND identical to the pre-shim status — a shim (or a
    // concurrent process) that dirtied or otherwise changed the tree means the green no longer
    // certifies a clean preHead.
    if (nonToolingDirtyPaths(postStatus).length > 0 || postStatus !== preStatus) {
      return treeStateError(
        'git status --porcelain',
        'worktree changed during verification (a green stamp requires a clean, unchanged tree); commit or discard and rerun',
      );
    }
    const testRef: TestRef = deps.scope === '--full' ? 'verify:full' : 'verify:fast';
    deps.mutate(
      deps.findingsPath,
      (file) => ({
        ...file,
        verification: { sha: preHead, scope: testRef, completed_at: deps.now() },
      }),
      baseRevision,
    );
    return { exitCode: EXIT_OK };
  }

  // A null status (the shim never produced an exit code) is a TOOL failure, not a
  // verify verdict -> fail closed with a §2.4 machine error naming step "verify". The
  // cause is left unasserted: spawnSync returns a null status for a missing /
  // non-executable shim (ENOENT/EACCES), a shim killed by a signal or output-buffer
  // overflow, AND a deadline timeout — naming only one would mislabel the others.
  if (result.status === null) {
    const command = `${entry} ${deps.scope}`;
    return {
      exitCode: EXIT_FAILURE,
      machineError: {
        command,
        step: 'verify',
        message: `${command} did not return an exit code (verify shim missing or non-executable, the process was killed by a signal / exceeded its output buffer, or the run deadline elapsed)`,
        stderr_tail: tailOf(result.stderr),
      },
    };
  }

  // Any NON-ZERO exit -> verify found problems: the whole refactor is needs-human and
  // NOTHING landed. No stamp is written on this attempt, and BUG-02's up-front invalidation
  // already cleared any prior green — so a red result leaves no usable stamp for handoff.
  return { exitCode: EXIT_NEEDS_HUMAN };
}
