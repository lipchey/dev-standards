import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../runner/src/validate.ts';
import type {
  Check,
  Manifest,
  ValidationError,
  ValidationResult,
} from '../../runner/src/types.ts';

// Timeouts leave room for single-mutation budget tests.
const baseManifest: Manifest = {
  version: 1,
  repo: 'fixture-repo',
  stack: 'node-service',
  scheduler_class: 'local-only',
  budgets: {
    staged_seconds: 10,
    fast_seconds: 60,
    full_seconds: 120,
    audit_seconds: 120,
  },
  policy: {
    mutates_by_default: false,
    format_fix_staged_allowed: false,
    typed_eslint_in_precommit: false,
    block_new_dead_code_only: true,
  },
  paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
  generated: { hooks_dir: '.githooks' },
  workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
  filesets: [{ name: 'repo_ts', source: 'repo_all', include: ['src/**/*.ts'] }],
  tiers: {
    staged: [],
    fast: [{ name: 'typecheck', argv: ['npm', 'run', 'typecheck'], timeout_seconds: 30 }],
    full: [],
  },
};

function makeManifest(): Manifest {
  return structuredClone(baseManifest);
}

function firstFastCheck(manifest: Manifest): Check {
  const check = manifest.tiers.fast[0];
  if (check === undefined) {
    throw new Error('fixture manifest must contain one fast-tier check');
  }
  return check;
}

function findError(
  result: ValidationResult,
  match: { path?: string; rule?: string },
): ValidationError | undefined {
  return result.errors.find(
    (error) =>
      (match.path === undefined || error.path === match.path) &&
      (match.rule === undefined || error.rule === match.rule),
  );
}

function expectError(result: ValidationResult, match: { path?: string; rule?: string }): void {
  assert.equal(result.ok, false, 'expected validation to fail (ok: false), got ok: true');
  const found = findError(result, match);
  assert.ok(
    found,
    `expected an error matching ${JSON.stringify(match)}; received errors:\n` +
      JSON.stringify(result.errors, null, 2),
  );
}

function addValidGroup(manifest: Manifest): void {
  (firstFastCheck(manifest) as unknown as Record<string, unknown>)['group'] = 'quality';
  (manifest as unknown as Record<string, unknown>)['groups'] = [
    {
      name: 'quality',
      argv: ['group-check'],
      artifact_dir: '.artifacts/groups',
      members: [{ check: 'typecheck', result_key: 'typecheck' }],
    },
  ];
}

test('valid manifest passes', () => {
  const result = validate(makeManifest());
  assert.equal(
    result.ok,
    true,
    `expected valid manifest to pass; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
  assert.equal(result.errors.length, 0, 'expected zero errors for a valid manifest');
});

test('valid groups declaration and check group reference pass structurally', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  const result = validate(manifest);
  assert.equal(
    result.ok,
    true,
    `expected valid groups to pass; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
});

test('groups must be an array', () => {
  const manifest = makeManifest();
  (manifest as unknown as Record<string, unknown>)['groups'] = {};
  expectError(validate(manifest), { path: 'groups', rule: 'type' });
});

test('group declarations require name, argv, artifact_dir, and members', () => {
  const manifest = makeManifest();
  (manifest as unknown as Record<string, unknown>)['groups'] = [{}];
  const result = validate(manifest);
  for (const key of ['name', 'argv', 'artifact_dir', 'members']) {
    expectError(result, { path: `groups[0].${key}`, rule: 'required' });
  }
});

test('group declarations reject additional properties', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  const groups = (manifest as unknown as { groups: Array<Record<string, unknown>> }).groups;
  groups[0]!['unexpected_key'] = true;
  expectError(validate(manifest), { path: 'groups[0].unexpected_key', rule: 'additional-property' });
});

test('group argv requires at least one non-empty string', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  const group = (manifest as unknown as { groups: Array<Record<string, unknown>> }).groups[0]!;
  group['argv'] = [''];
  expectError(validate(manifest), { path: 'groups[0].argv[0]', rule: 'min-length' });
});

test('group members requires at least one member', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  const group = (manifest as unknown as { groups: Array<Record<string, unknown>> }).groups[0]!;
  group['members'] = [];
  expectError(validate(manifest), { path: 'groups[0].members', rule: 'min-items' });
});

test('group members require check and result_key', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  const group = (manifest as unknown as { groups: Array<Record<string, unknown>> }).groups[0]!;
  group['members'] = [{}];
  const result = validate(manifest);
  expectError(result, { path: 'groups[0].members[0].check', rule: 'required' });
  expectError(result, { path: 'groups[0].members[0].result_key', rule: 'required' });
});

test('group members reject additional properties', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  const members = (
    manifest as unknown as { groups: Array<{ members: Array<Record<string, unknown>> }> }
  ).groups[0]!.members;
  members[0]!['unexpected_key'] = true;
  expectError(validate(manifest), {
    path: 'groups[0].members[0].unexpected_key',
    rule: 'additional-property',
  });
});

test('check group must be a non-empty string', () => {
  const manifest = makeManifest();
  (firstFastCheck(manifest) as unknown as Record<string, unknown>)['group'] = '';
  expectError(validate(manifest), { path: 'tiers.fast[0].group', rule: 'min-length' });
});

test('missing timeout_seconds fails at tiers.fast[0].timeout_seconds', () => {
  const manifest = makeManifest();
  delete (firstFastCheck(manifest) as unknown as { timeout_seconds?: number }).timeout_seconds;
  expectError(validate(manifest), { path: 'tiers.fast[0].timeout_seconds', rule: 'required' });
});

