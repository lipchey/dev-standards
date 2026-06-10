import { spawnSync } from 'node:child_process';
import type { Check, CheckMode, CheckResult, TierName } from './types.ts';

export interface RunCheckInput {
  check: Check;
  tier: TierName;
  cwd: string;
  filesByName: Map<string, string[]>;
}

/** A `{files:<name>}` argv element; the capture group is the fileset name. */
const FILES_TOKEN = /^\{files:([A-Za-z0-9_-]+)\}$/;

/**
 * A token-expanded operand beginning with `-` would be parsed as an OPTION by
 * the spawned tool rather than as a file path (argv option injection). Filesets
 * come from repo contents, so a pull request can introduce a file literally
 * named `--config=evil.ts` that an honest TypeScript fileset then selects; with
 * `shell:false` this is the residual injection vector. Only expanded operands
 * are screened — a `--flag` the manifest author wrote directly into the argv is
 * author-controlled and trusted.
 */
const OPTION_LIKE_OPERAND = /^-/;

/**
 * Expands file tokens in an argv. Each `{files:<name>}` element is replaced by
 * the spread of `filesByName.get(name) ?? []`; every other element passes
 * through unchanged. The result is flattened, so a token whose fileset is empty
 * simply contributes nothing.
 *
 * Throws if any expanded operand is option-like (see `OPTION_LIKE_OPERAND`), so
 * such an operand never reaches `spawnSync`; the run fails closed rather than
 * handing an attacker-controlled flag to the tool.
 */
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
                'refusing to pass it as a command argument (possible argv option injection)',
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

/** Builds a `skipped` result; no command runs, so duration is ~0. */
function skipped(name: string, tier: TierName, mode: CheckMode): CheckResult {
  return { name, tier, status: 'skipped', exitCode: null, durationMs: 0, mode };
}

/**
 * Runs one check and maps its outcome to a `CheckResult`.
 *
 * Skips (without spawning) when `skip_if_empty` names an empty/absent fileset,
 * or when the expanded argv has no command word (a token-only argv whose sole
 * fileset expanded empty). Otherwise spawns the command synchronously with
 * inherited stdio and the check's timeout.
 *
 * Outcome mapping: exit 0 -> pass; non-zero exit -> fail (exitCode = the exit
 * status); a spawn timeout (`ETIMEDOUT`) -> timeout with exitCode null; any
 * other spawn error (notably a missing binary, `ENOENT`) -> fail with
 * exitCode 1. We branch on `result.error.code` first so an `ETIMEDOUT` kill is
 * never confused with an `ENOENT` launch failure (both leave `status` null).
 */
export function runCheck(input: RunCheckInput): CheckResult {
  const { check, tier, cwd, filesByName } = input;
  const mode: CheckMode = check.mode ?? 'blocking';

  if (check.skip_if_empty !== undefined) {
    const gating = filesByName.get(check.skip_if_empty);
    if (gating === undefined || gating.length === 0) return skipped(check.name, tier, mode);
  }

  const [file, ...args] = expandArgv(check.argv, filesByName);
  // No command word means the argv collapsed to nothing (token-only, empty
  // fileset). Skip rather than spawn an empty command.
  if (file === undefined) return skipped(check.name, tier, mode);

  const startedAt = Date.now();
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
    // ENOENT (missing binary) and any other spawn error map to a hard failure.
    return { name: check.name, tier, status: 'fail', exitCode: 1, durationMs, mode };
  }

  if (result.status === 0) {
    return { name: check.name, tier, status: 'pass', exitCode: 0, durationMs, mode };
  }
  // Non-zero exit, or a signal kill that left no error (status null) -> fail.
  return { name: check.name, tier, status: 'fail', exitCode: result.status ?? 1, durationMs, mode };
}
