import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* INT-06 integrity guard, strengthened in the guides revamp (Gate-P F5),
   re-keyed to the profile corpus (ADR-018 rewrite): the canonical corpus is
   the *.md names in agents/review-guide-templates/ minus TRACEABILITY.md (the
   migration/canary registry the loader excludes). This test pins that set
   from two independent directions:
   1. catalog provenance: the corpus names must equal the set the
      skill-catalog `feeds_guides` arrays reference (the distributed
      baseline shares live inside profiles that also carry upstream
      material, so no baseline special-case remains);
   2. skill consumption: the nine corpus files deep-review-refactor step 4
      loads must all resolve to real templates.
   A corpus file added without catalog provenance, a catalog entry pointing at
   a missing file, or a renamed/dropped corpus file all fail here. */

const templatesDir = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));
const catalogPath = fileURLToPath(new URL('../../agents/skill-catalog.json', import.meta.url));

/* The corpus names deep-review-refactor's step 4 consumes, by contract:
   the shared worker contract plus the eight lens profiles. */
const STEP4_ROLES = [
  'review-contract.md',
  'profile-architecture-and-boundaries.md',
  'profile-naming-and-constants.md',
  'profile-tests-quality.md',
  'profile-types-and-contracts.md',
  'profile-correctness-and-lifecycle.md',
  'profile-module-depth.md',
  'profile-refactoring-and-smells.md',
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

test('the step-4 corpus list equals the template dir exactly (no orphan in either direction)', () => {
  assert.deepEqual(
    [...STEP4_ROLES].sort(),
    templateNames(),
    'STEP4_ROLES must equal the corpus set — a renamed/added corpus file must update the skill contract',
  );
});

test('the skill body enumerates every corpus file by name', () => {
  const skillBodyPath = fileURLToPath(
    new URL('../../agents/skill-sources/deep-review-refactor.md', import.meta.url),
  );
  const skillBody = readFileSync(skillBodyPath, 'utf8');
  const missing = templateNames().filter((name) => !skillBody.includes(name));
  assert.deepEqual(missing, [], `corpus files the skill body never names: ${missing.join(', ')}`);
});

test('the skill body pins the mandatory/non-collapsible profile fan-out contract (ADR-018/016)', () => {
  const skillBodyPath = fileURLToPath(
    new URL('../../agents/skill-sources/deep-review-refactor.md', import.meta.url),
  );
  /* Collapse whitespace so prose line-wrapping never splits a phrase mid-match. */
  const normalizedBody = readFileSync(skillBodyPath, 'utf8').replace(/\s+/g, ' ');
  /* Each phrase is an invariant whose removal is a KNOWN silent-regression mode:
     fan-out collapse, the per-profile-todo + coverage-matrix countermeasures, the
     worker-route floor, the legacy-overlay broadcast, and the full-roster matrix.
     The corpus-filenames-appear check above cannot catch these — those names also
     live in §review-only step 4's corpus roster, so the whole fan-out block could
     be deleted and stay green without this test. */
  const requiredPhrases = [
    'MANDATORY and NON-COLLAPSIBLE',
    'worker-route floor',
    'one item per CORPUS profile route',
    'broadcast into EVERY profile route',
    'one row for EVERY corpus profile',
  ];
  const missing = requiredPhrases.filter((phrase) => !normalizedBody.includes(phrase));
  assert.deepEqual(missing, [], `fan-out contract phrases missing from the skill body: ${missing.join(' | ')}`);
  /* All three coverage-matrix states must be named so a 2-state or dropped-state
     rewrite is caught. */
  for (const matrixState of ['APPLIED', 'SKIPPED', 'GAP']) {
    assert.ok(normalizedBody.includes(matrixState), `coverage-matrix state ${matrixState} missing from the skill body`);
  }
});
