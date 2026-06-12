// §6 (spec) recovery: `workflow recover` reconciles the runtime planning-file
// front matter to HEAD's durable `Workflow-Phase` trailer, ONE-DIRECTIONALLY —
// the trailer wins. recover is the durable record's repair path for the one
// failure the two-role authority admits: the trailer commit landed but the
// front-matter "record write" that advances the runtime `state` was lost (a kill
// between the two). It rewrites ONLY the front-matter `state` and NEVER touches
// git history: an untrailed implementation (code) commit is durable work that is
// never rolled back, and recover never reverts commits — it only edits the file.
//
// This is a STATE-MUTATING command, so it runs inside `withLock` (the §2.10
// worktree mutex). It is pure-ish over injected seams (readFile/writeFile/runGit/
// lockSeams) so it is unit-testable; the CLI edge wires the real implementations.
//
// recover v1 reconciles `state` only. It deliberately does NOT synthesize the
// per-phase `complete_sha`: in the two-commit implement shape that anchor is the
// CODE commit (not HEAD, which is the trailer commit), so it cannot be derived
// from the durable trailer — restoring it is out of scope for trailer-based
// reconcile and left to a later doctor pass.

import path from 'node:path';
import { parseFrontMatter, serializeFrontMatter } from './front-matter.ts';
import { withLock } from './lock.ts';
import type { LockSeams } from './lock.ts';
import { diverges, readHeadWorkflowPhase } from './trailers.ts';
import type { RunGit } from './trailers.ts';
import type { WorkflowState } from './types.ts';

// ── Planning-file splitting ──────────────────────────────────────────────────

// A real planning file is markdown: a fenced YAML front-matter block followed by
// the Plan body. Splits the leading `---...---` fence pair from the trailing body
// so recover can rewrite the front matter in place and re-attach the body byte
// for byte. When no well-formed fence pair is found, the whole text is returned
// as the front-matter half so the parser yields the canonical corrupt-state error.
export interface SplitPlanningFile {
  frontMatterText: string;
  body: string;
}

export function splitPlanningFile(text: string): SplitPlanningFile {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { frontMatterText: text, body: '' };
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      // `slice(0, i+1).join + '\n'` reproduces exactly what serializeFrontMatter
      // emits, so `serialize + body` round-trips the original file.
      const frontMatterText = `${lines.slice(0, i + 1).join('\n')}\n`;
      const body = lines.slice(i + 1).join('\n');
      return { frontMatterText, body };
    }
  }
  return { frontMatterText: text, body: '' };
}

// ── Divergence (file-aware, for the gate seam) ───────────────────────────────

export interface DivergenceDeps {
  planningFile: string;
  worktree: string;
  readFile: (filePath: string) => string;
  run: RunGit;
}

// The real divergence check the CLI layer wires into the gate's injected
// `checkDivergence()` seam (the file-reading gate command wiring is a later task;
// here the function is exposed and tested). Reads the runtime front-matter state
// and HEAD's durable trailer and applies the pure `diverges` predicate. A corrupt
// planning file raises CorruptStateError (a separate needs-human path the caller
// maps); it is not silently treated as "no divergence".
export function computeDivergence(deps: DivergenceDeps): boolean {
  const text = deps.readFile(deps.planningFile);
  const { frontMatterText } = splitPlanningFile(text);
  const fm = parseFrontMatter(frontMatterText);
  const headTrailer = readHeadWorkflowPhase(deps.worktree, deps.run);
  return diverges(fm.state, headTrailer);
}

// ── recover ──────────────────────────────────────────────────────────────────

export interface RecoverDeps {
  planningFile: string;
  worktree: string;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  run: RunGit;
  lockSeams: LockSeams;
}

export interface RecoverResult {
  changed: boolean;
  fromState: WorkflowState;
  toState: WorkflowState;
  headTrailer: WorkflowState | null;
}

// The reconcile body. Reads the runtime front matter and HEAD's durable trailer;
// when they diverge it rewrites ONLY the front-matter `state` to the trailer's
// value (trailer wins), re-validates the reconciled document, and writes it back
// with the markdown body preserved. A null trailer (no durable record yet) or an
// already-consistent file is a no-op. Never invokes git mutation — purely a file
// edit. Raises CorruptStateError up to the caller for a structurally corrupt file
// (recover v1 reconciles state from the trailer; it does not rebuild broken YAML).
function reconcile(deps: RecoverDeps): RecoverResult {
  const text = deps.readFile(deps.planningFile);
  const { frontMatterText, body } = splitPlanningFile(text);
  const fm = parseFrontMatter(frontMatterText);
  const headTrailer = readHeadWorkflowPhase(deps.worktree, deps.run);

  if (headTrailer === null || headTrailer === fm.state) {
    return { changed: false, fromState: fm.state, toState: fm.state, headTrailer };
  }

  const fromState = fm.state;
  fm.state = headTrailer;
  const serialized = serializeFrontMatter(fm);
  // Defense in depth: re-validate the reconciled front matter before persisting.
  parseFrontMatter(serialized);
  deps.writeFile(deps.planningFile, serialized + body);
  return { changed: true, fromState, toState: headTrailer, headTrailer };
}

// recover entry: runs the reconcile inside the worktree mutex (§2.10). The lock
// is released on both the success and throw paths (withLock's finally). A corrupt
// planning file raises CorruptStateError up to the CLI edge, which maps it to
// EXIT_NEEDS_HUMAN (recover v1 does not rebuild structurally broken YAML).
export function recover(deps: RecoverDeps): RecoverResult {
  return withLock(deps.worktree, deps.lockSeams, () => reconcile(deps));
}

// Resolves the worktree root for a planning file at the worktree root (spec §3).
export function worktreeOf(planningFile: string): string {
  return path.dirname(planningFile);
}
