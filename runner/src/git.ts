import { spawnSync } from 'node:child_process';

/**
 * Git helpers that produce deterministic, NUL-delimited file lists.
 *
 * These are the only place in the runner that shells out to git: every other
 * module consumes plain `string[]`, which keeps IO isolated and lets the fileset
 * logic be tested with injected lists. Both helpers request `-z` (NUL-delimited)
 * output so paths with spaces or newlines survive intact, split on the NUL byte,
 * and drop the trailing empty string NUL-termination leaves behind.
 */

/** Runs `git <args>` in `cwd`, returning NUL-split paths; throws on any failure. */
function gitFileList(args: string[], cwd: string): string[] {
  const argv = ['git', ...args];
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    // e.g. git not on PATH — surface the spawn fault, not a misleading exit code.
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
  // NUL-termination leaves a trailing empty field; drop it. Empty output -> [].
  const parts = stdout.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** All tracked files: `git ls-files -z`. */
export function trackedFiles(cwd: string): string[] {
  return gitFileList(['ls-files', '-z'], cwd);
}

/**
 * Staged files for the given diff filter: `git diff --cached --name-only -z
 * --diff-filter=<diffFilter>`. Defaults to `ACMR` (added/copied/modified/renamed)
 * — the change classes a pre-commit quality gate cares about.
 */
export function stagedFiles(diffFilter = 'ACMR', cwd: string): string[] {
  return gitFileList(
    ['diff', '--cached', '--name-only', '-z', `--diff-filter=${diffFilter}`],
    cwd,
  );
}
