import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import type { Check, CheckMode, CheckResult, TierName } from './types.ts';
import { capAndRedactBypassReason } from './redact.ts';

export interface RunCheckInput {
  check: Check;
  tier: TierName;
  cwd: string;
  filesByName: Map<string, string[]>;
  // Remaining tier budget (ms); caps this check's timeout so no check outlives the tier deadline.
  remainingMs?: number;
}

// Bound the captured stderr tail folded into a RunProcessResult (mirrors the deep-review edge).
const STDERR_TAIL_MAX = 2000;

/* The generic process-execution result the deep-review verbs consume (deadline-bounded git /
   test spawns). `kind` is the ONLY verdict that matters downstream: 'red' is a clean non-zero
   exit (a genuine test/tool failure); 'operational' is a timeout, a spawn fault, or a signal
   kill — the process never produced a verdict, so it must NEVER be confused with a red test. */
export interface RunProcessResult {
  kind: 'ok' | 'red' | 'operational';
  exitCode: number | null;
  stdout: string;
  stderrTail: string;
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// The shared spawn mechanic behind both `runCheck` and `runProcess`: run `argv` as a detached
// process-group leader (`detached: true`) so a timeout can SIGKILL the whole subtree, not just
// the immediate child, then reap the group on ETIMEDOUT. `stdio` is the ONLY thing that differs
// between the two callers ('inherit' for a check streaming live output; piped for a captured
// generic run), so it stays a parameter — the group/kill/reap logic lives here once.
// Returns the raw spawnSync result plus a `timedOut` flag (the ETIMEDOUT-and-reaped case), which
// each caller maps onto its own typed result.
function spawnGroup(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  stdio: SpawnSyncOptions['stdio'],
): { result: SpawnSyncReturns<string>; timedOut: boolean } {
  const [file, ...args] = argv;
  // `detached` is honored by spawnSync at runtime but missing from @types/node's
  // SpawnSyncOptions, so assert the shape.
  // ponytail: a detached group also means an interactive Ctrl-C won't propagate to the
  // spawned subtree — acceptable for this trusted local pilot.
  const result = spawnSync(file as string, args, {
    shell: false,
    stdio,
    cwd,
    detached: true,
    killSignal: 'SIGKILL',
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  } as SpawnSyncOptions) as SpawnSyncReturns<string>;

  let timedOut = false;
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    timedOut = true;
    // Reap the whole process group; the immediate child is already SIGKILLed by spawnSync.
    if (result.pid) {
      try {
        process.kill(-result.pid, 'SIGKILL');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    }
  }
  return { result, timedOut };
}

// Generic deadline-bounded process executor for the deep-review verbs (git / test spawns). Shares
// the detached-group + SIGKILL + reap mechanic with `runCheck` but captures stdout/stderr and
// classifies into the ok/red/operational taxonomy the fix verbs need. `timeoutMs <= 0` means the
// deadline is already spent: report 'operational' WITHOUT spawning (a pre-spawn checkpoint), so an
// expired budget can never masquerade as a red test.
export function runProcess(input: { argv: string[]; cwd: string; timeoutMs: number }): RunProcessResult {
  const { argv, cwd, timeoutMs } = input;
  if (timeoutMs <= 0) {
    return { kind: 'operational', exitCode: null, stdout: '', stderrTail: 'deadline exceeded before spawn' };
  }
  const { result, timedOut } = spawnGroup(argv, cwd, timeoutMs, ['ignore', 'pipe', 'pipe']);
  const stdout = result.stdout ?? '';
  const stderrTail = tailOf(result.stderr ?? '');
  if (timedOut) {
    return { kind: 'operational', exitCode: null, stdout, stderrTail: stderrTail || 'timed out' };
  }
  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
    return { kind: 'operational', exitCode: null, stdout, stderrTail: stderrTail || (err.code ?? err.message) };
  }
  if (result.status === null) {
    const reason = result.signal ? `signal: ${result.signal}` : 'no exit code';
    return { kind: 'operational', exitCode: null, stdout, stderrTail: stderrTail || reason };
  }
  if (result.status === 0) return { kind: 'ok', exitCode: 0, stdout, stderrTail };
  return { kind: 'red', exitCode: result.status, stdout, stderrTail };
}

const FILES_TOKEN = /^\{files:([\w-]+)\}$/;

// Expanded repo filenames must not become options or response files; manifest args are trusted.
const OPTION_LIKE_OPERAND = /^[-@]/;

/* Tools that glob-expand their file operands (eslint, prettier, …) silently
   mis-resolve a staged filename containing a glob metacharacter — it matches as a
   pattern instead of the literal file. Refuse, for EVERY {files:...} operand (both the
   check runner and fix-staged): the always-magic `* ? [ ] { }`, the extglob triggers
   `!( +( @(` (`?(`/`*(` are already covered by `?`/`*`), and a leading `!` (glob
   negation). A formatter that globs its operands mis-resolves or drops such a file just
   as a linter would, and this throw runs BEFORE any mutation, so a loud pre-mutation
   refusal beats a silent skip. Ceiling: a BARE `(`/`)` (not an extglob trigger) stays
   allowed — it is a common literal filename char, so a plain `foo(1).ts` passes. */
const GLOB_METACHAR_OPERAND = /[*?[\]{}]|[!+@]\(|^!/;

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
          if (GLOB_METACHAR_OPERAND.test(file)) {
            throw new Error(
              `fileset "${name}" produced an operand ${JSON.stringify(file)} containing a glob ` +
                'metacharacter (* ? [ ] { }, an extglob trigger !( +( @(, or a leading !); ' +
                'refusing to pass it as a command argument ' +
                '(a tool that glob-expands operands would silently mis-resolve it)',
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

  const expanded = expandArgv(check.argv, filesByName);
  const [file] = expanded;
  // Token-only argv can collapse to nothing.
  if (file === undefined) return skipped(check.name, tier, mode);

  const startedAt = Date.now();
  // Cap the check at whatever tier budget is left, but never longer than its own timeout.
  const timeoutMs = Math.min(check.timeout_seconds * 1000, remainingMs ?? Number.POSITIVE_INFINITY);
  // `stdio: 'inherit'` streams check output live to the terminal (a check IS the user-facing
  // run), unlike the captured `runProcess`. The detached-group + SIGKILL + reap mechanic is
  // shared via `spawnGroup`; the timeout/error/status classification below is unchanged.
  const { result, timedOut } = spawnGroup(expanded, cwd, timeoutMs, 'inherit');
  const durationMs = Date.now() - startedAt;

  /* Ordered, mutually exclusive classification, checked top to bottom. The first five rungs
     are operational or clean outcomes; only the last rung is a genuine finding-fail, and only
     there may a bypassable check be relaxed. This keeps a broken/missing/killed check — or a tool
     signalling its own operational failure via a declared exit code — from ever collapsing into a
     plain 'fail' (which would let it be bypassed or silently pass a tier). */
  const base = { name: check.name, tier, durationMs, mode };

  // A reaped timeout comes back through spawnGroup's flag; classify it BEFORE the raw
  // ETIMEDOUT error (still set on `result`) so it is not mistaken for a spawn fault.
  if (timedOut) return { ...base, status: 'timeout', exitCode: null };

  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
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
  const bypassReason = capAndRedactBypassReason(process.env.DS_BYPASS_REASON);
  if (check.bypassable === true && bypassReason) {
    return { ...base, status: 'bypassed', exitCode: result.status, reason: bypassReason };
  }
  return { ...base, status: 'fail', exitCode: result.status };
}
