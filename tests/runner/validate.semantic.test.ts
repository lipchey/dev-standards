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

interface MutableGroupMember {
  check: string;
  result_key: string;
}

interface MutableGroup {
  name: string;
  argv: string[];
  artifact_dir: string;
  members: MutableGroupMember[];
}

function addValidGroup(manifest: Manifest): MutableGroup {
  (firstFastCheck(manifest) as unknown as Record<string, unknown>)['group'] = 'quality';
  const group: MutableGroup = {
    name: 'quality',
    argv: ['group-check'],
    artifact_dir: '.artifacts/groups',
    members: [{ check: 'typecheck', result_key: 'typecheck' }],
  };
  (manifest as unknown as { groups: MutableGroup[] }).groups = [group];
  return group;
}

function expectGroupError(
  manifest: Manifest,
  match: { path: string; rule: string },
  message: RegExp,
): void {
  const result = validate(manifest);
  expectError(result, match);
  const error = findError(result, match);
  assert.ok(error);
  assert.match(error.message, message);
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

test('a grouped check declaring operational_exit_codes is not batchable', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  firstFastCheck(manifest).operational_exit_codes = [2];
  expectGroupError(
    manifest,
    { path: 'tiers.fast[0].operational_exit_codes', rule: 'group-eligibility' },
    /declares operational_exit_codes.*not batchable/,
  );
});

test('a grouped check declaring skip_if_empty is not batchable', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  firstFastCheck(manifest).skip_if_empty = 'repo_ts';
  expectGroupError(
    manifest,
    { path: 'tiers.fast[0].skip_if_empty', rule: 'group-eligibility' },
    /declares skip_if_empty.*not batchable/,
  );
});

test('a grouped check with bypassable true is not batchable', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  firstFastCheck(manifest).bypassable = true;
  expectGroupError(
    manifest,
    { path: 'tiers.fast[0].bypassable', rule: 'group-eligibility' },
    /bypassable true.*not batchable/,
  );
});

test('a grouped check explicitly declaring bypassable false is batchable', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  firstFastCheck(manifest).bypassable = false;
  assert.deepEqual(validate(manifest), { ok: true, errors: [] });
});

test('a grouped check with non-blocking mode is not batchable', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  firstFastCheck(manifest).mode = 'report-only';
  expectGroupError(
    manifest,
    { path: 'tiers.fast[0].mode', rule: 'group-eligibility' },
    /mode "report-only".*not batchable/,
  );
});

test('a grouped check explicitly declaring blocking mode is batchable', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  firstFastCheck(manifest).mode = 'blocking';
  assert.deepEqual(validate(manifest), { ok: true, errors: [] });
});

test('a check group reference must name a declared group', () => {
  const manifest = makeManifest();
  (firstFastCheck(manifest) as unknown as Record<string, unknown>)['group'] = 'missing';
  expectGroupError(
    manifest,
    { path: 'tiers.fast[0].group', rule: 'group-reference' },
    /references undeclared group "missing"/,
  );
});

test('every check naming a group must appear in that group members list', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  group.members = [{ check: 'other', result_key: 'other' }];
  manifest.tiers.fast.push({ name: 'other', argv: ['other-check'], timeout_seconds: 10 });
  expectGroupError(
    manifest,
    { path: 'tiers.fast[0].group', rule: 'group-membership' },
    /check "typecheck" names group "quality" but is absent from its members/,
  );
});

test('every group member must name a check assigned to that group', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  manifest.tiers.fast.push({ name: 'other', argv: ['other-check'], timeout_seconds: 10 });
  group.members.push({ check: 'other', result_key: 'other' });
  expectGroupError(
    manifest,
    { path: 'groups[0].members[1].check', rule: 'group-membership' },
    /member check "other" is not assigned to group "quality"/,
  );
});

test('a group member must name an existing check', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  group.members.push({ check: 'missing', result_key: 'missing' });
  expectGroupError(
    manifest,
    { path: 'groups[0].members[1].check', rule: 'group-membership' },
    /member check "missing" does not exist/,
  );
});

