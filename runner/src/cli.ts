import type { TierName } from './types.ts';

type RunnerScope = TierName | 'doctor' | 'fix-staged';

export type CliInvocation =
  | { ok: true; manifestPath: string; scope: RunnerScope }
  | { ok: false; message: string };

const SCOPE_FLAGS: Record<string, RunnerScope> = {
  '--staged': 'staged',
  '--fast': 'fast',
  '--full': 'full',
  '--audit': 'audit',
  '--doctor': 'doctor',
  '--fix-staged': 'fix-staged',
};

// Runner invocations require one manifest and exactly one scope flag.
export function parseArgs(argv: string[]): CliInvocation {
  let manifestPath: string | undefined;
  let scope: RunnerScope | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--manifest') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: 'missing value for --manifest <path>' };
      }
      if (manifestPath !== undefined) {
        return { ok: false, message: '--manifest may be given only once' };
      }
      manifestPath = value;
      i += 1;
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
