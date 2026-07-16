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
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import {
  loadReviewGuides,
  NON_GUIDE_TEMPLATE_NAMES,
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
  listOverlay?: (directory: string) => string[] | undefined;
  exists?: (absolutePath: string) => boolean;
  /* Resolves symlinks for the overlay-dir confinement; defaults to fs.realpathSync. */
  realpath?: (absolutePath: string) => string;
}

function realListOverlay(directory: string): string[] | undefined {
  try {
    /* The reserved registry name never becomes a required overlay read — the loader
       (guides.ts) excludes it from the merged corpus, so requiring it here would
       demand reading a file the corpus ignores. */
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith('.md') && !NON_GUIDE_TEMPLATE_NAMES.has(entry.name),
      )
      .map((entry) => entry.name);
  } catch (error) {
    /* Only ENOENT means "no overlay" (optional). ENOTDIR (guides_dir points at a file),
       EACCES, and every other errno are a misconfiguration the reviewer must fix — fail
       closed rather than silently dropping the overlay requirement. */
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new GuidesUnavailable(`overlay directory "${directory}" is unreadable: ${detail}`);
  }
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
  const realpath = deps.realpath ?? realpathSync;
  const overlayDirectory = path.resolve(cwd, config.guidesDir);
  /* Confine the overlay up front so a guides_dir that escapes the repo fails closed even when
     that dir is EMPTY or MISSING (otherwise it lists to undefined/[] and the pass falls through
     to allow). Two layers: (1) LEXICAL — a `../` or absolute spelling; (2) SYMLINK — an in-repo
     `.claude/review-guides` symlinked to an outside dir, resolved via the deepest existing
     ancestor (the no-touch.ts confinement pattern). The symlink layer runs only when cwd itself
     realpaths (a real deployment); a fake/absent cwd (unit tests) keeps the lexical layer. */
  if (!isWithinRoot(cwd, overlayDirectory)) {
    throw new GuidesUnavailable(
      `deep_review.guides_dir "${config.guidesDir}" resolves outside the repo root "${cwd}"`,
    );
  }
  const repoRootReal = realpathOrUndefined(realpath, cwd);
  if (repoRootReal !== undefined) {
    const overlayReal = realpathOfDeepestExisting(realpath, overlayDirectory);
    if (overlayReal !== undefined && !isWithinRoot(repoRootReal, overlayReal)) {
      throw new GuidesUnavailable(
        `deep_review.guides_dir "${config.guidesDir}" resolves outside the repo root via a symlink`,
      );
    }
  }
  const loadGuides = deps.loadGuides ?? ((overlay: string) => loadReviewGuides(overlay, { templatesDir }));
  const listOverlay = deps.listOverlay ?? realListOverlay;
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
      /* Only the anchor template (review-contract.md) is a main-session required read;
         the profile bodies are profile-route reads, still LOADED above for the corpus
         availability check but no longer gated on the main transcript. */
      if (
        source.kind === 'package-template' &&
        MAIN_SESSION_REQUIRED_TEMPLATE_NAMES.has(path.basename(source.path))
      ) {
        tails.add(path.posix.join(anchorPrefix, path.basename(source.path)));
      }
    }
  }

  const overlayNames = listOverlay(overlayDirectory);
  if (overlayNames !== undefined) {
    for (const name of overlayNames) {
      /* Belt-and-braces vs injected listers: the reserved registry name is filtered
         at the source (realListOverlay) AND here. */
      if (NON_GUIDE_TEMPLATE_NAMES.has(name)) continue;
      /* Only the anchor overlay (review-contract) is a main-session required read; a
         profile or legacy overlay is profile-route material. Its AVAILABILITY is still
         fail-closed — an unreadable one made loadGuides return !ok above. */
      if (!MAIN_SESSION_REQUIRED_TEMPLATE_NAMES.has(name)) continue;
      tails.add(repoRelativeTail(cwd, path.join(overlayDirectory, name)));
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

/* Realpath the deepest EXISTING ancestor of `target` (the leaf may not exist yet), mirroring
   no-touch.ts: a symlinked ancestor escapes even when the final path is absent. Returns
   undefined when nothing up the chain resolves — not an escape, just a fully-missing path. */
function realpathOfDeepestExisting(
  realpath: (absolutePath: string) => string,
  target: string,
): string | undefined {
  let current = target;
  for (;;) {
    const resolved = realpathOrUndefined(realpath, current);
    if (resolved !== undefined) return resolved;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
