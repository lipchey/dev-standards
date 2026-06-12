import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../runner/src/validate.ts';
import type {
  Check,
  Fileset,
  Manifest,
  ValidationError,
  ValidationResult,
} from '../../runner/src/types.ts';

// Pins semantic rule/path contracts; message text may evolve.
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
  workflow: { enabled: false },
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

function firstFileset(manifest: Manifest): Fileset {
  const fileset = manifest.filesets[0];
  if (fileset === undefined) {
    throw new Error('fixture manifest must declare one fileset');
  }
  return fileset;
}

// Full §2.8 workflow object; enabled:true demands every key.
function enabledWorkflow(): Record<string, unknown> {
  return {
    schema: 1,
    enabled: true,
    base_branch: 'main',
    worktree_parent: '../worktrees',
    cmux_mode: 'manual',
    loopback_mode: 'manual',
    reviewer_independence: 'different-runtime',
    required_review_guides: [],
    commit_exclude: ['reports/**'],
    archive: true,
    timeouts: { default_wait_seconds: 1800, default_work_seconds: 1800 },
    budget: { workflow_total_seconds: 5400 },
    agents: { claude: ['claude'], codex: ['codex'] },
    ship: { ci_wait_seconds: 1800, notify: true },
    notify: { webhook_env: 'WORKFLOW_NOTIFY_WEBHOOK' },
  };
}

function withWorkflow(workflow: unknown): Manifest {
  const manifest = makeManifest();
  (manifest as unknown as Record<string, unknown>)['workflow'] = workflow;
  return manifest;
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

test('two {files:...} tokens in one argv fail with rule files-token-count', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).argv = ['tool', '{files:repo_ts}', '{files:repo_ts}'];
  expectError(validate(manifest), { path: 'tiers.fast[0].argv', rule: 'files-token-count' });
});

test('{files:...} token in argv[0] fails with rule files-token-position', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).argv = ['{files:repo_ts}'];
  expectError(validate(manifest), { path: 'tiers.fast[0].argv[0]', rule: 'files-token-position' });
});

test('undeclared {files:...} token pins its error to the token argv index', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).argv = ['tool', '{files:nope}'];
  expectError(validate(manifest), { path: 'tiers.fast[0].argv[1]', rule: 'files-token-reference' });
});

test('skip_if_empty naming an undeclared fileset fails with rule skip-if-empty-reference', () => {
  const manifest = makeManifest();
  firstFastCheck(manifest).skip_if_empty = 'nope';
  expectError(validate(manifest), {
    path: 'tiers.fast[0].skip_if_empty',
    rule: 'skip-if-empty-reference',
  });
});

// Keep schema docs and validator dialect in lockstep for every banned construct and field.
const bannedGlobConstructs: ReadonlyArray<{ label: string; pattern: string }> = [
  { label: '"?"', pattern: 'src/?.ts' },
  { label: '"["', pattern: 'src/[abc].ts' },
  { label: '"{"', pattern: 'src/{a,b}.ts' },
];
const globPatternFields = ['include', 'exclude'] as const;

for (const field of globPatternFields) {
  for (const construct of bannedGlobConstructs) {
    test(`${construct.label} in a fileset ${field} pattern fails with rule glob-dialect`, () => {
      const manifest = makeManifest();
      firstFileset(manifest)[field] = [construct.pattern];
      expectError(validate(manifest), { path: `filesets[0].${field}[0]`, rule: 'glob-dialect' });
    });
  }
}

test('diff_filter on a repo_all fileset fails with rule diff-filter-scope', () => {
  const manifest = makeManifest();
  firstFileset(manifest).diff_filter = 'ACMR';
  expectError(validate(manifest), { path: 'filesets[0].diff_filter', rule: 'diff-filter-scope' });
});

test('duplicate fileset names fail with rule fileset-name-unique', () => {
  const manifest = makeManifest();
  manifest.filesets.push({ name: 'repo_ts', source: 'repo_all', include: ['lib/**/*.ts'] });
  expectError(validate(manifest), { path: 'filesets[1].name', rule: 'fileset-name-unique' });
});

test('duplicate check name within one tier fails with rule check-name-unique', () => {
  const manifest = makeManifest();
  manifest.tiers.fast.push({ name: 'typecheck', argv: ['npm', 'run', 'lint'], timeout_seconds: 10 });
  expectError(validate(manifest), { path: 'tiers.fast[1].name', rule: 'check-name-unique' });
});

