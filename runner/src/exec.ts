import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import type { Check, CheckMode, CheckResult, TierName } from './types.ts';

export interface RunCheckInput {
  check: Check;
  tier: TierName;
  cwd: string;
  filesByName: Map<string, string[]>;
  // Remaining tier budget (ms); caps this check's timeout so no check outlives the tier deadline.
  remainingMs?: number;
}

const FILES_TOKEN = /^\{files:([A-Za-z0-9_-]+)\}$/;

// Expanded repo filenames must not become options or response files; manifest args are trusted.
const OPTION_LIKE_OPERAND = /^[-@]/;

export function expandArgv(argv: string[], filesByName: Map<string, string[]>): string[] {
  const expanded: string[] = [];
  for (const element of argv) {
    const match = FILES_TOKEN.exec(element);
    if (match) {
      const [, name] = match;
      if (name !== undefined) {
        for (const file of filesByName.get(name) ?? []) {
          if (OPTION_LIKE_OPERAND.test(file)) {
            throw new Error(
              `fileset "${name}" produced an option-like operand ${JSON.stringify(file)}; ` +
                'refusing to pass it as a command argument ' +
                '(possible argv option or response-file injection)',
            );
          }
          expanded.push(file);
        }
      }
      continue;
    }
    expanded.push(element);
  }
  return expanded;
}

function skipped(name: string, tier: TierName, mode: CheckMode): CheckResult {
  return { name, tier, status: 'skipped', exitCode: null, durationMs: 0, mode };
}

export function runCheck(input: RunCheckInput): CheckResult {
  const { check, tier, cwd, filesByName, remainingMs } = input;
  const mode: CheckMode = check.mode ?? 'blocking';

  if (check.skip_if_empty !== undefined) {
    const gating = filesByName.get(check.skip_if_empty);
    if (gating === undefined || gating.length === 0) return skipped(check.name, tier, mode);
  }

  const [file, ...args] = expandArgv(check.argv, filesByName);
  // Token-only argv can collapse to nothing.
  if (file === undefined) return skipped(check.name, tier, mode);

  const startedAt = Date.now();
  // Cap the check at whatever tier budget is left, but never longer than its own timeout.
  const timeoutMs = Math.min(check.timeout_seconds * 1000, remainingMs ?? Number.POSITIVE_INFINITY);
  // detached:true makes the child a process-group leader so we can SIGKILL the whole
  // subtree on timeout (spawnSync's own killSignal reaches only the immediate child).
  // ponytail: a detached group also means an interactive Ctrl-C won't propagate to the
  // check's descendants — acceptable for this trusted local pilot.
  // `detached` is honored by spawnSync at runtime but missing from @types/node's
  // SpawnSyncOptions, so assert the shape.
  const result = spawnSync(file, args, {
    shell: false,
    stdio: 'inherit',
    cwd,
    detached: true,
    killSignal: 'SIGKILL',
    timeout: timeoutMs,
  } as SpawnSyncOptions);
  const durationMs = Date.now() - startedAt;

  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      // Reap the whole process group; the immediate child is already SIGKILLed by spawnSync.
      if (result.pid) {
        try {
          process.kill(-result.pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
      }
      return { name: check.name, tier, status: 'timeout', exitCode: null, durationMs, mode };
    }
    return { name: check.name, tier, status: 'fail', exitCode: 1, durationMs, mode };
  }

  if (result.status === 0) {
    return { name: check.name, tier, status: 'pass', exitCode: 0, durationMs, mode };
  }
  return { name: check.name, tier, status: 'fail', exitCode: result.status ?? 1, durationMs, mode };
}
