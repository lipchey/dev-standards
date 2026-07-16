/* Source and bundled modules stay two levels below the package root. */

import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PACKAGE_ROOT_URL = new URL('../../', import.meta.url);
const BODY_SEPARATOR = '\n\n';

/* The shared corpus contract file. It is the ADR-016 main-session ANCHOR read
   (guides-read.ts): the eight profile lens bodies are profile-route reads, this
   one is always main-required, so its name is a named constant reused by both. */
export const REVIEW_CONTRACT_TEMPLATE_NAME = 'review-contract.md';

/* The nine-file corpus contract (ADR-018 profile rewrite): a partial or
   blank-body checkout must fail preflight, not silently review with a thinner
   rulebook. */
const REQUIRED_TEMPLATE_NAMES = [
  'profile-architecture-and-boundaries.md',
  'profile-correctness-and-lifecycle.md',
  'profile-module-depth.md',
  'profile-naming-and-constants.md',
  'profile-refactoring-and-smells.md',
  'profile-security.md',
  'profile-tests-quality.md',
  'profile-types-and-contracts.md',
  REVIEW_CONTRACT_TEMPLATE_NAME,
] as const;

/* TRACEABILITY.md shares the templates dir but is the migration/canary registry,
   not review corpus: loading it would leak BLINDED canaries into the merged guide
   bodies (and, for the anchor overlay, into the ADR-016 required-read set). The
   name is reserved in BOTH source kinds — the template lister and the overlay loader
   (realLoadOverlaySources) each skip it, so it never becomes a corpus guide or a
   required-read tail. */
export const NON_GUIDE_TEMPLATE_NAMES: ReadonlySet<string> = new Set(['TRACEABILITY.md']);

export const REVIEW_GUIDE_TEMPLATES_DIR = join(
  fileURLToPath(PACKAGE_ROOT_URL),
  'agents',
  'review-guide-templates',
);

type ReviewGuideSourceKind = 'package-template' | 'repo-overlay';

interface ReviewGuideSource {
  kind: ReviewGuideSourceKind;
  path: string;
  body: string;
}

export interface LoadedReviewGuide {
  name: string;
  sources: ReviewGuideSource[];
  body: string;
}

export type ReviewGuideLoadOutcome =
  | { ok: true; guides: LoadedReviewGuide[] }
  | { ok: false; templatesDir: string; reason?: string };

/* An overlay guide read fail-closed from the consumer-controlled dir: name, absolute
   path, and the body read through a no-follow descriptor. */
export interface OverlaySource {
  name: string;
  path: string;
  body: string;
}

export interface ReviewGuideLoadDeps {
  templatesDir?: string;
  /* Template enumeration only — the templates dir is the trusted vendored submodule, so a
     name lister + readFile suffice. The overlay dir is untrusted and uses its own hardened
     seam (loadOverlaySources) instead. */
  listMarkdownFiles?: (directory: string) => string[];
  readFile?: (filePath: string) => string;
  /* undefined ⇒ the overlay dir is absent (optional); a throw ⇒ fail closed. */
  loadOverlaySources?: (directory: string) => OverlaySource[] | undefined;
}

function realListMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}

/* The overlay dir is the ONE consumer-controlled input into the review corpus, so it is
   fail-closed per leaf on anything that is not a plain regular `*.md`: a symlink, a directory,
   or any non-regular entry named `*.md`. Silently dropping such an entry (the pre-hardening
   `entry.isFile()` filter did) let a review rule vanish AND escape the read gate. The reserved
   registry name is skipped BEFORE the type check so a reserved-name symlink is ignored, not a
   hard failure. The DIR itself is not re-checked for symlinks here — the caller confines
   guides_dir first (assertGuidesDirConfined rejects any symlink component), so an ENOENT from
   readdir here means genuinely absent (optional overlay); any other errno fails closed.
   ponytail: Node has no `openat`, so ANCESTOR dir components stay path-based — an ancestor-swap
   race survives; the no-follow open closes the LEAF check→read race only (a regular file
   swapped for a symlink after enumeration). Native addon if that ceiling ever bites. */
