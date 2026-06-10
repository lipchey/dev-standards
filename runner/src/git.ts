import { spawnSync } from 'node:child_process';

// Keep git IO isolated here; -z preserves paths with whitespace/newlines.
function gitFileList(args: string[], cwd: string): string[] {
  const argv = ['git', ...args];
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
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

export function trackedFiles(cwd: string): string[] {
  return gitFileList(['ls-files', '-z'], cwd);
}

// ACMR is the pre-commit default: added/copied/modified/renamed.
export function stagedFiles(diffFilter = 'ACMR', cwd: string): string[] {
  return gitFileList(
    ['diff', '--cached', '--name-only', '-z', `--diff-filter=${diffFilter}`],
    cwd,
  );
}
