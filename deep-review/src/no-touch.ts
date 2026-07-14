// No-touch matcher (§2.5): the skill-owned FLOOR of paths the deep-review engine
// must never auto-edit. A repo may EXTEND this floor via its project-facts
// "## No-Touch Zones" section, but can NEVER shrink it — the result is always
// BASELINE ∪ repo-additions (union-only, extend-only, fail-safe: over-protecting
// is safe, under-protecting is dangerous). The path test REUSES the runner's
// manifest glob dialect (`matches`) rather than re-implementing globbing.

import path from 'node:path';
import { matches } from '../../runner/src/glob.ts';

// §2.5 baseline floor. Directory entries are normalized to `<dir>/**`; `./verify`
// is the repo-relative literal `verify`. Every repo inherits this set; it can
// only grow, never shrink.
export const NO_TOUCH_BASELINE = [
  '.githooks/**',
  '.github/workflows/**',
  'verify',
  'tools/**',
  'auth/**',
  'credentials/**',
] as const;

/* The default must match the instance-doc location created by the onboarding seeder. */
const DEFAULT_NO_TOUCH_GLOBS_REF = '.claude/project-facts.md';
const NO_TOUCH_HEADING = '## No-Touch Zones';

// A missing/unreadable/unparseable no_touch_globs_ref in 'fix' mode, or a ref
// that resolves outside repoRootAbs in EITHER mode. Carries the offending ref
// path and a human-readable reason; consumed upstream (E7/W4) to map onto the
// EXIT_PREFLIGHT exit family instead of silently mutating the repo on a set
// the engine could not fully trust.
export class NoTouchSourceError extends Error {
  readonly kind = 'no-touch-source-error' as const;
  readonly path: string;
  readonly reason: string;
  constructor(refPath: string, reason: string) {
    super(`no-touch source "${refPath}": ${reason}`);
    this.name = 'NoTouchSourceError';
    this.path = refPath;
    this.reason = reason;
    Object.setPrototypeOf(this, NoTouchSourceError.prototype);
  }
}

export interface BuildNoTouchSetDeps {
  /* The optional manifest field may carry a heading fragment; omitted and empty
     values must resolve to the same seeded project-facts instance. */
  noTouchGlobsRef?: string | undefined;
  /* The configured verify shim (deep_review.verify_entry, default `verify`). Added to the
     baseline floor in EVERY mode so a relocated shim gets the same protection as the literal
     `verify` baseline entry (see buildNoTouchSet). Omitted by legacy callers -> baseline only. */
  verifyEntry?: string | undefined;
  /* Injected file read (the caller resolves repo-relative -> absolute). A throw
     (missing/unreadable) is caught: downgraded to the baseline alone in
     'review-only' mode, re-thrown as NoTouchSourceError in 'fix' mode. */
  readFile: (filePath: string) => string;
  /* Warn sink for a missing/unreadable/unparseable ref in 'review-only' mode;
     unused in 'fix' mode, where the same condition throws instead. */
  warn: (message: string) => void;
  /* 'review-only' (default): warn + baseline fallback on a missing/unreadable/
     unparseable facts file, matching the legacy behavior below. 'fix': the same
     condition throws NoTouchSourceError -- a silent baseline-only fallback is
     unsafe once the caller is about to mutate the repo on the strength of this
     set. */
  mode?: 'review-only' | 'fix';
  /* Realpath'd repo root, paired with `realpath` to confine no_touch_globs_ref
     inside the repo in EITHER mode -- an escaping ref (a `../` operand, or a
     symlinked ancestor) throws NoTouchSourceError regardless of `mode`.
     Omitting either skips the confinement check (legacy callers that predate
     this contract). */
  repoRootAbs?: string;
  realpath?: (p: string) => string;
}

// Extracts the glob tokens from the `## No-Touch Zones` section of a project-facts
// markdown body. ONLY list-item lines (trimmed form starts with `- `) are parsed;
// all prose is ignored, so a sentence mentioning backticked globs adds nothing.
// Parsing stops at the next level-1/2 heading. Backticks are stripped from each
// extracted glob.
export function parseNoTouchAdditions(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === NO_TOUCH_HEADING);
  if (start === -1) return [];

  const globs: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (/^#{1,2} /.test(trimmed)) break; // the next level-1/2 heading ends the section
    if (!trimmed.startsWith('- ')) continue; // prose / blank lines contribute nothing
    globs.push(...extractGlobsFromBullet(trimmed));
  }
  return globs;
}

