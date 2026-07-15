/* Source and bundled modules stay two levels below the package root. */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PACKAGE_ROOT_URL = new URL('../../', import.meta.url);
const BODY_SEPARATOR = '\n\n';

/* The nine-file corpus contract (ADR-017 profile rewrite): a partial or
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
  'review-contract.md',
] as const;

/* TRACEABILITY.md shares the templates dir but is the migration/canary registry,
   not review corpus: loading it would leak BLINDED canaries into the merged guide
   bodies and force it into the ADR-016 required-read set. The name is reserved in
   BOTH source kinds (package templates and consumer overlays) — guides-read.ts
   filters its overlay enumeration with the same set. */
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
  | { ok: false; templatesDir: string };

export interface ReviewGuideLoadDeps {
  templatesDir?: string;
  listMarkdownFiles?: (directory: string) => string[];
  readFile?: (filePath: string) => string;
}

function realListMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
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

  /* Overlay absence is optional (ENOENT), but any OTHER enumeration error
     (ENOTDIR, EACCES) must fail closed — an unreadable overlay silently dropped
     would review with a thinner rulebook than the repo configured. The reserved
     registry name is excluded here too: a consumer overlay named TRACEABILITY.md
     would otherwise merge as a repo-extra guide, get broadcast to every profile
     worker, and could unblind a copied canary registry. */
  let overlayNames: string[];
  try {
    overlayNames = listMarkdownFiles(overlayDirectory).filter(
      (name) => !NON_GUIDE_TEMPLATE_NAMES.has(name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      return { ok: false, templatesDir: templatesDirectory };
    }
    overlayNames = [];
  }
  for (const overlayName of overlayNames) {
    const overlayPath = join(overlayDirectory, overlayName);
    try {
      mergeSource(guidesByName, overlayName, {
        kind: 'repo-overlay',
        path: overlayPath,
        body: readFile(overlayPath),
      });
    } catch {
      /* Optional overlay data cannot make the package guide set unavailable. */
    }
  }

  return {
    ok: true,
    guides: [...guidesByName.values()].sort((leftGuide, rightGuide) =>
      leftGuide.name.localeCompare(rightGuide.name),
    ),
  };
}
