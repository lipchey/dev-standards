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
// {--fast,--full}), an ABSOLUTE entry path (`<cwd>/verify`), `cwd` = the worktree
// root, `shell: false`. Phase 5 adds exactly two deltas: (1) the spawn timeout is
// bounded by the run deadline; (2) on GREEN the engine writes
// `verification: {sha: HEAD, scope, completed_at}` through the sole findings mutator
// (a later slice commit NULLs it). A spawn fault stays a machine error — never a
// green stamp.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_NEEDS_HUMAN } from './types.ts';
import type { FindingsFileV2, MachineError, TestRef } from './types.ts';
import { mutateFindings, readFindings } from './findings-io.ts';
import type { DeepReviewContext } from './descriptor.ts';
import type { Deadline } from './deadline.ts';

// Bound the machine-readable stderr_tail (mirrors slice.ts / worktree.ts / handoff.ts).
const STDERR_TAIL_MAX = 2000;

// The verify shim's filename at the worktree root (mirrors ./verify).
const VERIFY_ENTRY = 'verify';

// ── Effects seam ───────────────────────────────────────────────────────────────

// The result of a fixed-argv spawn. `status` is the process exit code, or null when
// the process failed to spawn (a missing / non-executable shim) or was killed
// (signal / deadline timeout). Re-declared locally (identical to slice.ts).
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The injected effects. `spawn` runs BOTH the verify shim (file = `<cwd>/verify`) and
// the fixed-argv git HEAD read (file = `git`), never a shell; `scope` is the
// ALREADY-VALIDATED scope flag the CLI resolved. `mutate` is the sole findings
// writer; `findingsPath` is the run's findings file; `deadline` bounds the spawn;
// `now` stamps `completed_at`.
export interface VerifyDeps {
  cwd: string;
  scope: '--fast' | '--full';
  findingsPath: string;
  deadline: Deadline;
  spawn: (file: string, args: readonly string[], options: { cwd: string; timeout?: number }) => SpawnResult;
  // §F2: the pre-spawn read whose revision guards the stamp write (a concurrent slice
  // could land a fix — and bump the revision — while the shim runs).
  readFindings: (path: string) => FindingsFileV2;
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
    findingsPath,
    deadline: ctx.deadline,
    spawn: defaultSpawn,
    readFindings: (p) => readFindings(p),
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

// The current HEAD of the worktree (a fixed-argv git read), or throws on a git
// failure. Only reached on a GREEN verify to stamp the verification sha.
function readHead(deps: VerifyDeps): string {
  const r = deps.spawn('git', ['rev-parse', 'HEAD'], { cwd: deps.cwd, timeout: spawnTimeout(deps.deadline) });
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed (status ${r.status}): ${r.stderr.trim()}`);
  const sha = r.stdout.trim();
  if (sha === '') throw new Error('git rev-parse HEAD returned no sha');
  return sha;
}

function headReadError(error: unknown): VerifyResult {
  return {
    exitCode: EXIT_FAILURE,
    machineError: {
      command: `git rev-parse HEAD`,
      step: 'verify',
      message: error instanceof Error ? error.message : String(error),
      stderr_tail: '',
    },
  };
}

// Runs the final verify gate. The shim is spawned ONCE with fixed argv `[scope]`, an
// ABSOLUTE entry path, cwd = the worktree root, shell:false, deadline-bounded.
export function runFinalVerify(deps: VerifyDeps): VerifyResult {
  const entry = path.join(deps.cwd, VERIFY_ENTRY);

  // §F3 capture HEAD + §F2 capture the findings revision BEFORE the shim spawn. The verify
  // verdict only holds for the tree at `preHead`; if HEAD moves while the shim runs (a
  // concurrent commit), a green stamp against the NEW HEAD would be a lie.
  let preHead: string;
  try {
    preHead = readHead(deps);
  } catch (error) {
    return headReadError(error);
  }
  const baseRevision = deps.readFindings(deps.findingsPath).revision;

  const result = deps.spawn(entry, [deps.scope], { cwd: deps.cwd, timeout: spawnTimeout(deps.deadline) });

  // Exit 0 -> GREEN: re-read HEAD and confirm it did NOT move during verification, then
  // record the verification stamp {sha: preHead, scope, completed_at} through the sole
  // mutator (CAS-guarded on baseRevision), and clear to proceed to handoff. A HEAD-read
  // failure here is a git error, surfaced as a machine error (never a false green).
  if (result.status === 0) {
    let postHead: string;
    try {
      postHead = readHead(deps);
    } catch (error) {
      return headReadError(error);
    }
    if (postHead !== preHead) {
      return {
        exitCode: EXIT_FAILURE,
        machineError: {
          command: `git rev-parse HEAD`,
          step: 'verify',
          message: 'HEAD moved during verification; rerun',
          stderr_tail: '',
        },
      };
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
  // NOTHING landed (no verification stamp is written).
  return { exitCode: EXIT_NEEDS_HUMAN };
}
