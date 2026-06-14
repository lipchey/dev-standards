// No-touch matcher (§2.5): the skill-owned FLOOR of paths the deep-review engine
// must never auto-edit. A repo may EXTEND this floor via its project-facts
// "## No-Touch Zones" section, but can NEVER shrink it — the result is always
// BASELINE ∪ repo-additions (union-only, extend-only, fail-safe: over-protecting
// is safe, under-protecting is dangerous). The path test REUSES the runner's
// manifest glob dialect (`matches`) rather than re-implementing globbing.

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

// Default location of a repo's No-Touch Zones extension list.
const DEFAULT_NO_TOUCH_GLOBS_REF = '.agents/project-facts.md';
const NO_TOUCH_HEADING = '## No-Touch Zones';

export interface BuildNoTouchSetDeps {
  // Repo-relative ref to the project-facts file; may carry a `#fragment` naming
  // the target heading (stripped before the path is resolved). Defaults to
  // `.agents/project-facts.md` when omitted/empty/undefined (the manifest field
  // is optional, so an explicit `undefined` is accepted under
  // exactOptionalPropertyTypes).
  noTouchGlobsRef?: string | undefined;
  // Injected file read (the caller resolves repo-relative -> absolute). A throw
  // (missing/unreadable) is caught and downgraded to the baseline alone.
  readFile: (filePath: string) => string;
  // Warn sink for a missing/unreadable ref; the build never throws to the caller.
  warn: (message: string) => void;
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

// BASELINE ∪ repo additions, de-duplicated, order-stable (baseline first). A
// missing/unreadable ref file warns and yields the baseline alone — it NEVER
// crashes and NEVER subtracts a baseline glob (union-only, extend-only).
export function buildNoTouchSet(deps: BuildNoTouchSetDeps): string[] {
  const set = new Set<string>(NO_TOUCH_BASELINE);

  const ref =
    deps.noTouchGlobsRef && deps.noTouchGlobsRef.length > 0
      ? deps.noTouchGlobsRef
      : DEFAULT_NO_TOUCH_GLOBS_REF;
  const refPath = stripFragment(ref);

  let markdown: string;
  try {
    markdown = deps.readFile(refPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.warn(`no-touch: could not read "${refPath}" (${detail}); using baseline only`);
    return [...set];
  }

  for (const glob of parseNoTouchAdditions(markdown)) set.add(glob);
  return [...set];
}

// True iff `relPath` matches ANY pattern in the set under the runner's manifest
// glob dialect.
export function isNoTouch(relPath: string, set: readonly string[]): boolean {
  return set.some((pattern) => matches(relPath, pattern));
}
