import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject } from 'ajv/dist/2020.js';
import { isManifest, validate } from '../../runner/src/validate.ts';
import type { Manifest } from '../../runner/src/types.ts';

const schemaPath = fileURLToPath(new URL('../../schemas/quality.schema.json', import.meta.url));
const manifestPath = fileURLToPath(new URL('../../quality.json', import.meta.url));

const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as AnySchemaObject;
const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true });
const validateFn = ajv.compile(schema);

test('root quality.json validates against quality.schema.json', () => {
  const valid = validateFn(manifest);
  assert.ok(valid, `Root manifest failed schema validation:\n${JSON.stringify(validateFn.errors, null, 2)}`);
});

// Structural mutations must agree between the hand validator and schema.
function cloneRootManifest(): Manifest {
  const clone: unknown = structuredClone(manifest);
  if (!isManifest(clone)) {
    throw new Error('root quality.json is expected to be a valid manifest fixture');
  }
  return clone;
}

function firstOf<T>(items: readonly T[], label: string): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error(`root quality.json fixture must declare at least one ${label}`);
  }
  return item;
}

// Full deep_review block (ADR-007); mutated per case. tokens:null exercises the
// ["integer","null"] branch so Ajv and the hand validator must agree on it.
function validDeepReview(): Record<string, unknown> {
  return {
    enabled: true,
    trigger: 'manual-only',
    modes: ['review-only', 'review-and-refactor'],
    budget: { seconds: 1800, tokens: null },
    verify_after_fix: '--fast',
    verify_entry: 'scripts/verify',
    no_touch_globs_ref: '.agents/project-facts.md#no-touch-zones',
    guides_dir: '.agents/review-guides',
  };
}

function setDeepReview(manifest: Manifest, deepReview: unknown): void {
  (manifest as unknown as Record<string, unknown>)['deep_review'] = deepReview;
}

interface BatteryCase {
  label: string;
  mutate: (manifest: Manifest) => void;
  expectValid: boolean;
}

