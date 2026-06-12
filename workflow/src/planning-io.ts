// Shared mutating-verb EDGE for the state-mutating §6 verbs (transactions.ts) and
// `workflow resume` (resume.ts). Both run inside the §2.10 worktree mutex and both
// commit the planning file with a matching `Workflow-Phase` trailer, so they share
// the same injected seam shape and the same trivial git/fs edge helpers. Keeping
// these in ONE place keeps the divergence invariant's machinery (load/save round-
// trip, the planning-only commit shape, the entry divergence check) defined once.
//
// Honest boundary: only the genuinely identical logic lives here. recover.ts's
// RecoverDeps stays separate (it has no `now`/`claimedBy`/`lockSeams`-driven
// mutating-verb shape beyond the bits it already shares via computeDivergence), and
// resume's corrupt-state-aware load stays inline in resume.ts (it needs the
// CorruptStateError branch that the §6 verbs do not).

import { parseFrontMatter, serializeFrontMatter } from './front-matter.ts';
import type { FrontMatter } from './types.ts';
import { computeDivergence, splitPlanningFile } from './recover.ts';
import { assertOnlyPlanningStaged, planningRelPath } from './commit-scope.ts';
import type { RunGit } from './trailers.ts';
import type { LockSeams } from './lock.ts';

// The core seam shared by every mutating verb. TransactionDeps/ResumeDeps extend
// this with their task-specific additions (transactions' budget ceilings) so the
// shared edge helpers below operate against the common subset.
export interface MutatingDeps {
  planningFile: string;
  worktree: string;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  run: RunGit;
  lockSeams: LockSeams;
  now: () => number; // ms since epoch; drives `updated` (and per-verb time fields)
  claimedBy: string; // caller identity for the owner check / phase claim / waiver
}

export interface LoadedPlanning {
  fm: FrontMatter;
  body: string;
}

// Reads + parses the planning file (markdown front matter + body), reusing the
// recover.ts split so `serialize(fm) + body` round-trips the markdown.
export function loadPlanning(deps: MutatingDeps): LoadedPlanning {
  const text = deps.readFile(deps.planningFile);
  const { frontMatterText, body } = splitPlanningFile(text);
  return { fm: parseFrontMatter(frontMatterText), body };
}

// Writes the planning file back: serialized front matter + the preserved body.
export function savePlanning(deps: MutatingDeps, fm: FrontMatter, body: string): void {
  deps.writeFile(deps.planningFile, serializeFrontMatter(fm) + body);
}

// The front-matter subset accepts ONLY bare-second ISO-8601 UTC (`...:SSZ`, no
// milliseconds), so the millisecond field that toISOString always emits is
// stripped before it reaches the serializer.
export function nowIso(deps: MutatingDeps): string {
  return new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The entry divergence check (frozen contract): every mutating verb, after the
// lock, refuses when the runtime front matter diverges from HEAD's durable
// trailer, pointing the caller at `workflow recover`.
export function entryDivergence(deps: MutatingDeps): boolean {
  return computeDivergence({
    planningFile: deps.planningFile,
    worktree: deps.worktree,
    readFile: deps.readFile,
    run: deps.run,
  });
}

// Stages exactly the planning file and commits it (asserting the planning-only
// commit shape first). The message already carries its Workflow-Phase trailer.
export function commitPlanningFile(deps: MutatingDeps, message: string): void {
  const rel = planningRelPath(deps.worktree, deps.planningFile);
  deps.run(['add', '--', rel], deps.worktree);
  assertOnlyPlanningStaged(deps.worktree, rel, deps.run);
  deps.run(['commit', '-q', '-m', message], deps.worktree);
}