test('same check name in two different tiers is accepted', () => {
  const manifest = makeManifest();
  manifest.tiers.full.push({ name: 'typecheck', argv: ['npm', 'run', 'typecheck'], timeout_seconds: 30 });
  const result = validate(manifest);
  assert.equal(
    result.ok,
    true,
    `expected cross-tier name reuse to pass; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
});

test('duplicate workspace names fail with rule workspace-name-unique', () => {
  const manifest = makeManifest();
  manifest.workspaces.push({
    name: 'root',
    path: 'packages/app',
    stack: 'node-service',
    package_manager: 'npm',
  });
  expectError(validate(manifest), { path: 'workspaces[1].name', rule: 'workspace-name-unique' });
});

// workflow §2.8: enabled:true requires the full shape; absent/disabled stays valid.

test('enabled-requires-full-shape: enabled:true with no other keys fails with rule required', () => {
  const result = validate(withWorkflow({ enabled: true }));
  expectError(result, { path: 'workflow.agents', rule: 'required' });
  expectError(result, { path: 'workflow.base_branch', rule: 'required' });
  expectError(result, { path: 'workflow.notify', rule: 'required' });
});

test('agents-nonempty-argv: an empty agents argv fails with rule min-items', () => {
  const workflow = enabledWorkflow();
  workflow['agents'] = { claude: [], codex: ['codex'] };
  expectError(validate(withWorkflow(workflow)), {
    path: 'workflow.agents.claude',
    rule: 'min-items',
  });
});

test('same-argv0-different-runtime-error: shared argv[0] fails with rule workflow-reviewer-independence', () => {
  const workflow = enabledWorkflow();
  workflow['reviewer_independence'] = 'different-runtime';
  workflow['agents'] = { claude: ['runtime'], codex: ['runtime'] };
  expectError(validate(withWorkflow(workflow)), {
    path: 'workflow.agents',
    rule: 'workflow-reviewer-independence',
  });
});

test('same-runtime tolerates a shared argv[0]', () => {
  const workflow = enabledWorkflow();
  workflow['reviewer_independence'] = 'same-runtime';
  workflow['agents'] = { claude: ['runtime'], codex: ['runtime'] };
  const result = validate(withWorkflow(workflow));
  assert.equal(
    result.ok,
    true,
    `expected same-runtime to accept a shared argv[0]; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
});

test('positive-integer-budgets-timeouts: non-positive seconds fail with rule type', () => {
  const workflow = enabledWorkflow();
  workflow['budget'] = { workflow_total_seconds: 0 };
  workflow['timeouts'] = { default_wait_seconds: 0, default_work_seconds: 1800 };
  workflow['ship'] = { ci_wait_seconds: -1, notify: true };
  const result = validate(withWorkflow(workflow));
  expectError(result, { path: 'workflow.budget.workflow_total_seconds', rule: 'type' });
  expectError(result, { path: 'workflow.timeouts.default_wait_seconds', rule: 'type' });
  expectError(result, { path: 'workflow.ship.ci_wait_seconds', rule: 'type' });
});

test('webhook-env-pattern: a non-env-var name fails with rule pattern', () => {
  const workflow = enabledWorkflow();
  workflow['notify'] = { webhook_env: 'not-an-env-var' };
  expectError(validate(withWorkflow(workflow)), {
    path: 'workflow.notify.webhook_env',
    rule: 'pattern',
  });
});

test('disabled-or-absent-passes: minimal and absent workflow both validate', () => {
  const disabled = validate(withWorkflow({ enabled: false }));
  assert.equal(
    disabled.ok,
    true,
    `expected {enabled:false} to pass; received errors:\n${JSON.stringify(disabled.errors, null, 2)}`,
  );
  const absent = makeManifest();
  delete (absent as unknown as { workflow?: unknown }).workflow;
  const absentResult = validate(absent);
  assert.equal(
    absentResult.ok,
    true,
    `expected an absent workflow to pass; received errors:\n${JSON.stringify(absentResult.errors, null, 2)}`,
  );
});

test('a fully specified enabled workflow validates', () => {
  const result = validate(withWorkflow(enabledWorkflow()));
  assert.equal(
    result.ok,
    true,
    `expected a full enabled workflow to pass; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
});

test('independent violations are all collected in one validate() result', () => {
  const manifest = makeManifest();
  (manifest as unknown as { stack: string }).stack = 'not-a-stack';
  firstFastCheck(manifest).timeout_seconds = manifest.budgets.fast_seconds + 1;
  manifest.workspaces.push({
    name: 'root',
    path: 'packages/app',
    stack: 'node-service',
    package_manager: 'npm',
  });
  const result = validate(manifest);
  const expected = [
    { path: 'stack', rule: 'enum' },
    { path: 'tiers.fast', rule: 'tier-budget' },
    { path: 'workspaces[1].name', rule: 'workspace-name-unique' },
  ];
  for (const match of expected) {
    expectError(result, match);
  }
});
