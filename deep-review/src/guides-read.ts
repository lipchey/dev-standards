/* The guides-read gate core (ADR-016). A deep-review-refactor pass must not conclude
   until its transcript proves every mandated review guide was actually opened with a
   successful Read. This module is pure and dependency-injected; the IO edge (hook
   stdin, the transcript file, the marker file, process exit) lives in cli.ts.

   Two hard invariants, both fail-CLOSED once a pass is active:
   - the required set is anchored on the SUBMODULE guide templates + repo overlay +
     configured project reads; if that set cannot be established (broken deployment,
     unreadable overlay dir, a configured read that does not exist) the gate BLOCKS
     rather than guessing the pass is clean;
   - read-proof is a genuine successful Read (transcript.ts), matched to a required
     path by repo-relative TAIL so a worktree root and the main checkout — which carry
     the same guide under different absolute prefixes — both satisfy it. */

import path from 'node:path';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import {
  loadReviewGuides,
  REVIEW_CONTRACT_TEMPLATE_NAME,
  REVIEW_GUIDE_TEMPLATES_DIR,
} from './guides.ts';
import type { ReviewGuideLoadOutcome } from './guides.ts';
import type { DeepReviewConfig } from './config.ts';
import { parseTranscript } from './transcript.ts';
import type { TranscriptReadEvent } from './transcript.ts';

/* The harness stamps this exact value on assistant lines while the skill is active
   (transcript.ts reads it). It is the model-INDEPENDENT activation signal. */
export const DEEP_REVIEW_ATTRIBUTION_SKILL = 'deep-review-refactor';

/* The MAIN-session anchor read set (ADR-016, amended 2026-07-16): only the corpus
   CONTRACT file is a main-session required read. The eight profile lens bodies are
   profile-route reads (each fan-out worker reads its assigned profile; a main-hosted
   fallback / fix-mode self-review reads the profiles its role needs) — the gate no
   longer forces all eight into every main session, which was context bloat once the
   fan-out became mandatory. Overlay AVAILABILITY stays fail-closed for ALL overlays
   (guides.ts), and the full nine-file corpus stays a loadReviewGuides deployment check;
   only the main-session READ-PROOF requirement shrinks to this anchor. */
const MAIN_SESSION_REQUIRED_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  REVIEW_CONTRACT_TEMPLATE_NAME,
]);

/* The required set could not be established: a broken deployment (guide templates
   missing/blank), an overlay directory that exists but is unreadable, or a configured
   required_read that does not exist. The gate maps this to BLOCK — never silent-allow —
   because an un-establishable policy set is indistinguishable from a bypass attempt. */
export class GuidesUnavailable extends Error {
  readonly kind = 'guides-unavailable' as const;
  constructor(reason: string) {
    super(reason);
    this.name = 'GuidesUnavailable';
    Object.setPrototypeOf(this, GuidesUnavailable.prototype);
  }
}

export interface RequiredReadSetDeps {
  /* Defaults resolve to the real submodule templates / repo fs; tests inject fakes so
     the anchor prefix stays inside the test root (see requiredReadSet). */
  templatesDir?: string;
  loadGuides?: (overlayDirectory: string) => ReviewGuideLoadOutcome;
  exists?: (absolutePath: string) => boolean;
  /* Read-proof matching in computeMissing (via evaluateGuidesRead) realpaths reads + roots;
     defaults to fs.realpathSync. requiredReadSet's confinement no longer uses it (it rejects
     any symlink component outright, so no path is resolved through a symlink). */
  realpath?: (absolutePath: string) => string;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}

/* The last two segments of the templates directory (e.g. `agents/review-guide-templates`).
   A template's anchor tail is this prefix + its filename, so a consumer read of
   `vendor/dev-standards/agents/review-guide-templates/<name>` and a dev-standards-self read
   of `agents/review-guide-templates/<name>` both suffix-match — without hard-coding either
   absolute root. */
function templateAnchorPrefix(templatesDir: string): string {
  return path.posix.join(path.basename(path.dirname(templatesDir)), path.basename(templatesDir));
}