const batteryCases: readonly BatteryCase[] = [
  {
    label: 'valid root manifest (no mutation)',
    mutate: () => {},
    expectValid: true,
  },
  {
    label: 'missing top-level required key (budgets deleted)',
    mutate: (m) => {
      delete (m as unknown as { budgets?: unknown }).budgets;
    },
    expectValid: false,
  },
  {
    label: 'unknown additional key at the top level',
    mutate: (m) => {
      (m as unknown as Record<string, unknown>)['unexpected_key'] = true;
    },
    expectValid: false,
  },
  {
    label: 'unknown additional key on a nested check (tiers.fast[0])',
    mutate: (m) => {
      (firstOf(m.tiers.fast, 'fast-tier check') as unknown as Record<string, unknown>)['unexpected_key'] = true;
    },
    expectValid: false,
  },
  {
    label: 'out-of-range enum: stack',
    mutate: (m) => {
      (m as unknown as { stack: string }).stack = 'not-a-stack';
    },
    expectValid: false,
  },
  {
    label: 'out-of-range enum: scheduler_class',
    mutate: (m) => {
      (m as unknown as { scheduler_class: string }).scheduler_class = 'cron-sometimes';
    },
    expectValid: false,
  },
  {
    label: 'out-of-range enum: fileset source',
    mutate: (m) => {
      (firstOf(m.filesets, 'fileset') as unknown as { source: string }).source = 'everything';
    },
    expectValid: false,
  },
  {
    label: 'out-of-range enum: workspace package_manager',
    mutate: (m) => {
      (firstOf(m.workspaces, 'workspace') as unknown as { package_manager: string }).package_manager = 'bun';
    },
    expectValid: false,
  },
  {
    label: 'out-of-range enum: check mode',
    mutate: (m) => {
      (firstOf(m.tiers.fast, 'fast-tier check') as unknown as { mode: string }).mode = 'advisory';
    },
    expectValid: false,
  },
  {
    label: 'argv is not an array',
    mutate: (m) => {
      (firstOf(m.tiers.fast, 'fast-tier check') as unknown as { argv: string }).argv = 'npm run test';
    },
    expectValid: false,
  },
  {
    label: 'argv is an empty array',
    mutate: (m) => {
      firstOf(m.tiers.fast, 'fast-tier check').argv = [];
    },
    expectValid: false,
  },
  {
    label: 'timeout_seconds is not a positive integer (0)',
    mutate: (m) => {
      firstOf(m.tiers.fast, 'fast-tier check').timeout_seconds = 0;
    },
    expectValid: false,
  },
  {
    label: 'operational_exit_codes: valid [2]',
    mutate: (m) => {
      firstOf(m.tiers.fast, 'fast-tier check').operational_exit_codes = [2];
    },
    expectValid: true,
  },
  {
    label: 'operational_exit_codes: empty array',
    mutate: (m) => {
      firstOf(m.tiers.fast, 'fast-tier check').operational_exit_codes = [];
    },
    expectValid: false,
  },
  {
    label: 'operational_exit_codes: out-of-range item (0)',
    mutate: (m) => {
      firstOf(m.tiers.fast, 'fast-tier check').operational_exit_codes = [0];
    },
    expectValid: false,
  },
  {
    label: 'operational_exit_codes: duplicate items',
    mutate: (m) => {
      firstOf(m.tiers.fast, 'fast-tier check').operational_exit_codes = [2, 2];
    },
    expectValid: false,
  },
  {
    // The workflow subsystem is removed: a top-level `workflow` key is now an
    // unknown additional property, so both validators must reject it.
    label: 'workflow-top-level-key-rejected',
    mutate: (m) => {
      (m as unknown as Record<string, unknown>)['workflow'] = { enabled: false };
    },
    expectValid: false,
  },
  {
    label: 'deep_review-valid-block',
    mutate: (m) => {
      setDeepReview(m, validDeepReview());
    },
    expectValid: true,
  },
  {
    label: 'deep_review-missing-enabled-invalid',
    mutate: (m) => {
      const deepReview = validDeepReview();
      delete deepReview['enabled'];
      setDeepReview(m, deepReview);
    },
    expectValid: false,
  },
  {
    label: 'deep_review-enabled-wrong-type-invalid',
    mutate: (m) => {
      const deepReview = validDeepReview();
      deepReview['enabled'] = 'yes';
      setDeepReview(m, deepReview);
    },
    expectValid: false,
  },
  {
    label: 'deep_review-extra-key-invalid',
    mutate: (m) => {
      const deepReview = validDeepReview();
      deepReview['unexpected_key'] = true;
      setDeepReview(m, deepReview);
    },
    expectValid: false,
  },
  {
    label: 'deep_review-modes-out-of-enum-invalid',
    mutate: (m) => {
      const deepReview = validDeepReview();
      deepReview['modes'] = ['review-only', 'rewrite-everything'];
      setDeepReview(m, deepReview);
    },
    expectValid: false,
  },
  {
    label: 'deep_review-budget-seconds-zero-invalid',
    mutate: (m) => {
      const deepReview = validDeepReview();
      deepReview['budget'] = { seconds: 0 };
      setDeepReview(m, deepReview);
    },
    expectValid: false,
  },
  {
    label: 'deep_review-verify-entry-empty-invalid',
    mutate: (m) => {
      const deepReview = validDeepReview();
      deepReview['verify_entry'] = '';
      setDeepReview(m, deepReview);
    },
    expectValid: false,
  },
];

for (const batteryCase of batteryCases) {
  test(`structural battery: ${batteryCase.label}`, () => {
    const candidate = cloneRootManifest();
    batteryCase.mutate(candidate);

    const handResult = validate(candidate);
    /* ajv sync validate returns boolean; `=== true` erases the async-Promise arm
       of its call signature so the verdict interpolates as a plain boolean. */
    const schemaVerdict = validateFn(candidate) === true;
    const errorDump =
      `hand errors:\n${JSON.stringify(handResult.errors, null, 2)}\n` +
      `schema errors:\n${JSON.stringify(validateFn.errors, null, 2)}`;

    assert.equal(
      handResult.ok,
      schemaVerdict,
      `hand validator (${handResult.ok}) and schema (${schemaVerdict}) disagree.\n${errorDump}`,
    );
    assert.equal(
      handResult.ok,
      batteryCase.expectValid,
      `expected both validators to report ${batteryCase.expectValid ? 'valid' : 'invalid'}.\n${errorDump}`,
    );
  });
}

