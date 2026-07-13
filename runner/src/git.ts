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

/* fix-staged skips files that also appear here: formatting the whole working file then
   `git add`-ing it would sweep unstaged hunks into the commit. */
export function unstagedFiles(cwd: string, timeoutMs?: number): string[] {
  return gitFileList(['diff', '--name-only', '-z'], cwd, timeoutMs);
}

/* `--` stops a path being parsed as an option; `--literal-pathspecs` stops a name with glob magic
   (`a[b].ts`, `*`) from matching OTHER files — otherwise re-staging could sweep unrelated edits. */
export function addPaths(paths: string[], cwd: string, timeoutMs?: number): void {
  if (paths.length === 0) return;
  gitFileList(['--literal-pathspecs', 'add', '--', ...paths], cwd, timeoutMs);
}

/* Of `paths`, only those the index records as a regular file (blob mode 100644/100755). A staged
   symlink (120000) or gitlink (160000) is excluded so the formatter can't be handed a symlink whose
   target lives outside the repo — writing through it would corrupt data `git checkout` cannot
   restore. `git ls-files -s -z` prints "<mode> <sha> <stage>\t<path>" per NUL-separated record. */
export function stagedRegularFiles(paths: string[], cwd: string, timeoutMs?: number): string[] {
  if (paths.length === 0) return [];
  const regular: string[] = [];
  for (const entry of gitFileList(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths], cwd, timeoutMs)) {
    const tab = entry.indexOf('\t');
    const space = entry.indexOf(' ');
    if (tab < 0 || space < 0) continue;
    const mode = entry.slice(0, space);
    if (mode === '100644' || mode === '100755') regular.push(entry.slice(tab + 1));
  }
  return regular;
}

/* Revert working-tree changes to the index for exactly these paths — the fix-staged rollback.
   Lossless only because callers restrict it to files with no unstaged changes. `--literal-pathspecs`
   keeps a glob-magic filename from reverting unrelated files. */
export function restoreWorktree(paths: string[], cwd: string, timeoutMs?: number): void {
  if (paths.length === 0) return;
  gitFileList(['--literal-pathspecs', 'checkout', '--', ...paths], cwd, timeoutMs);
}