/* True iff `candidate` is `root` itself or lives inside it. Boundary-AWARE (segment split,
   not a raw `startsWith('..')`): a sibling dir literally named `..reviews` resolves to a
   `..reviews` relative that a naive prefix test would wrongly reject as an escape. */
function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/* A repo-relative POSIX tail for an absolute path inside `cwd`. Throws GuidesUnavailable
   when the path escapes the repo, so an escaping tail can never mis-anchor the match. */
function repoRelativeTail(cwd: string, absolutePath: string): string {
  if (!isWithinRoot(cwd, absolutePath)) {
    throw new GuidesUnavailable(`guide path "${absolutePath}" resolves outside the repo root "${cwd}"`);
  }
  return path.relative(cwd, absolutePath).split(path.sep).join('/');
}

/* Every repo-relative anchor tail this pass must have READ (ADR-016, 2026-07-16 rescope):
   ONLY the ANCHOR template `review-contract.md` and its same-named overlay, plus every
   configured project read (fails closed when the file does not exist). The other eight
   profile templates and non-anchor overlays are NOT required reads here — they are still
   LOADED for the corpus-availability check (loadGuides below fails closed on a missing/blank
   template or a listed-but-unreadable overlay), but read-proof for them is a profile-route
   concern, not a main-session gate obligation. Availability is enforced for ALL; read-proof
   only for the anchor. */
export function requiredReadSet(
  cwd: string,
  config: DeepReviewConfig,
  deps: RequiredReadSetDeps = {},
): string[] {
  const templatesDir = deps.templatesDir ?? REVIEW_GUIDE_TEMPLATES_DIR;
  /* Confine the overlay up front (shared with fix-mode preflight via assertGuidesDirConfined,
     so neither gate is weaker than the other) so a guides_dir that escapes the repo — or is
     reached through a symlink — fails closed even when that dir is EMPTY or MISSING; otherwise
     it loads to no overlay and the pass falls through to allow. */
  const overlayDirectory = assertGuidesDirConfined(cwd, config.guidesDir);
  const loadGuides = deps.loadGuides ?? ((overlay: string) => loadReviewGuides(overlay, { templatesDir }));
  const exists = deps.exists ?? existsSync;

  const outcome = loadGuides(overlayDirectory);
  if (!outcome.ok) {
    throw new GuidesUnavailable(
      outcome.reason ?? `canonical guide templates unavailable: ${outcome.templatesDir}`,
    );
  }
  const anchorPrefix = templateAnchorPrefix(templatesDir);
  const tails = new Set<string>();
  for (const guide of outcome.guides) {
    for (const source of guide.sources) {
      /* Only the anchor (review-contract.md) is a main-session required READ; the profile
         bodies are profile-route reads, still LOADED for the corpus availability check but
         not gated on the main transcript. Both the package template AND — when the consumer
         overlays it — the repo-overlay copy of the anchor are required, derived from the
         loader's OWN returned sources: one authoritative snapshot, never a second directory
         listing that could disagree under a filesystem race. */
      if (!MAIN_SESSION_REQUIRED_TEMPLATE_NAMES.has(path.basename(source.path))) continue;
      if (source.kind === 'package-template') {
        tails.add(path.posix.join(anchorPrefix, path.basename(source.path)));
      } else {
        tails.add(repoRelativeTail(cwd, source.path));
      }
    }
  }

  for (const requiredRead of config.requiredReads) {
    const absolute = path.resolve(cwd, requiredRead);
    if (!exists(absolute)) {
      throw new GuidesUnavailable(
        `configured required_read "${requiredRead}" does not exist under "${cwd}"`,
      );
    }
    tails.add(requiredRead.split(path.sep).join('/'));
  }

  return [...tails];
}

/* The dev-standards submodule always vendors at this repo-relative path (the adoption
   convention; also the `vendor/**` no-touch anchor), so a consumer's template read is
   `<root>/vendor/dev-standards/<tail>` while a dev-standards-self read is `<root>/<tail>`.
   These are the ONLY two legit anchors for a mandated read — a same-named decoy at any other
   depth is rejected. */
const SUBMODULE_REPO_PREFIX = 'vendor/dev-standards';

