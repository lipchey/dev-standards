import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// INT-06 integrity guard: every review guide the skill layer references as a
// seed MUST resolve to a real file in agents/review-guide-templates/. The
// machine-readable source of truth for the guide names is skill-catalog.json's
// `feeds_guides` arrays; `core-code-guidelines.md` is the always-on baseline
// referenced by the skill bodies (review-plan / review-implementation /
// process-review / deep-review-refactor) but has no upstream source, so it is
// asserted explicitly.

const templatesDir = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));
const catalogPath = fileURLToPath(new URL('../../agents/skill-catalog.json', import.meta.url));

function referencedGuides(): string[] {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
    sources: { feeds_guides?: string[] }[];
  };
  const fromCatalog = catalog.sources.flatMap((s) => s.feeds_guides ?? []);
  // core-code-guidelines.md: the baseline every review phase loads (ADR-003),
  // not sourced from any upstream, so it never appears in feeds_guides.
  return [...new Set([...fromCatalog, 'core-code-guidelines.md'])];
}

test('every referenced review guide resolves to a real seed template', () => {
  const missing = referencedGuides().filter((name) => !existsSync(templatesDir + name));
  assert.deepEqual(missing, [], `missing review-guide seed templates: ${missing.join(', ')}`);
});
