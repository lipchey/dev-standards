import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// INT-06 integrity guard, strengthened in the guides revamp (Gate-P F5),
// re-keyed to the profile corpus (ADR-017 rewrite): the canonical corpus is
// the *.md names in agents/review-guide-templates/ minus TRACEABILITY.md (the
// migration/canary registry the loader excludes). This test pins that set
// from two independent directions:
//   1. catalog provenance: the corpus names must equal the set the
//      skill-catalog `feeds_guides` arrays reference (the distributed
//      baseline shares live inside profiles that also carry upstream
//      material, so no baseline special-case remains);
//   2. skill consumption: the seven corpus files deep-review-refactor step 4
//      loads must all resolve to real templates.
// A corpus file added without catalog provenance, a catalog entry pointing at
// a missing file, or a renamed/dropped corpus file all fail here.

const templatesDir = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));
const catalogPath = fileURLToPath(new URL('../../agents/skill-catalog.json', import.meta.url));

// The corpus names deep-review-refactor's step 4 consumes, by contract:
// the shared worker contract plus the six lens profiles.
const STEP4_ROLES = [
  'review-contract.md',
  'profile-naming-and-constants.md',
  'profile-tests-quality.md',
  'profile-types-and-contracts.md',
  'profile-correctness-and-lifecycle.md',
  'profile-structure-and-dependencies.md',
  'profile-security.md',
];

function catalogGuides(): string[] {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
    sources: { feeds_guides?: string[] }[];
  };
  const fromCatalog = catalog.sources.flatMap((s) => s.feeds_guides ?? []);
  return [...new Set(fromCatalog)].sort();
}

function templateNames(): string[] {
  // TRACEABILITY.md is the loader-excluded registry, not corpus (guides.ts).
  return readdirSync(templatesDir)
    .filter((n) => n.endsWith('.md') && n !== 'TRACEABILITY.md')
    .sort();
}

test('template dir and catalog provenance agree exactly (set equality)', () => {
  assert.deepEqual(
    templateNames(),
    catalogGuides(),
    'agents/review-guide-templates/*.md minus TRACEABILITY.md must equal union(feeds_guides)',
  );
});

test('every step-4 role name resolves to a real package template', () => {
  const names = new Set(templateNames());
  const missing = STEP4_ROLES.filter((role) => !names.has(role));
  assert.deepEqual(missing, [], `missing step-4 role templates: ${missing.join(', ')}`);
});