// Pulls glob token(s) from a single `- ` bullet. Prefers backtick-delimited code
// spans (the documented convention); falls back to the first whitespace-delimited
// token when a bullet has none. Over-extraction is fail-safe (it only widens the
// no-touch floor), so every backticked span in the bullet is taken.
function extractGlobsFromBullet(bullet: string): string[] {
  const body = bullet.slice(2).trim(); // drop the leading "- "
  const backticked = [...body.matchAll(/`([^`]+)`/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((g) => g.length > 0);
  if (backticked.length > 0) return backticked;
  const first = body.split(/\s+/)[0];
  return first ? [stripBackticks(first)] : [];
}

function stripBackticks(token: string): string {
  return token.replace(/^`+|`+$/g, '');
}

// Strips a `#fragment` suffix (which only names the target heading) so the value
// resolves to a filesystem path.
function stripFragment(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(0, hash);
}

/* True iff `candidate` resolves inside `root`. path.relative-based (mirrors the
   runner report writer's confinement idiom in runner/src/report.ts) rather than
   a startsWith prefix check, which a sibling directory sharing the root's
   string prefix (e.g. root `/a/b` vs candidate `/a/bc`) would defeat. */
function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/* Realpath the DEEPEST EXISTING ANCESTOR of `target` (the leaf may not exist yet),
   mirroring writeConfined's `realpathOfDeepestExisting` in runner/src/report.ts: a
   symlinked ancestor escapes even when the final path is absent. Returns undefined when
   nothing up the chain resolves (realpath throws all the way to the filesystem root) —
   that is NOT an escape, just a fully-missing ref, handled by the caller. */
function realpathOfDeepestExisting(realpath: (p: string) => string, target: string): string | undefined {
  let current = target;
  for (;;) {
    try {
      return realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/* BASELINE ∪ repo additions, de-duplicated, order-stable (baseline first).
 * 'review-only' mode (default): a missing/unreadable/unparseable ref file
 * warns and yields the baseline alone -- union-only, extend-only, never
 * subtracts a baseline glob. 'fix' mode: the same condition throws
 * NoTouchSourceError instead of falling back silently. A ref that resolves
 * outside repoRootAbs throws NoTouchSourceError in EITHER mode. */
export function buildNoTouchSet(deps: BuildNoTouchSetDeps): string[] {
  const set = new Set<string>(NO_TOUCH_BASELINE);
  // The configured verify shim is the engine's own gate; protect it in EVERY mode like the
  // baseline `verify` literal — so a relocated shim (e.g. scripts/verify) can neither be
  // classified fixable-now (which would deadlock handoff on a pending it can never commit) nor
  // rewritten by a slice to `exit 0` and self-approve. Default `verify` is already in the
  // baseline (deduped). Added to the seed so the review-only read-failure early return covers it.
  if (deps.verifyEntry !== undefined) set.add(canonicalizeRef(deps.verifyEntry));
  const mode = deps.mode ?? 'review-only';

  const ref =
    deps.noTouchGlobsRef && deps.noTouchGlobsRef.length > 0
      ? deps.noTouchGlobsRef
      : DEFAULT_NO_TOUCH_GLOBS_REF;
  const refPath = stripFragment(ref);

  /* Fix mode is the fail-closed path: silently skipping confinement because a
     caller forgot to thread repoRootAbs/realpath would reopen the very hole
     this mode exists to close. Optional deps are a review-only affordance. */
  if (mode === 'fix' && (deps.repoRootAbs === undefined || deps.realpath === undefined)) {
    throw new NoTouchSourceError(
      refPath,
      'fix mode requires repoRootAbs and realpath deps for ref confinement',
    );
  }

  /* Confinement runs whenever a root is supplied, in BOTH modes: an escaping
     ref is a hazard regardless of whether the caller only intends to read it.
     repoRootAbs is already realpath'd by the caller (see the dep contract). */
  const { repoRootAbs, realpath } = deps;
  if (repoRootAbs !== undefined && realpath !== undefined) {
    const absRefPath = path.resolve(repoRootAbs, refPath);
    /* G7 (a) LEXICAL containment FIRST — a `../` escape is rejected in BOTH modes
       INDEPENDENT of whether the target exists, so a missing `../escape.md` cannot slip
       past as a plain read failure and land in the mode-gated baseline fallback. */
    if (!isWithinRoot(repoRootAbs, absRefPath)) {
      throw new NoTouchSourceError(refPath, 'no_touch_globs_ref resolves outside the repo root');
    }
    /* G7 (b) SYMLINK escape — realpath the deepest EXISTING ancestor (the leaf may not
       exist yet), the runner/src/report.ts confinement pattern. A symlinked ancestor
       pointing out of the repo escapes even when the leaf is absent; a ref whose ancestors
       do not resolve at all (undefined) is NOT an escape -- it falls through to the
       mode-gated missing/unreadable handling below, like every other read failure. */
    const realRefPath = realpathOfDeepestExisting(realpath, absRefPath);
    if (realRefPath !== undefined && !isWithinRoot(repoRootAbs, realRefPath)) {
      throw new NoTouchSourceError(refPath, 'no_touch_globs_ref resolves outside the repo root (symlink escape)');
    }
  }

  let markdown: string;
  try {
    markdown = deps.readFile(refPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (mode === 'fix') {
      throw new NoTouchSourceError(refPath, `could not read (${detail})`);
    }
    deps.warn(`no-touch: could not read "${refPath}" (${detail}); using baseline only`);
    return [...set];
  }

  for (const glob of parseNoTouchAdditions(markdown)) set.add(glob);
  return [...set];
}

/* §F4 protects both policy inputs in fix mode; otherwise one slice could remove
   a no-touch zone and a later slice could edit the newly exposed path. G2
   canonicalization is required so spellings such as
   `./.claude/project-facts.md` and `docs/../.claude/project-facts.md` still
   protect the canonical `.claude/project-facts.md` slice path. */
export function selfProtectedPaths(noTouchGlobsRef?: string): string[] {
  const ref =
    noTouchGlobsRef && noTouchGlobsRef.length > 0 ? noTouchGlobsRef : DEFAULT_NO_TOUCH_GLOBS_REF;
  return ['quality.json', canonicalizeRef(stripFragment(ref))];
}

// A canonical repo-relative slash-path: `.`/`..` segments collapsed and a leading `./`
// dropped, so the value matches a slice path built from the same canonicalization.
function canonicalizeRef(refPath: string): string {
  const normalized = path.posix.normalize(refPath);
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

// True iff `relPath` matches ANY pattern in the set under the runner's manifest
// glob dialect.
export function isNoTouch(relPath: string, set: readonly string[]): boolean {
  return set.some((pattern) => matches(relPath, pattern));
}
