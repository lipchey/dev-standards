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

  /* Ordered, mutually exclusive classification, checked top to bottom. The first five rungs
     are operational or clean outcomes; only the last rung is a genuine finding-fail, and only
     there may a bypassable check be relaxed. This keeps a broken/missing/killed check — or a tool
     signalling its own operational failure via a declared exit code — from ever collapsing into a
     plain 'fail' (which would let it be bypassed or silently pass a tier). */
  const base = { name: check.name, tier, durationMs, mode };

  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ETIMEDOUT') {
      // Reap the whole process group; the immediate child is already SIGKILLed by spawnSync.
      if (result.pid) {
        try {
          process.kill(-result.pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
      }
      return { ...base, status: 'timeout', exitCode: null };
    }
    /* Spawn fault (ENOENT/EACCES/…): the check never ran, so this is operational, not a finding. */
    return { ...base, status: 'error', exitCode: null, reason: err.code ?? err.message };
  }

  /* No exit code: the child was killed by a signal (or produced none). Operational, never a finding. */
  if (result.status === null) {
    return {
      ...base,
      status: 'error',
      exitCode: null,
      reason: result.signal ? `signal: ${result.signal}` : 'no exit code',
    };
  }

  if (result.status === 0) {
    return { ...base, status: 'pass', exitCode: 0 };
  }

  /* Declared operational exit code: the tool signalled an INTERNAL failure (e.g. diff-cover exit 2
     on stale coverage), not a caught defect. Classify as 'error' — unbypassable and blocking
     regardless of mode, like a spawn fault — so a tool malfunction never counts as a caught finding
     nor slips through a bypassable check. The CheckResult contract fixes exitCode:null for 'error',
     so the real code is preserved in `reason`. */
  if (check.operational_exit_codes?.includes(result.status)) {
    return { ...base, status: 'error', exitCode: null, reason: `operational exit ${result.status}` };
  }

  /* Genuine finding-fail (nonzero exit). A bypassable check with a non-empty reason is relaxed
     to 'bypassed', keeping the exit code; every other case (and every non-bypassable check) fails. */
  const bypassReason = process.env.DS_BYPASS_REASON?.trim();
  if (check.bypassable === true && bypassReason) {
    return { ...base, status: 'bypassed', exitCode: result.status, reason: bypassReason };
  }
  return { ...base, status: 'fail', exitCode: result.status };
}