/* Characterization of describeValue through the public validate() boundary: the
   helper was rewritten (typeof switch) with a byte-identical-output requirement,
   and nothing else pins the exact message text. Covers every JSON-reachable
   shape; bigint/symbol/undefined/function cannot arrive through JSON.parse. */
const DESCRIBE_CASES: Array<{ label: string; value: unknown; expected: string }> = [
  { label: 'number', value: 3, expected: 'must be a string, got 3' },
  { label: 'boolean', value: true, expected: 'must be a string, got true' },
  { label: 'null', value: null, expected: 'must be a string, got null' },
  { label: 'array', value: [], expected: 'must be a string, got an array' },
  { label: 'object', value: {}, expected: 'must be a string, got an object' },
];
for (const { label, value, expected } of DESCRIBE_CASES) {
  test(`describeValue characterization: ${label} in a string field`, () => {
    const candidate = cloneRootManifest();
    (candidate as unknown as Record<string, unknown>)['repo'] = value;
    const result = validate(candidate);
    assert.equal(result.ok, false);
    const err = result.errors.find((e) => e.path === 'repo');
    assert.ok(err, `expected an error at "repo"; got:\n${JSON.stringify(result.errors, null, 2)}`);
    assert.equal(err.message, expected);
  });
}
test('describeValue characterization: string in an object field', () => {
  const candidate = cloneRootManifest();
  (candidate as unknown as Record<string, unknown>)['budgets'] = 'x';
  const result = validate(candidate);
  assert.equal(result.ok, false);
  const err = result.errors.find((e) => e.path === 'budgets');
  assert.ok(err, `expected an error at "budgets"; got:\n${JSON.stringify(result.errors, null, 2)}`);
  assert.equal(err.message, 'must be an object, got "x"');
});

// The workflow subsystem is gone: a top-level `workflow` key must be rejected as an
// unknown additional property by BOTH the hand validator and Ajv (exact assertion).
test('top-level workflow key is rejected by both validators (additional-property)', () => {
  const candidate = cloneRootManifest();
  (candidate as unknown as Record<string, unknown>)['workflow'] = { enabled: false };

  const handResult = validate(candidate);
  assert.equal(handResult.ok, false, 'hand validator must reject a top-level workflow key');
  assert.ok(
    handResult.errors.some((e) => e.path === 'workflow' && e.rule === 'additional-property'),
    `expected a hand additional-property error at "workflow"; got:\n${JSON.stringify(handResult.errors, null, 2)}`,
  );

  const schemaVerdict = validateFn(candidate);
  assert.equal(schemaVerdict, false, 'Ajv must reject a top-level workflow key');
  assert.ok(
    (validateFn.errors ?? []).some(
      (e) =>
        e.keyword === 'additionalProperties' &&
        (e.params as Record<string, unknown>)['additionalProperty'] === 'workflow',
    ),
    `expected an Ajv additionalProperties error naming "workflow"; got:\n${JSON.stringify(validateFn.errors, null, 2)}`,
  );
});

// Parity alone does not pin hand-validator path/rule output, so sample each structural rule.

interface ContractCase {
  label: string;
  mutate: (manifest: Manifest) => void;
  expectedPath: string;
  expectedRule: string;
}

