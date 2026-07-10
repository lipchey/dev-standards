import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

// Keep git IO isolated here; -z preserves paths with whitespace/newlines.
// timeoutMs (remaining tier budget) bounds the probe; SIGKILL guarantees the reap even
// if git ignores SIGTERM. A non-positive budget means the deadline is already spent.
function gitFileList(args: string[], cwd: string, timeoutMs?: number): string[] {
  const argv = ['git', ...args];
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new Error(`refusing to run ${argv.join(' ')} (cwd: ${cwd}): tier deadline already exhausted`);
  }
  // detached:true makes git a process-group leader so a timeout can SIGKILL the whole
  // subtree (a PATH wrapper / helper git spawns), not just the immediate git process
  // (spawnSync's killSignal reaches only the immediate child). `detached` is honored at
  // runtime but missing from @types/node's options type, so assert the shape (keeping
  // the string-encoding variant so result.stdout/stderr stay typed as string).
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    detached: true,
    killSignal: 'SIGKILL',
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  } as SpawnSyncOptionsWithStringEncoding);

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      // Reap the whole group; the immediate child is already SIGKILLed by spawnSync.
      if (result.pid) {
        try {
          process.kill(-result.pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
      }
      throw new Error(`${argv.join(' ')} timed out after ${timeoutMs}ms (cwd: ${cwd})`);
    }
    throw new Error(`failed to run ${argv.join(' ')} (cwd: ${cwd}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(
      `${argv.join(' ')} exited with code ${result.status} (cwd: ${cwd})` +
        (stderr ? `: ${stderr}` : ''),
    );
  }

  const stdout = result.stdout ?? '';
  const parts = stdout.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function trackedFiles(cwd: string, timeoutMs?: number): string[] {
  return gitFileList(['ls-files', '-z'], cwd, timeoutMs);
}

// ACMR is the pre-commit default: added/copied/modified/renamed.
export function stagedFiles(diffFilter = 'ACMR', cwd: string, timeoutMs?: number): string[] {
  return gitFileList(
    ['diff', '--cached', '--name-only', '-z', `--diff-filter=${diffFilter}`],
    cwd,
    timeoutMs,
  );
}