test('tier timeout sum over budget fails with rule tier-budget', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).timeout_seconds = manifest.budgets.fast_seconds + 1;
  expectError(validate(manifest), { rule: 'tier-budget' });
});

test('unknown stack enum fails at stack', () => {
  const manifest = makeManifest();
  (manifest as unknown as { stack: string }).stack = 'not-a-stack';
  expectError(validate(manifest), { path: 'stack', rule: 'enum' });
});

test('non-array argv fails at tiers.fast[0].argv', () => {
  const manifest = makeManifest();
  (firstFastCheck(manifest) as unknown as { argv: string }).argv = 'npm run typecheck';
  expectError(validate(manifest), { path: 'tiers.fast[0].argv', rule: 'type' });
});

test('unknown {files:name} token fails with rule files-token-reference', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).argv = ['eslint', '{files:nope}'];
  expectError(validate(manifest), { rule: 'files-token-reference' });
});

test('operational_exit_codes: a valid unique integer array in [1,255] passes', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).operational_exit_codes = [2, 3];
  const result = validate(manifest);
  assert.equal(
    result.ok,
    true,
    `expected a valid operational_exit_codes to pass; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
});

test('operational_exit_codes: wrong type (not an array) fails with rule type', () => {
  const manifest = makeManifest();
  (firstFastCheck(manifest) as unknown as { operational_exit_codes: number }).operational_exit_codes = 2;
  expectError(validate(manifest), { path: 'tiers.fast[0].operational_exit_codes', rule: 'type' });
});

test('operational_exit_codes: empty array fails with rule min-items', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).operational_exit_codes = [];
  expectError(validate(manifest), { path: 'tiers.fast[0].operational_exit_codes', rule: 'min-items' });
});

test('operational_exit_codes: 0 is out of range and fails at item index with rule type', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).operational_exit_codes = [0];
  expectError(validate(manifest), { path: 'tiers.fast[0].operational_exit_codes[0]', rule: 'type' });
});

test('operational_exit_codes: 256 is out of range and fails at item index with rule type', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).operational_exit_codes = [256];
  expectError(validate(manifest), { path: 'tiers.fast[0].operational_exit_codes[0]', rule: 'type' });
});

test('operational_exit_codes: a non-integer item fails at item index with rule type', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).operational_exit_codes = [2.5];
  expectError(validate(manifest), { path: 'tiers.fast[0].operational_exit_codes[0]', rule: 'type' });
});

test('operational_exit_codes: duplicate items fail with rule unique-items', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).operational_exit_codes = [2, 2];
  expectError(validate(manifest), { path: 'tiers.fast[0].operational_exit_codes[1]', rule: 'unique-items' });
});

function validDeepReview(): NonNullable<Manifest['deep_review']> {
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

function setDeepReview(manifest: Manifest, value: unknown): void {
  (manifest as unknown as Record<string, unknown>)['deep_review'] = value;
}

test('manifest with no deep_review still passes', () => {
  const manifest = makeManifest();
  delete (manifest as unknown as { deep_review?: unknown }).deep_review;
  const result = validate(manifest);
  assert.equal(
    result.ok,
    true,
    `expected a manifest without deep_review to pass; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
});

test('valid deep_review block passes', () => {
  const manifest = makeManifest();
  manifest.deep_review = validDeepReview();
  const result = validate(manifest);
  assert.equal(
    result.ok,
    true,
    `expected a valid deep_review block to pass; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
});

test('deep_review missing enabled fails at deep_review.enabled with rule required', () => {
  const manifest = makeManifest();
  const block = validDeepReview();
  delete (block as { enabled?: boolean }).enabled;
  setDeepReview(manifest, block);
  expectError(validate(manifest), { path: 'deep_review.enabled', rule: 'required' });
});

test('deep_review.enabled with the wrong type fails with rule type', () => {
  const manifest = makeManifest();
  const block = validDeepReview();
  (block as unknown as { enabled: string }).enabled = 'yes';
  setDeepReview(manifest, block);
  expectError(validate(manifest), { path: 'deep_review.enabled', rule: 'type' });
});

test('deep_review.modes with an unknown mode fails with rule enum', () => {
  const manifest = makeManifest();
  const block = validDeepReview();
  (block as unknown as { modes: string[] }).modes = ['review-only', 'rewrite-everything'];
  setDeepReview(manifest, block);
  expectError(validate(manifest), { path: 'deep_review.modes[1]', rule: 'enum' });
});

test('deep_review with an additional property fails with rule additional-property', () => {
  const manifest = makeManifest();
  const block = validDeepReview();
  (block as unknown as Record<string, unknown>)['unexpected_key'] = true;
  setDeepReview(manifest, block);
  expectError(validate(manifest), {
    path: 'deep_review.unexpected_key',
    rule: 'additional-property',
  });
});

test('deep_review.budget.seconds <= 0 fails at deep_review.budget.seconds', () => {
  const manifest = makeManifest();
  const block = validDeepReview();
  block.budget = { seconds: 0 };
  setDeepReview(manifest, block);
  expectError(validate(manifest), { path: 'deep_review.budget.seconds' });
});

test('deep_review.verify_entry empty string fails at deep_review.verify_entry with rule min-length', () => {
  const manifest = makeManifest();
  const block = validDeepReview();
  (block as { verify_entry?: string }).verify_entry = '';
  setDeepReview(manifest, block);
  expectError(validate(manifest), { path: 'deep_review.verify_entry', rule: 'min-length' });
});