const structuralContractCases: readonly ContractCase[] = [
  {
    label: 'required (missing top-level key)',
    mutate: (m) => {
      delete (m as unknown as { budgets?: unknown }).budgets;
    },
    expectedPath: 'budgets',
    expectedRule: 'required',
  },
  {
    label: 'type (timeout_seconds not a positive integer)',
    mutate: (m) => {
      firstOf(m.tiers.fast, 'fast-tier check').timeout_seconds = 0;
    },
    expectedPath: 'tiers.fast[0].timeout_seconds',
    expectedRule: 'type',
  },
  {
    label: 'enum (out-of-range stack)',
    mutate: (m) => {
      (m as unknown as { stack: string }).stack = 'not-a-stack';
    },
    expectedPath: 'stack',
    expectedRule: 'enum',
  },
  {
    label: 'additional-property (unknown key on a nested check)',
    mutate: (m) => {
      (firstOf(m.tiers.fast, 'fast-tier check') as unknown as Record<string, unknown>)['unexpected_key'] = true;
    },
    expectedPath: 'tiers.fast[0].unexpected_key',
    expectedRule: 'additional-property',
  },
  {
    label: 'min-length (empty required string)',
    mutate: (m) => {
      (m as unknown as { repo: string }).repo = '';
    },
    expectedPath: 'repo',
    expectedRule: 'min-length',
  },
  {
    label: 'min-items (empty argv array)',
    mutate: (m) => {
      firstOf(m.tiers.fast, 'fast-tier check').argv = [];
    },
    expectedPath: 'tiers.fast[0].argv',
    expectedRule: 'min-items',
  },
];

for (const contractCase of structuralContractCases) {
  test(`structural contract: ${contractCase.label}`, () => {
    const candidate = cloneRootManifest();
    contractCase.mutate(candidate);

    const { ok, errors } = validate(candidate);
    assert.equal(ok, false, `expected the hand validator to reject: ${contractCase.label}`);
    const match = errors.find(
      (error) => error.path === contractCase.expectedPath && error.rule === contractCase.expectedRule,
    );
    assert.ok(
      match,
      `expected an error at path "${contractCase.expectedPath}" with rule "${contractCase.expectedRule}"; got:\n` +
        JSON.stringify(errors, null, 2),
    );
  });
}

// Schema property order is canonical and mirrored by validator key tables/quality.json.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function child(node: unknown, key: string): unknown {
  assert.ok(isPlainObject(node), `expected an object to read "${key}" from`);
  return node[key];
}

function propertyKeys(node: unknown): string[] {
  const properties = child(node, 'properties');
  assert.ok(isPlainObject(properties), 'expected a "properties" object on the schema node');
  return Object.keys(properties);
}

test('schema declares root properties in canonical order', () => {
  assert.deepEqual(propertyKeys(schema), [
    'version',
    'repo',
    'stack',
    'scheduler_class',
    'budgets',
    'policy',
    'paths',
    'generated',
    'workspaces',
    'filesets',
    'tiers',
    'format',
    'deep_review',
  ]);
});

test('schema declares nested property groups in canonical order', () => {
  const props = child(schema, 'properties');
  const defs = child(schema, '$defs');

  assert.deepEqual(propertyKeys(child(props, 'budgets')), [
    'staged_seconds',
    'fast_seconds',
    'full_seconds',
    'audit_seconds',
  ]);
  assert.deepEqual(propertyKeys(child(props, 'policy')), [
    'mutates_by_default',
    'format_fix_staged_allowed',
    'typed_eslint_in_precommit',
    'block_new_dead_code_only',
  ]);
  assert.deepEqual(propertyKeys(child(props, 'paths')), ['reports', 'baselines']);
  assert.deepEqual(propertyKeys(child(props, 'generated')), ['hooks_dir', 'ci_quality']);
  assert.deepEqual(propertyKeys(child(child(props, 'workspaces'), 'items')), [
    'name',
    'path',
    'stack',
    'package_manager',
  ]);
  assert.deepEqual(propertyKeys(child(child(props, 'filesets'), 'items')), [
    'name',
    'source',
    'include',
    'exclude',
    'diff_filter',
  ]);
  assert.deepEqual(propertyKeys(child(props, 'tiers')), ['staged', 'fast', 'full', 'audit']);
  assert.deepEqual(propertyKeys(child(child(defs, 'checkArray'), 'items')), [
    'name',
    'argv',
    'timeout_seconds',
    'skip_if_empty',
    'mode',
    'baseline',
    'bypassable',
    'operational_exit_codes',
  ]);
});
