import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject } from 'ajv/dist/2020.js';
import { validate } from '../../runner/src/validate.ts';

// RUN-06 + INT-03 regression coverage. Kept in its own file (no overlap with the
// other validate*.test.ts owners).

const schemaPath = fileURLToPath(new URL('../../schemas/quality.schema.json', import.meta.url));
const manifestPath = fileURLToPath(new URL('../../quality.json', import.meta.url));

const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as AnySchemaObject;
const rootManifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true });
const schemaValidate = ajv.compile(schema);

// Clone the root manifest and make its first fileset a git_staged one carrying
// the given diff_filter (git_staged so the hand-only diff-filter-scope rule
// stays silent and only the pattern check can differ).
function manifestWithDiffFilter(diffFilter: string): Record<string, unknown> {
  const clone = structuredClone(rootManifest) as Record<string, unknown>;
  (clone['filesets'] as unknown[])[0] = {
    name: 'staged_ts',
    source: 'git_staged',
    include: ['runner/src/**/*.ts'],
    diff_filter: diffFilter,
  };
  return clone;
}

// RUN-06: hand validator must enforce ^[ACDMRTUXB]+$ on diff_filter, matching
// schemas/quality.schema.json:74. Before the fix the hand validator only
// type-checked diff_filter, so "Z" passed it while Ajv rejected it (drift).
test('RUN-06 conformance: diff_filter "Z" is rejected by BOTH hand validator and schema', () => {
  const candidate = manifestWithDiffFilter('Z');
  const handResult = validate(candidate);
  const schemaVerdict = schemaValidate(candidate);

  assert.equal(handResult.ok, false, 'hand validator must reject diff_filter "Z"');
  assert.equal(schemaVerdict, false, 'schema must reject diff_filter "Z"');
  const patternError = handResult.errors.find(
    (e) => e.path === 'filesets[0].diff_filter' && e.rule === 'pattern',
  );
  assert.ok(
    patternError,
    `expected a pattern error at filesets[0].diff_filter; got:\n${JSON.stringify(handResult.errors, null, 2)}`,
  );
});

test('RUN-06 conformance: valid diff_filter "ACMR" is accepted by BOTH', () => {
  const candidate = manifestWithDiffFilter('ACMR');
  const handResult = validate(candidate);
  const schemaVerdict = schemaValidate(candidate);

  assert.equal(handResult.ok, true, `hand validator must accept "ACMR"; got:\n${JSON.stringify(handResult.errors, null, 2)}`);
  assert.equal(schemaVerdict, true, 'schema must accept "ACMR"');
});

// INT-03: the full tier must run the full suite (`npm test`, all 521), not the
// runner-only subset (`npm run test:runner`, 167), so `./verify --full` is a real
// full gate. Assert on the shipped quality.json (matched by argv, not name).
test('INT-03 regression: full tier invokes `npm test` and drops the runner-only subset', () => {
  const manifest = rootManifest as { tiers: { full: Array<{ argv: string[] }> } };
  const fullChecks = manifest.tiers.full;
  const invokesFullSuite = fullChecks.some((c) => JSON.stringify(c.argv) === JSON.stringify(['npm', 'test']));
  const invokesRunnerOnly = fullChecks.some(
    (c) => JSON.stringify(c.argv) === JSON.stringify(['npm', 'run', 'test:runner']),
  );

  assert.ok(invokesFullSuite, 'full tier must invoke `npm test` (the full 521-test suite)');
  assert.ok(!invokesRunnerOnly, 'full tier must not use the runner-only subset (`npm run test:runner`)');
});
