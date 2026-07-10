import { spawnSync } from 'node:child_process';

// Keep git IO isolated here; -z preserves paths with whitespace/newlines.
// timeoutMs (remaining tier budget) bounds the probe; SIGKILL guarantees the reap even
// if git ignores SIGTERM. A non-positive budget means the deadline is already spent.
function gitFileList(args: string[], cwd: string, timeoutMs?: number): string[] {
  const argv = ['git', ...args];
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new Error(`refusing to run ${argv.join(' ')} (cwd: ${cwd}): tier deadline already exhausted`);
  }
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    killSignal: 'SIGKILL',
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
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
