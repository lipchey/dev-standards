import type { TierName } from './types.ts';

export type RunnerScope = TierName | 'doctor' | 'fix-staged';

export type CliInvocation =
  | { ok: true; manifestPath: string; scope: RunnerScope }
  | { ok: false; message: string };

/** The scope flags, each mapping to exactly one `RunnerScope`. */
const SCOPE_FLAGS: Record<string, RunnerScope> = {
  '--staged': 'staged',
  '--fast': 'fast',
  '--full': 'full',
  '--audit': 'audit',
  '--doctor': 'doctor',
  '--fix-staged': 'fix-staged',
};

/**
 * Parses runner CLI arguments into a validated invocation.
 *
 * `argv` is the user-argument slice — what `process.argv.slice(2)` yields, with
 * the `node` executable and script path already removed.
 *
 * A valid invocation is exactly one `--manifest <path>` and exactly one scope
 * flag (`--staged`, `--fast`, `--full`, `--audit`, `--doctor`, `--fix-staged`).
 * Missing manifest, missing scope, duplicates, a `--manifest` without a value,
 * and unknown flags all return `{ ok: false, message }` with a user-facing
 * message. This function never exits the process; the caller decides.
 */
export function parseArgs(argv: string[]): CliInvocation {
  let manifestPath: string | undefined;
  let scope: RunnerScope | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue; // satisfies noUncheckedIndexedAccess; not reachable in practice

    if (arg === '--manifest') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: 'missing value for --manifest <path>' };
      }
      if (manifestPath !== undefined) {
        return { ok: false, message: '--manifest may be given only once' };
      }
      manifestPath = value;
      i += 1; // consume the path token
      continue;
    }

    const scopeFromFlag = SCOPE_FLAGS[arg];
    if (scopeFromFlag !== undefined) {
      if (scope !== undefined) {
        return {
          ok: false,
          message: `multiple scope flags given (${scope}, ${scopeFromFlag}); choose exactly one`,
        };
      }
      scope = scopeFromFlag;
      continue;
    }

    return { ok: false, message: `unknown argument: ${arg}` };
  }

  if (manifestPath === undefined) {
    return { ok: false, message: 'missing required --manifest <path>' };
  }
  if (scope === undefined) {
    return {
      ok: false,
      message: `missing required scope flag (one of: ${Object.keys(SCOPE_FLAGS).join(', ')})`,
    };
  }
  return { ok: true, manifestPath, scope };
}