export interface ComputeMissingInput {
  requiredTails: string[];
  reads: TranscriptReadEvent[];
  /* The repo checkouts a read may legitimately live under (the pass cwd plus any linked
     worktree sharing this repo). A read outside all of them is discarded BEFORE matching. */
  approvedRoots: string[];
  realpath?: (absolutePath: string) => string;
}

/* Every root-relative POSIX path a successful read resolves to, under each approved root it
   lives in. Reads and roots are realpath'd so a `/tmp`↔`/private/tmp` or symlinked prefix
   cannot hide a genuine read; a read (or root) whose realpath FAILS is dropped as non-proof —
   a mandated guide is a committed repo file present at Stop time, so an unresolvable path
   cannot prove one was read (fail-closed, never a raw-path fallback that a since-deleted
   symlinked-outside read could ride back in on). */
function readRepoRelativePaths(
  input: ComputeMissingInput,
  realpath: (absolutePath: string) => string,
): Set<string> {
  const roots: string[] = [];
  for (const root of input.approvedRoots) {
    const resolved = realpathOrUndefined(realpath, root);
    if (resolved !== undefined) roots.push(resolved);
  }
  const relPaths = new Set<string>();
  for (const read of input.reads) {
    if (!read.ok) continue;
    const resolved = realpathOrUndefined(realpath, read.path);
    if (resolved === undefined) continue;
    for (const root of roots) {
      if (isWithinRoot(root, resolved)) {
        relPaths.add(path.relative(root, resolved).split(path.sep).join('/'));
      }
    }
  }
  return relPaths;
}

/* The required tails NOT covered by any successful read. A tail is satisfied ONLY by an EXACT
   root-relative match at one of the two legit anchors (the checkout root, or the vendored
   submodule under it) — never a segment-suffix, so a same-named decoy at another depth
   (`<root>/decoy/agents/review-guide-templates/security-review.md`) cannot count. */
export function computeMissing(input: ComputeMissingInput): string[] {
  const realpath = input.realpath ?? realpathSync;
  const readRelPaths = readRepoRelativePaths(input, realpath);
  return input.requiredTails.filter(
    (tail) => !readRelPaths.has(tail) && !readRelPaths.has(`${SUBMODULE_REPO_PREFIX}/${tail}`),
  );
}

function realpathOrUndefined(
  realpath: (absolutePath: string) => string,
  candidate: string,
): string | undefined {
  try {
    return realpath(candidate);
  } catch {
    return undefined;
  }
}

/* Reject any SYMLINK among the repo-relative path components of `guides_dir`, fail-CLOSED.
   A symlinked guides_dir (or ancestor) is REFUSED, not followed, because it breaks two things
   at once: (1) the required-read tail is computed lexically (requiredReadSet) while read-proof
   is realpath-matched (computeMissing) — a symlinked dir realpaths the reviewer's Read to a
   different path than the required tail, so the anchor overlay can never be proven read and the
   Stop-gate blocks forever; and (2) a DANGLING symlink component otherwise ENOENTs the whole
   path so the overlay reads as "absent" and its rules silently vanish (a fail-open). Walk from
   just below cwd to the leaf: a symlink component throws; a genuinely-absent component (ENOENT,
   not a symlink) ends the walk (a missing optional overlay is fine); every other lstat errno
   fails closed (never degrade to "absent"). */
function assertNoSymlinkComponent(cwd: string, guidesDir: string, overlayDirectory: string): void {
  const relative = path.relative(cwd, overlayDirectory);
  if (relative === '' || relative === '.') return;
  let current = cwd;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      const detail = error instanceof Error ? error.message : String(error);
      throw new GuidesUnavailable(
        `deep_review.guides_dir component "${current}" could not be examined: ${detail}`,
      );
    }
    if (isSymlink) {
      throw new GuidesUnavailable(
        `deep_review.guides_dir "${guidesDir}" must be a real directory, not a symlink (at "${current}")`,
      );
    }
  }
}

