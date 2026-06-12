// §6 commit-scope shape checks used by `complete` (Task 11.2). This is the
// MINIMAL set the locked transactions depend on now; the fuller adversarial
// battery (`staged-only-escape`, `never-git-add-A`, ...) is S12 Task 12.4, which
// EXTENDS these. Every staging step the transactions perform is fixed-argv
// `git add -- <path>` (NEVER `git add -A` / `git add .`), so untrusted state never
// reaches a shell and no foreign change is swept into a transition commit.
//
// Pure-ish over the injected git seam (RunGit): the functions read the index/
// working tree through `run` and never spawn git directly, so they are testable
// against real ephemeral repos.

import path from 'node:path';
import { EXIT_WRONG_STATE } from './types.ts';
import { LOCK_FILE_NAME } from './lock.ts';
import type { RunGit } from './trailers.ts';

// A transaction's commit would include changes outside its allowed scope (a
// foreign staged/dirty file, or an empty implement code commit). Carries
// EXIT_WRONG_STATE: it is a precondition refusal (the worktree is not in the
// shape the transition requires), the same family as a wrong-state gate refusal.
// `kind` is a cross-realm tag (a bundled copy can defeat `instanceof`), mirroring
// CorruptStateError / LockBusyError.
export class CommitScopeError extends Error {
  readonly kind = 'commit-scope' as const;
  readonly exitCode = EXIT_WRONG_STATE;
  constructor(message: string) {
    super(message);
    this.name = 'CommitScopeError';
    Object.setPrototypeOf(this, CommitScopeError.prototype);
  }
}

// NUL-delimited git output -> non-empty path list (paths with spaces/odd bytes
// stay intact; the trailing separator yields an empty token that is dropped).
function splitNul(out: string): string[] {
  return out.split('\0').filter((p) => p !== '');
}

// The planning file path relative to the worktree root (spec §3: the planning
// file lives at the worktree root). The single allowed pathspec for the planning
// commit, and the one path excluded from the implement code commit.
export function planningRelPath(worktree: string, planningFile: string): string {
  return path.relative(worktree, planningFile);
}

// True iff HEAD names a commit (a born branch). Used so the diff helpers degrade
// gracefully on the pre-first-commit window instead of throwing.
function headExists(worktree: string, run: RunGit): boolean {
  try {
    run(['rev-parse', '--verify', '--quiet', 'HEAD'], worktree);
    return true;
  } catch {
    return false;
  }
}

// Worktree-relative paths that differ between the index and HEAD — exactly what a
// plain `git commit` would record. On an unborn HEAD, `--cached` diffs against the
// empty tree, so freshly-staged paths still appear.
export function stagedPaths(worktree: string, run: RunGit): string[] {
  return splitNul(run(['diff', '--cached', '--name-only', '-z'], worktree));
}

// Worktree-relative paths of every change vs HEAD that is NOT `excludeRel`:
// tracked modifications/deletions (index or working tree, via `diff HEAD`) AND
// untracked files (via `ls-files --others`). This is the set the implement-plan
// CODE commit stages — enumerated and added ONE path at a time by the caller,
// never via `git add -A` / `.`. Deterministic order (sorted, de-duplicated).
export function worktreeChangesExcept(
  worktree: string,
  excludeRel: string,
  run: RunGit,
): string[] {
  const tracked = headExists(worktree, run)
    ? splitNul(run(['diff', '--name-only', '-z', 'HEAD'], worktree))
    : [];
  const untracked = splitNul(run(['ls-files', '--others', '--exclude-standard', '-z'], worktree));
  const set = new Set<string>([...tracked, ...untracked]);
  set.delete(excludeRel);
  // The workflow's own advisory lockfile is held DURING the transaction (it is an
  // untracked file at the worktree root); it must never ride a code commit.
  set.delete(LOCK_FILE_NAME);
  return [...set].sort();
}

// CHECK A — the planning-only commit shape (plan / review-plan / consolidate /
// review-implementation `complete`, and every `start` / `request-changes`): after
// the caller stages the planning file, the staged set must be EXACTLY the planning
// file. A foreign staged change would be folded into the trailered transition
// commit (corrupting the "this commit IS this transition" contract), so it is
// refused.
export function assertOnlyPlanningStaged(
  worktree: string,
  planningRel: string,
  run: RunGit,
): void {
  const staged = stagedPaths(worktree, run);
  if (staged.length !== 1 || staged[0] !== planningRel) {
    const found = staged.length === 0 ? '(none)' : staged.join(', ');
    throw new CommitScopeError(
      `transition commit must contain exactly the planning file "${planningRel}", but the staged set is: ${found}`,
    );
  }
}

// CHECK B — the implement-plan two-commit shape: the CODE commit (commit 1) must
// carry the implementation and must not be empty (an empty code commit is not the
// shape, and `complete_sha` must anchor on real work). The planning file is kept
// out of this set by `worktreeChangesExcept`, so the trailer lives only on the
// later planning commit (commit 2). S12 (Task 12.4) extends this with the staged-
// only-escape / git-add-A adversarial checks.
export function assertCodeCommitShape(codePaths: string[]): void {
  if (codePaths.length === 0) {
    throw new CommitScopeError(
      'the implement-plan code commit has no implementation changes to record (the code commit would be empty)',
    );
  }
}