function realLoadOverlaySources(directory: string): OverlaySource[] | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const sources: OverlaySource[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (NON_GUIDE_TEMPLATE_NAMES.has(entry.name)) continue;
    const overlayPath = join(directory, entry.name);
    let fd: number | undefined;
    try {
      /* O_NOFOLLOW rejects a symlink leaf (ELOOP); O_NONBLOCK so a `*.md` that is a FIFO
         cannot BLOCK the open forever (a read-side FIFO open waits for a writer) — it
         returns a fd that fstat then rejects as non-regular. Both are defense: the gate
         must fail closed, never hang, on a hostile overlay entry. */
      fd = openSync(overlayPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) {
        throw new Error(`overlay entry "${entry.name}" is not a regular file`);
      }
      sources.push({ name: entry.name, path: overlayPath, body: readFileSync(fd, 'utf8') });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return sources;
}

function mergeSource(
  guidesByName: Map<string, LoadedReviewGuide>,
  name: string,
  source: ReviewGuideSource,
): void {
  const existingGuide = guidesByName.get(name);
  if (existingGuide === undefined) {
    guidesByName.set(name, { name, sources: [source], body: source.body });
    return;
  }
  existingGuide.sources.push(source);
  existingGuide.body = existingGuide.sources.map((guideSource) => guideSource.body).join(BODY_SEPARATOR);
}

export function loadReviewGuides(
  overlayDirectory: string,
  deps: ReviewGuideLoadDeps = {},
): ReviewGuideLoadOutcome {
  const templatesDirectory = deps.templatesDir ?? REVIEW_GUIDE_TEMPLATES_DIR;
  const listMarkdownFiles = deps.listMarkdownFiles ?? realListMarkdownFiles;
  const readFile = deps.readFile ?? ((filePath: string): string => readFileSync(filePath, 'utf8'));
  const loadOverlaySources = deps.loadOverlaySources ?? realLoadOverlaySources;

  let templateNames: string[];
  try {
    templateNames = listMarkdownFiles(templatesDirectory).filter(
      (name) => !NON_GUIDE_TEMPLATE_NAMES.has(name),
    );
  } catch {
    return { ok: false, templatesDir: templatesDirectory };
  }
  const availableNames = new Set(templateNames);
  for (const requiredName of REQUIRED_TEMPLATE_NAMES) {
    if (!availableNames.has(requiredName)) return { ok: false, templatesDir: templatesDirectory };
  }

  const guidesByName = new Map<string, LoadedReviewGuide>();
  try {
    for (const templateName of templateNames) {
      const templatePath = join(templatesDirectory, templateName);
      const templateBody = readFile(templatePath);
      if (templateBody.trim() === '') return { ok: false, templatesDir: templatesDirectory };
      mergeSource(guidesByName, templateName, {
        kind: 'package-template',
        path: templatePath,
        body: templateBody,
      });
    }
  } catch {
    return { ok: false, templatesDir: templatesDirectory };
  }

  /* Overlay absence is optional (ENOENT ⇒ undefined); every other fault — an unreadable
     dir, a dangling symlink dir, a symlinked/non-regular `*.md` leaf — throws and fails
     closed here. An overlay silently dropped would review with a thinner rulebook than the
     repo configured AND (after the 2026-07-16 anchor rescope, where non-anchor overlays are
     no longer a main-session required read) escape the read gate entirely. This is the
     single fail-closed point for both the guides-read gate and fix-mode preflight; the
     reserved registry name is excluded inside the loader so a TRACEABILITY.md overlay never
     merges as a corpus guide (which would unblind a copied canary registry). */
  let overlaySources: OverlaySource[];
  try {
    overlaySources = loadOverlaySources(overlayDirectory) ?? [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      templatesDir: templatesDirectory,
      reason: `repo overlay dir "${overlayDirectory}" is unavailable: ${detail}`,
    };
  }
  for (const source of overlaySources) {
    mergeSource(guidesByName, source.name, {
      kind: 'repo-overlay',
      path: source.path,
      body: source.body,
    });
  }

  return {
    ok: true,
    guides: [...guidesByName.values()].sort((leftGuide, rightGuide) =>
      leftGuide.name.localeCompare(rightGuide.name),
    ),
  };
}