/* Confine `guides_dir` to the repo, fail-CLOSED, and return the resolved overlay dir. Shared by
   fix-mode preflight (runPreflight) and the Stop-gate (requiredReadSet) so neither is weaker:
   the pre-hardening preflight confined LEXICALLY only, letting an in-repo guides_dir symlinked
   OUTSIDE the repo pass the file-editing verb while the gate rejected it. Two layers: (1) a
   LEXICAL escape (`../`, absolute); (2) any SYMLINK component (assertNoSymlinkComponent), which
   subsumes symlink-escape, in-repo-symlink (unprovable-overlay), and dangling-ancestor cases. */
export function assertGuidesDirConfined(cwd: string, guidesDir: string): string {
  const overlayDirectory = path.resolve(cwd, guidesDir);
  if (!isWithinRoot(cwd, overlayDirectory)) {
    throw new GuidesUnavailable(
      `deep_review.guides_dir "${guidesDir}" resolves outside the repo root "${cwd}"`,
    );
  }
  assertNoSymlinkComponent(cwd, guidesDir, overlayDirectory);
  return overlayDirectory;
}

export type GuidesReadDecision =
  | { kind: 'allow' }
  | { kind: 'skip' }
  | { kind: 'block'; reason: string };

export interface EvaluateGuidesReadInput {
  /* undefined = the transcript file could not be read (an operational failure). */
  transcriptText: string | undefined;
  markerPresent: boolean;
  cwd: string;
  /* Lazy so a non-active session never touches quality.json (an O(1) skip), and a
     config that fails to load WHILE active fails closed like any other op-failure. */
  loadConfig: () => DeepReviewConfig;
  deps?: RequiredReadSetDeps & {
    realpath?: (absolutePath: string) => string;
    /* Repo checkouts a guide read may live under; defaults to [cwd]. cli.ts adds any linked
       worktree so a read from the review's worktree (not the main checkout) still counts. */
    approvedRoots?: string[];
  };
}

/* The whole gate decision, pure. Activation is fail-closed: a pass is active if the
   deterministic marker is present OR the harness stamped the skill attribution in a
   readable transcript. Once active, an unreadable transcript, an un-loadable config, an
   un-establishable required set, or any uncovered guide all BLOCK. A non-active session
   SKIPs (allow). */
export function evaluateGuidesRead(input: EvaluateGuidesReadInput): GuidesReadDecision {
  const text = input.transcriptText;
  /* Cheap necessary-condition filter, run at EVERY session end: the harness attribution
     cannot be present unless the skill id appears literally, so a marker-less transcript
     without the substring is definitely not a review — skip before parsing a possibly
     multi-MB transcript. A false positive (the id merely mentioned in prose) only costs a
     full parse that then finds no real attribution and skips anyway. */
  if (!input.markerPresent && (text === undefined || !text.includes(DEEP_REVIEW_ATTRIBUTION_SKILL))) {
    return { kind: 'skip' };
  }
  const parsed = text === undefined ? undefined : parseTranscript(text);
  const attributed = parsed?.attributionSkills.has(DEEP_REVIEW_ATTRIBUTION_SKILL) ?? false;
  const active = input.markerPresent || attributed;
  if (!active) return { kind: 'skip' };

  if (parsed === undefined) {
    return {
      kind: 'block',
      reason:
        'deep-review is active but its transcript could not be read, so guide reads cannot be verified; retry, or set DEEP_REVIEW_GUARD_OFF=1 to override',
    };
  }

  let config: DeepReviewConfig;
  try {
    config = input.loadConfig();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: 'block',
      reason: `deep-review is active but quality.json could not be loaded (${detail}); fix it or set DEEP_REVIEW_GUARD_OFF=1 to override`,
    };
  }

  let requiredTails: string[];
  try {
    requiredTails = requiredReadSet(input.cwd, config, input.deps);
  } catch (error) {
    if (error instanceof GuidesUnavailable) return { kind: 'block', reason: error.message };
    throw error;
  }

  const realpath = input.deps?.realpath;
  const approvedRoots = input.deps?.approvedRoots ?? [input.cwd];
  const missing = computeMissing({
    requiredTails,
    reads: parsed.reads,
    approvedRoots,
    ...(realpath !== undefined ? { realpath } : {}),
  });
  if (missing.length === 0) return { kind: 'allow' };
  return {
    kind: 'block',
    reason: `deep-review must Read every mandated guide before concluding; not yet read: ${missing.join(', ')}`,
  };
}
