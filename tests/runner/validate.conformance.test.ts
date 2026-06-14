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

// Full §2.8 workflow object; mutated per case. Distinct argv[0]s keep the
// cross-field seat rule (hand-only) from firing in the parity battery.
function fullWorkflow(): Record<string, unknown> {
  return {
    schema: 1,
    enabled: true,
    base_branch: 'main',
    worktree_parent: '../worktrees',
    cmux_mode: 'manual',
    loopback_mode: 'manual',
    reviewer_independence: 'different-runtime',
    required_review_guides: [],
    commit_exclude: ['reports/**', '*.log', '.DS_Store', 'tmp/**'],
    archive: true,
    timeouts: { default_wait_seconds: 1800, default_work_seconds: 1800 },
    budget: { workflow_total_seconds: 5400 },
    agents: { claude: ['claude'], codex: ['codex'] },
    ship: { ci_wait_seconds: 1800, notify: true },
    notify: { webhook_env: 'WORKFLOW_NOTIFY_WEBHOOK' },
  };
}

function setWorkflow(manifest: Manifest, workflow: unknown): void {
  (manifest as unknown as Record<string, unknown>)['workflow'] = workflow;
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
    label: 'workflow-absent-valid',
    mutate: (m) => {
      delete (m as unknown as { workflow?: unknown }).workflow;
    },
    expectValid: true,
  },
  {
    label: 'workflow-disabled-minimal-valid',
    mutate: (m) => {
      setWorkflow(m, { enabled: false });
    },
    expectValid: true,
  },
  {
    label: 'workflow-enabled-full-valid',
    mutate: (m) => {
      setWorkflow(m, fullWorkflow());
    },
    expectValid: true,
  },
  {
    label: 'workflow-enabled-missing-agents-invalid',
    mutate: (m) => {
      const workflow = fullWorkflow();
      delete workflow['agents'];
      setWorkflow(m, workflow);
    },
    expectValid: false,
  },
  {
    label: 'workflow-bad-enum-invalid',
    mutate: (m) => {
      const workflow = fullWorkflow();
      workflow['cmux_mode'] = 'sometimes';
      setWorkflow(m, workflow);
    },
    expectValid: false,
  },
  {
    label: 'workflow-extra-key-invalid',
    mutate: (m) => {
      const workflow = fullWorkflow();
      workflow['unexpected_key'] = true;
      setWorkflow(m, workflow);
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
  ]);
  const workflow = child(defs, 'workflow');
  assert.deepEqual(propertyKeys(workflow), [
    'schema',
    'enabled',
    'base_branch',
    'worktree_parent',
    'cmux_mode',
    'loopback_mode',
    'reviewer_independence',
    'required_review_guides',
    'commit_exclude',
    'archive',
    'timeouts',
    'budget',
    'agents',
    'ship',
    'notify',
  ]);
  const workflowProps = child(workflow, 'properties');
  assert.deepEqual(propertyKeys(child(workflowProps, 'timeouts')), [
    'default_wait_seconds',
    'default_work_seconds',
  ]);
  assert.deepEqual(propertyKeys(child(workflowProps, 'budget')), ['workflow_total_seconds']);
  assert.deepEqual(propertyKeys(child(workflowProps, 'agents')), ['claude', 'codex']);
  assert.deepEqual(propertyKeys(child(workflowProps, 'ship')), ['ci_wait_seconds', 'notify']);
  assert.deepEqual(propertyKeys(child(workflowProps, 'notify')), ['webhook_env']);
});
