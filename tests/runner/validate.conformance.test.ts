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

// ---------------------------------------------------------------------------
// Dual-validator structural battery
//
// Each case mutates a deep clone of the root manifest and runs it through
// BOTH the hand validator and the compiled schema; the two verdicts must
// agree with each other and with `expectValid`. Only structural mutations
// belong here — semantic rules (tier budgets, token/reference integrity,
// uniqueness, glob dialect, diff_filter coherence, argv[0] position) are
// invisible to the schema by design and are asserted in validate.test.ts
// and validate.semantic.test.ts.
// ---------------------------------------------------------------------------

/** Deep clone of the root manifest, narrowed via the hand validator's guard. */
function cloneRootManifest(): Manifest {
  const clone: unknown = structuredClone(manifest);
  if (!isManifest(clone)) {
    throw new Error('root quality.json is expected to be a valid manifest fixture');
  }
  return clone;
}

/** First-element accessor that fails loudly if the fixture loses the element. */
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

// Mutations cast narrowly (mirroring validate.test.ts) because each one is
// invalid by construction against the Manifest type.
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
