// E7 — the final verify gate. After all fix slices are committed and BEFORE the
// ADR-012 handoff, the deep-review runtime runs the worktree's verify shim ONCE.
// A GREEN run (exit 0) clears the refactor to proceed to handoff; a RED run (any
// non-zero exit) means verify found problems, so the whole refactor is
// `needs-human` (EXIT_NEEDS_HUMAN = 13) and NOTHING lands; a missing / non-executable
// shim (a failed spawn / null status) is a TOOL failure, not a verify verdict, so it
// fails closed with EXIT_FAILURE + a §2.4 MachineError naming step "verify".
//
// The shim is spawned with FIXED ARGV (`[scope]`, scope ∈ {--fast,--full}), an
// ABSOLUTE entry path (`<cwd>/verify`), `cwd` = the worktree root, and
// `shell: false` — the same fixed-argv discipline as slice.ts / worktree.ts (never a
// relative `./verify` + PATH lookup). Scope is resolved by the CLI (`--scope` flag
// ?? deep_review.verify_after_fix ?? --fast) and arrives already validated on
// `deps.scope`. Effects live behind the injected `spawn` seam so the gate is
// unit-testable without touching the real process.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_NEEDS_HUMAN } from './types.ts';
import type { MachineError } from './types.ts';

// Bound the machine-readable stderr_tail (mirrors slice.ts / worktree.ts / handoff.ts).
const STDERR_TAIL_MAX = 2000;

// The verify shim's filename at the worktree root (mirrors ./verify / ./workflow).
const VERIFY_ENTRY = 'verify';

// ── Effects seam ───────────────────────────────────────────────────────────────

// The result of a fixed-argv spawn. `status` is the process exit code, or null when
// the process failed to spawn (a missing / non-executable shim). Re-declared locally
// (identical to slice.ts / worktree.ts) so this module stays self-contained.
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The injected effects. `spawn` runs the verify shim (fixed argv, never a shell);
// `cwd` is the worktree root; `scope` is the ALREADY-VALIDATED scope flag the CLI
// resolved (`--scope` ?? deep_review.verify_after_fix ?? --fast).
export interface VerifyDeps {
  cwd: string;
  scope: '--fast' | '--full';
  spawn: (file: string, args: readonly string[], options: { cwd: string }) => SpawnResult;
}

// What `runFinalVerify` returns at the command edge: an exit code plus, on a spawn
// failure ONLY, the §2.4 machine-readable error the CLI prints as the last stderr
// line. `machineError` is OMITTED (never undefined) under exactOptionalPropertyTypes
// when there is no error.
export interface VerifyResult {
  exitCode: number;
  machineError?: MachineError;
}

// The real default spawn: fixed argv, `shell: false`, never a shell string. A
// spawn-level failure (missing / non-executable shim) maps to `status: null` so the
// caller treats it as a tool failure rather than confusing it with a verify verdict.
const defaultSpawn: VerifyDeps['spawn'] = (file, args, options) => {
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

// The production deps: the real fixed-argv verify spawn. `cwd` is the worktree the
// final verify runs in; `scope` is the CLI-resolved, already-validated scope flag.
// Mirrors slice.ts `realSliceDeps` / worktree.ts `realWorktreeDeps`.
export function realVerifyDeps(cwd: string, scope: '--fast' | '--full'): VerifyDeps {
  return {
    cwd,
    scope,
    spawn: defaultSpawn,
  };
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// Runs the final verify gate. The shim is spawned ONCE with fixed argv `[scope]`,
// an ABSOLUTE entry path, cwd = the worktree root, shell:false.
export function runFinalVerify(deps: VerifyDeps): VerifyResult {
  const entry = path.join(deps.cwd, VERIFY_ENTRY);
  const result = deps.spawn(entry, [deps.scope], { cwd: deps.cwd });

  // Exit 0 -> the refactor is clear to proceed to handoff.
  if (result.status === 0) return { exitCode: EXIT_OK };

  // A null status (the shim never produced an exit code) is a TOOL failure, not a
  // verify verdict -> fail closed with a §2.4 machine error naming step "verify".
  // The cause is left unasserted: spawnSync returns a null status for a missing /
  // non-executable shim (ENOENT/EACCES) AND for a shim that ran then was killed by a
  // signal or exceeded its output buffer — naming only "missing shim" would
  // mislabel the latter. `stderr_tail` carries whatever diagnostic git/the OS gave.
  if (result.status === null) {
    const command = `${entry} ${deps.scope}`;
    return {
      exitCode: EXIT_FAILURE,
      machineError: {
        command,
        step: 'verify',
        message: `${command} did not return an exit code (verify shim missing or non-executable, or the process was killed by a signal / exceeded its output buffer)`,
        stderr_tail: tailOf(result.stderr),
      },
    };
  }

  // Any NON-ZERO exit -> verify found problems: the whole refactor is needs-human
  // and NOTHING landed.
  return { exitCode: EXIT_NEEDS_HUMAN };
}
