/* Source and bundled modules stay two levels below the package root. */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PACKAGE_ROOT_URL = new URL('../../', import.meta.url);
const BODY_SEPARATOR = '\n\n';

export const REVIEW_GUIDE_TEMPLATES_DIR = join(
  fileURLToPath(PACKAGE_ROOT_URL),
  'agents',
  'review-guide-templates',
);

export type ReviewGuideSourceKind = 'package-template' | 'repo-overlay';

export interface ReviewGuideSource {
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
    templateNames = listMarkdownFiles(templatesDirectory);
  } catch {
    return { ok: false, templatesDir: templatesDirectory };
  }
  if (templateNames.length === 0) return { ok: false, templatesDir: templatesDirectory };

  const guidesByName = new Map<string, LoadedReviewGuide>();
  try {
    for (const templateName of templateNames) {
      const templatePath = join(templatesDirectory, templateName);
      mergeSource(guidesByName, templateName, {
        kind: 'package-template',
        path: templatePath,
        body: readFile(templatePath),
      });
    }
  } catch {
    return { ok: false, templatesDir: templatesDirectory };
  }

  let overlayNames: string[];
  try {
    overlayNames = listMarkdownFiles(overlayDirectory);
  } catch {
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
