import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { expandFileset, filesetByName } from './filesets.ts';
import { expandArgv, runProcess } from './exec.ts';
import { unstagedFiles, addPaths, restoreWorktree, stagedRegularFiles } from './git.ts';
import type { Manifest } from './types.ts';

/* Cleanup must survive an already-spent formatter deadline, so the rollback git ops get their own
   fixed window rather than the (possibly zero) remaining budget. */
const CLEANUP_MS = 15_000;
/* Bounds each staged/unstaged probe when it is tighter than the formatter deadline. */
const PROBE_MS = 15_000;
/* Internal fileset token so file operands flow through expandArgv's OPTION_LIKE_OPERAND guard
   instead of a second copy of it. */
const SAFE_TOKEN = '__fix_staged_safe__';

function write(stream: NodeJS.WriteStream, line: string): void {
  stream.write(`${line}\n`);
}

/* Revert the working-tree formatting so a failed run cannot leave files that look partially staged
   on the next commit (which would then be skipped and committed unformatted). Lossless because the
   restored set never has unstaged changes. Best-effort: a rollback fault is reported, never thrown,
   so it cannot mask the original failure. */
function rollback(safe: string[], root: string, err: NodeJS.WriteStream): void {
  try {
    restoreWorktree(safe, root, CLEANUP_MS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    write(err, `fix-staged: rollback failed — check 'git status': ${detail}`);
  }
}

/* Format the staged files in place and re-stage them, so `git commit` captures formatted code.
   Runs only when policy.format_fix_staged_allowed is true and a `format` block is configured;
   otherwise a no-op exit 0 (the pre-commit hook can call it unconditionally). Partially-staged
   files (working tree ≠ index) are skipped — formatting the whole working file then re-adding it
   would sweep unstaged hunks into the commit. Callers wrap this so a thrown git fault becomes a
   clean CLI error. */
export function runFixStaged(
  manifest: Manifest,
  root: string,
  out: NodeJS.WriteStream = process.stdout,
  err: NodeJS.WriteStream = process.stderr,
  now: () => number = () => performance.now(),
): number {
  const format = manifest.format;
  if (!manifest.policy.format_fix_staged_allowed || format === undefined) {
    write(out, 'fix-staged: no formatter configured or disabled by policy — nothing to do');
    return 0;
  }

  const fileset = filesetByName(manifest, format.fileset);
  if (fileset === undefined) {
    write(err, `fix-staged: format.fileset "${format.fileset}" is not a declared fileset`);
    return 1;
  }

  const deadline = now() + format.timeout_seconds * 1000;
  const remaining = (): number => Math.floor(deadline - now());
  const budget = (): number => Math.min(remaining(), PROBE_MS);
  // Fail-closed before any spawn: never launch a git/formatter process on a spent deadline.
  const expired = (): boolean => {
    if (remaining() > 0) return false;
    write(err, 'fix-staged: deadline exhausted');
    return true;
  };

  if (expired()) return 1;
  const staged = expandFileset(fileset, { cwd: root, remainingMs: budget });
  if (staged.length === 0) {
    write(out, 'fix-staged: no staged files match the format fileset');
    return 0;
  }

  if (expired()) return 1;
  const unstaged = new Set(unstagedFiles(root, budget()));
  const stageable = staged.filter((file) => !unstaged.has(file));
  const partial = staged.filter((file) => unstaged.has(file));
  if (partial.length > 0) {
    write(err, `fix-staged: skipping ${partial.length} partially-staged file(s): ${partial.join(', ')}`);
  }
  if (stageable.length === 0) {
    write(out, 'fix-staged: every staged file is partially staged — nothing to format');
    return 0;
  }

  if (expired()) return 1;
  const regular = new Set(stagedRegularFiles(stageable, root, budget()));
  const nonRegular = stageable.filter((file) => !regular.has(file));
  if (nonRegular.length > 0) {
    write(err, `fix-staged: skipping ${nonRegular.length} non-regular file(s) (symlink/submodule): ${nonRegular.join(', ')}`);
  }

  /* A hardlinked repo file (nlink > 1) may share its inode with a path OUTSIDE the repo, so
     formatting it in place silently rewrites that outside file — and `git checkout`, which restores
     by path not inode, cannot undo the external write. Reject nlink !== 1 BEFORE any mutation.
     (The index-mode check above already dropped symlinks/gitlinks; this filesystem lstat additionally
     drops hardlinks and any file retyped in the window since that probe.) */
  const hardlinked: string[] = [];
  const safe: string[] = [];
  for (const file of stageable) {
    if (!regular.has(file)) continue;
    const st = lstatSync(join(root, file), { throwIfNoEntry: false });
    if (st === undefined || !st.isFile() || st.nlink !== 1) {
      hardlinked.push(file);
      continue;
    }
    safe.push(file);
  }
  if (hardlinked.length > 0) {
    write(err, `fix-staged: skipping ${hardlinked.length} hardlinked/irregular file(s) (nlink != 1): ${hardlinked.join(', ')}`);
  }
  if (safe.length === 0) {
    write(out, 'fix-staged: no regular staged files to format');
    return 0;
  }

  if (expired()) return 1;
  /* Expand ONLY the internal safe-file token, then prepend format.argv VERBATIM. format.argv must
     never flow through token expansion: a `{files:<fileset>}` there (an unknown/empty fileset)
     would expand to zero args and let the appended staged path slide into argv[0] — the program to
     execute (BUG-07). Keeping format.argv literal guarantees argv[0] stays the configured formatter,
     never a staged file. expandArgv still guards the safe operands (option-like / glob-metachar) and
     runs BEFORE any mutation, so a throw here is safe. */
  const operands = expandArgv([`{files:${SAFE_TOKEN}}`], new Map([[SAFE_TOKEN, safe]]));
  const argv = [...format.argv, ...operands];
  const formatted = runProcess({ argv, cwd: root, timeoutMs: remaining() });
  if (formatted.kind !== 'ok') {
    rollback(safe, root, err);
    write(err, `fix-staged: formatter ${formatted.kind} (exit ${formatted.exitCode ?? '-'}); reverted. ${formatted.stderrTail}`);
    return 1;
  }

  // Everything from here mutates nothing more until `git add`, but the formatter has already edited
  // the working tree — so ANY failure (a bad operand, a throwing lstat like ENOTDIR/EACCES, a failed
  // re-stage) must roll those edits back. One boundary guarantees rollback on every throw.
  // ponytail: the gap between the stat check and `git add` is a sub-second window — an accepted
  // ceiling for a local pre-commit (lint-staged shares it).
  try {
    for (const file of safe) {
      const stat = lstatSync(join(root, file), { throwIfNoEntry: false });
      /* Re-check type AND link count AFTER formatting: a formatter that unlinked the operand and
         re-created it as a hardlink to an outside file leaves a REGULAR file (isFile() alone would
         pass) but with nlink > 1. nlink === 1 is the operative guard — a fresh nlink-1 inode (e.g. an
         atomic-rename writer) is unshared and therefore safe, so we deliberately do NOT also require
         inode identity, which would break such writers without adding safety. */
      if (stat === undefined || !stat.isFile() || stat.nlink !== 1) {
        rollback(safe, root, err);
        write(err, `fix-staged: formatter left ${file} missing, non-regular, or hardlinked; reverted`);
        return 1;
      }
    }
    if (remaining() <= 0) {
      rollback(safe, root, err);
      write(err, 'fix-staged: deadline exhausted before re-stage; reverted');
      return 1;
    }
    addPaths(safe, root, budget());
  } catch (error) {
    rollback(safe, root, err);
    const detail = error instanceof Error ? error.message : String(error);
    write(err, `fix-staged: verify/re-stage failed; reverted. ${detail}`);
    return 1;
  }

  const skipped = partial.length + nonRegular.length + hardlinked.length;
  const tail = skipped > 0 ? `, skipped ${skipped}` : '';
  /* The count is what the formatter was HANDED, not what it changed — every safe file is passed to
     `format.argv` and re-staged unconditionally. "formatted N file(s)" read as "N files were
     rewritten" and sent a reader hunting for a phantom reformat of an already-clean commit, so the
     line says what actually happened instead. */
  write(out, `fix-staged: ran the formatter over ${safe.length} staged file(s), re-staged${tail}`);
  return 0;
}
