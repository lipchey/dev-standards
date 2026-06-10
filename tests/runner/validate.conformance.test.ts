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
    label: 'workflow.enabled is not false (true)',
    mutate: (m) => {
      (m as unknown as { workflow: { enabled: boolean } }).workflow = { enabled: true };
    },
    expectValid: false,
  },
];

for (const batteryCase of batteryCases) {
  test(`structural battery: ${batteryCase.label}`, () => {
    const candidate = cloneRootManifest();
    batteryCase.mutate(candidate);

    const handResult = validate(candidate);
    const schemaVerdict = validateFn(candidate);
    const errorDump =
      `hand errors:\n${JSON.stringify(handResult.errors, null, 2)}\n` +
      `schema errors:\n${JSON.stringify(validateFn.errors, null, 2)}`;

    assert.equal(
      handResult.ok,
      schemaVerdict,
      `hand validator (${String(handResult.ok)}) and schema (${String(schemaVerdict)}) disagree.\n${errorDump}`,
    );
    assert.equal(
      handResult.ok,
      batteryCase.expectValid,
      `expected both validators to report ${batteryCase.expectValid ? 'valid' : 'invalid'}.\n${errorDump}`,
    );
  });
}

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
    'workflow',
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
  ]);
  assert.deepEqual(propertyKeys(child(defs, 'workflow')), ['enabled']);
});