test('all group members must live in one tier', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  manifest.tiers.full.push({
    name: 'other',
    argv: ['other-check'],
    timeout_seconds: 10,
    group: 'quality',
  });
  group.members.push({ check: 'other', result_key: 'other' });
  expectGroupError(
    manifest,
    { path: 'groups[0].members[1].check', rule: 'group-tier' },
    /group "quality" spans tiers "fast" and "full"/,
  );
});

test('group names must be unique', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  (manifest as unknown as { groups: MutableGroup[] }).groups.push(structuredClone(group));
  expectGroupError(
    manifest,
    { path: 'groups[1].name', rule: 'group-name-unique' },
    /duplicate group name "quality"/,
  );
});

test('member result_key values must be unique within a group', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  manifest.tiers.fast.push({
    name: 'other',
    argv: ['other-check'],
    timeout_seconds: 10,
    group: 'quality',
  });
  group.members.push({ check: 'other', result_key: 'typecheck' });
  expectGroupError(
    manifest,
    { path: 'groups[0].members[1].result_key', rule: 'group-membership' },
    /duplicate result_key "typecheck" in group "quality"/,
  );
});

// A check name is unique per tier only, so one member name can resolve to two tiers at once —
// a shape the two-member spanning case never reaches.
test('a single member resolving into two tiers spans tiers', () => {
  const manifest = makeManifest();
  addValidGroup(manifest);
  manifest.tiers.full.push({
    name: 'typecheck',
    argv: ['npm', 'run', 'typecheck'],
    timeout_seconds: 10,
    group: 'quality',
  });
  expectGroupError(
    manifest,
    { path: 'groups[0].members[0].check', rule: 'group-tier' },
    /spans tiers/,
  );
});

test('member check values must be unique within a group', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  group.members.push({ check: 'typecheck', result_key: 'other' });
  expectGroupError(
    manifest,
    { path: 'groups[0].members[1].check', rule: 'group-membership' },
    /duplicate member check "typecheck" in group "quality"/,
  );
});

test('group argv rejects fileset tokens', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  group.argv.push('{files:repo_ts}');
  expectGroupError(
    manifest,
    { path: 'groups[0].argv[1]', rule: 'group-argv-token' },
    /group argv cannot contain a \{files:<fileset>\} token/,
  );
});

test('group argv rejects fileset tokens containing a line break', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  group.argv.push('{files:\nrepo_ts}');
  expectGroupError(
    manifest,
    { path: 'groups[0].argv[1]', rule: 'group-argv-token' },
    /group argv cannot contain a \{files:<fileset>\} token/,
  );
});

test('a group cannot declare timeout_seconds', () => {
  const manifest = makeManifest();
  const group = addValidGroup(manifest);
  (group as unknown as Record<string, unknown>)['timeout_seconds'] = 30;
  expectError(validate(manifest), { path: 'groups[0].timeout_seconds', rule: 'additional-property' });
});

const invalidArtifactDirs = [
  { label: 'parent segment', value: 'artifacts/../outside' },
  { label: 'current segment', value: 'artifacts/./result' },
  { label: 'absolute path', value: '/artifacts/result' },
  { label: 'drive letter', value: 'C:/artifacts/result' },
  { label: 'backslash', value: 'artifacts\\result' },
  { label: 'bad character', value: 'artifacts/result!' },
] as const;

for (const { label, value } of invalidArtifactDirs) {
  test(`group artifact_dir rejects ${label}`, () => {
    const manifest = makeManifest();
    const group = addValidGroup(manifest);
    group.artifact_dir = value;
    expectGroupError(
      manifest,
      { path: 'groups[0].artifact_dir', rule: 'group-path' },
      /relative POSIX path/,
    );
  });
}

const invalidGroupNames = ['nested/group', '.', '..'] as const;

for (const name of invalidGroupNames) {
  test(`group name rejects ${JSON.stringify(name)}`, () => {
    const manifest = makeManifest();
    const group = addValidGroup(manifest);
    group.name = name;
    (firstFastCheck(manifest) as unknown as Record<string, unknown>)['group'] = name;
    expectGroupError(
      manifest,
      { path: 'groups[0].name', rule: 'group-path' },
      /single path segment/,
    );
  });
}

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
