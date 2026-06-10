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

/**
 * Additive quality-pass coverage of the frozen semantic rule vocabulary: one
 * focused failure case per semantic rule that previously had no committed
 * test, path-pinning cases for the rules the plan-pinned tests assert by
 * rule only, plus a collect-all case proving independent violations surface
 * in a single `validate()` result. The 7 plan-pinned cases live in
 * validate.test.ts; the structural dual-validator battery lives in
 * validate.conformance.test.ts. Assertions here pin paths and rules only —
 * never message text — so wording may evolve without touching this file.
 */

/**
 * Minimal but complete valid manifest (mirrors validate.test.ts). Budgets are
 * sized so each case needs only one small mutation — e.g. a second fast-tier
 * check fits inside `fast_seconds` without tripping `tier-budget`.
 */
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

/** Deep-fresh valid manifest per call; tests mutate their own copy freely. */
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

/** Asserts ok === false plus the presence of a matching error, dumping actual errors on miss. */
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
  // Type-valid mutation: both tokens reference the declared "repo_ts" fileset,
  // so only the at-most-one-token rule fires.
  firstFastCheck(manifest).argv = ['tool', '{files:repo_ts}', '{files:repo_ts}'];
  expectError(validate(manifest), { path: 'tiers.fast[0].argv', rule: 'files-token-count' });
});

test('{files:...} token in argv[0] fails with rule files-token-position', () => {
  const manifest = makeManifest();
  // Type-valid mutation: a single declared token, but in the executable slot.
  firstFastCheck(manifest).argv = ['{files:repo_ts}'];
  expectError(validate(manifest), { path: 'tiers.fast[0].argv[0]', rule: 'files-token-position' });
});

test('undeclared {files:...} token pins its error to the token argv index', () => {
  const manifest = makeManifest();
  // validate.test.ts pins this rule (plan case 6) by rule only; this case
  // additionally pins the reported path to the offending argv element.
  firstFastCheck(manifest).argv = ['tool', '{files:nope}'];
  expectError(validate(manifest), { path: 'tiers.fast[0].argv[1]', rule: 'files-token-reference' });
});

test('skip_if_empty naming an undeclared fileset fails with rule skip-if-empty-reference', () => {
  const manifest = makeManifest();
  // Type-valid mutation: skip_if_empty is any string; "nope" is not a declared fileset.
  firstFastCheck(manifest).skip_if_empty = 'nope';
  expectError(validate(manifest), {
    path: 'tiers.fast[0].skip_if_empty',
    rule: 'skip-if-empty-reference',
  });
});

// glob-dialect rejects the full banned set ("?", "[", "{") in BOTH include and
// exclude — the validator's UNSUPPORTED_GLOB_SYNTAX and the schema's `include`
// description agree on all three. Table-drive every construct × field so
// dropping any one from the dialect guard (or stopping the include walk) fails.
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
      // Each pattern carries exactly one banned construct over otherwise-literal
      // segments, so glob-dialect is the only rule in play. source is repo_all,
      // so swapping include for a bad pattern keeps it the lone violation.
      firstFileset(manifest)[field] = [construct.pattern];
      expectError(validate(manifest), { path: `filesets[0].${field}[0]`, rule: 'glob-dialect' });
    });
  }
}

test('diff_filter on a repo_all fileset fails with rule diff-filter-scope', () => {
  const manifest = makeManifest();
  // Type-valid mutation: the fixture fileset's source is repo_all, where diff_filter is meaningless.
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
  // Reuses the fast[0] name; the small timeout keeps the tier inside fast_seconds,
  // so check-name-unique is the only rule in play.
  manifest.tiers.fast.push({ name: 'typecheck', argv: ['npm', 'run', 'lint'], timeout_seconds: 10 });
  expectError(validate(manifest), { path: 'tiers.fast[1].name', rule: 'check-name-unique' });
});

test('same check name in two different tiers is accepted', () => {
  const manifest = makeManifest();
  // Check-name uniqueness is scoped per tier: "typecheck" already exists in fast.
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

test('workflow.enabled true pins its error to workflow.enabled', () => {
  const manifest = makeManifest();
  // validate.test.ts pins this rule (plan case 7) by rule only; this case
  // additionally pins the reported path.
  (manifest as unknown as { workflow: { enabled: boolean } }).workflow = { enabled: true };
  expectError(validate(manifest), { path: 'workflow.enabled', rule: 'workflow-enabled' });
});

test('independent violations are all collected in one validate() result', () => {
  const manifest = makeManifest();
  // Three unrelated mutations: a structural enum break, a semantic budget break,
  // and a semantic uniqueness break. validate() must report every one of them.
  // Invalid by construction: not a Stack enum member, so cast narrowly to assign it.
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
