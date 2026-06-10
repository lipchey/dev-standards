import { spawnSync } from 'node:child_process';
import type { Check, CheckMode, CheckResult, TierName } from './types.ts';

export interface RunCheckInput {
  check: Check;
  tier: TierName;
  cwd: string;
  filesByName: Map<string, string[]>;
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
  const { check, tier, cwd, filesByName } = input;
  const mode: CheckMode = check.mode ?? 'blocking';

  if (check.skip_if_empty !== undefined) {
    const gating = filesByName.get(check.skip_if_empty);
    if (gating === undefined || gating.length === 0) return skipped(check.name, tier, mode);
  }

  const [file, ...args] = expandArgv(check.argv, filesByName);
  // Token-only argv can collapse to nothing.
  if (file === undefined) return skipped(check.name, tier, mode);

  const startedAt = Date.now();
  // spawnSync timeout kills only the immediate child; process-group cleanup would require async orchestration.
  const result = spawnSync(file, args, {
    shell: false,
    stdio: 'inherit',
    cwd,
    timeout: check.timeout_seconds * 1000,
  });
  const durationMs = Date.now() - startedAt;

  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      return { name: check.name, tier, status: 'timeout', exitCode: null, durationMs, mode };
    }
    return { name: check.name, tier, status: 'fail', exitCode: 1, durationMs, mode };
  }

  if (result.status === 0) {
    return { name: check.name, tier, status: 'pass', exitCode: 0, durationMs, mode };
  }
  return { name: check.name, tier, status: 'fail', exitCode: result.status ?? 1, durationMs, mode };
}
