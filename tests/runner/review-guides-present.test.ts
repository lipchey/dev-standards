import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// INT-06 integrity guard, strengthened in the guides revamp (Gate-P F5):
// the canonical guide set is the *.md names in agents/review-guide-templates/
// (the seeder and the engine preflight both key on those names). This test
// pins that set from two independent directions:
//   1. catalog provenance: the template names must equal the set the
//      skill-catalog `feeds_guides` arrays reference (plus the baseline,
//      which has no upstream source);
//   2. skill consumption: the seven role names deep-review-refactor step 4
//      loads must all resolve to real templates.
// A template added without catalog provenance, a catalog entry pointing at a
// missing template, or a renamed/dropped role file all fail here.

const templatesDir = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));
const catalogPath = fileURLToPath(new URL('../../agents/skill-catalog.json', import.meta.url));

// The role names deep-review-refactor's step 4 consumes, by contract:
// baseline (4a), router (4b), area guides (4c), output shape (4e).
const STEP4_ROLES = [
  'core-code-guidelines.md',
  'language-review-sources.md',
  'clean-architecture.md',
  'architecture-deepening.md',
  'refactoring-checklist.md',
  'security-review.md',
  'review-output-format.md',
];

function catalogGuides(): string[] {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
    sources: { feeds_guides?: string[] }[];
  };
  const fromCatalog = catalog.sources.flatMap((s) => s.feeds_guides ?? []);
  // core-code-guidelines.md: the always-on baseline (ADR-003), not sourced
  // from any upstream, so it never appears in feeds_guides.
  return [...new Set([...fromCatalog, 'core-code-guidelines.md'])].sort();
}

function templateNames(): string[] {
  return readdirSync(templatesDir)
    .filter((n) => n.endsWith('.md'))
    .sort();
}

test('template dir and catalog provenance agree exactly (set equality)', () => {
  assert.deepEqual(
    templateNames(),
    catalogGuides(),
    'agents/review-guide-templates/*.md must equal feeds_guides ∪ {core-code-guidelines.md}',
  );
});

test('every step-4 role name resolves to a real seed template', () => {
  const names = new Set(templateNames());
  const missing = STEP4_ROLES.filter((role) => !names.has(role));
  assert.deepEqual(missing, [], `missing step-4 role templates: ${missing.join(', ')}`);
});
