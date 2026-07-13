import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../runner/src/validate.ts';
import type { Manifest, ValidationResult } from '../../runner/src/types.ts';

// Base manifest carrying a git_staged fileset + a valid format block, mutated per case.
const baseManifest: Manifest = {
  version: 1,
  repo: 'fixture-repo',
  stack: 'node-service',
  scheduler_class: 'local-only',
  budgets: { staged_seconds: 10, fast_seconds: 60, full_seconds: 120, audit_seconds: 120 },
  policy: {
    mutates_by_default: false,
    format_fix_staged_allowed: true,
    typed_eslint_in_precommit: false,
    block_new_dead_code_only: true,
  },
  paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
  generated: { hooks_dir: '.githooks' },
  workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
  filesets: [{ name: 'staged_fmt', source: 'git_staged', include: ['src/**/*.ts'] }],
  tiers: { staged: [], fast: [], full: [] },
  format: { argv: ['prettier', '--write'], fileset: 'staged_fmt', timeout_seconds: 30 },
};

function makeManifest(): Manifest {
  return structuredClone(baseManifest);
}

function expectError(result: ValidationResult, match: { path?: string; rule?: string }): void {
  assert.equal(result.ok, false, `expected invalid; errors:\n${JSON.stringify(result.errors, null, 2)}`);
  assert.ok(
    result.errors.some(
      (e) => (match.path === undefined || e.path === match.path) && (match.rule === undefined || e.rule === match.rule),
    ),
    `expected an error matching ${JSON.stringify(match)}; received:\n${JSON.stringify(result.errors, null, 2)}`,
  );
}

test('a valid format block referencing a git_staged fileset validates', () => {
  assert.equal(validate(makeManifest()).ok, true);
});

test('a manifest with no format block validates (format is optional)', () => {
  const manifest = makeManifest();
  delete manifest.format;
  assert.equal(validate(manifest).ok, true);
});

test('missing format.argv fails with rule required', () => {
  const manifest = makeManifest();
  delete (manifest.format as { argv?: unknown }).argv;
  expectError(validate(manifest), { path: 'format.argv', rule: 'required' });
});

test('empty format.argv fails with rule min-items', () => {
  const manifest = makeManifest();
  manifest.format!.argv = [];
  expectError(validate(manifest), { path: 'format.argv', rule: 'min-items' });
});

test('non-positive format.timeout_seconds fails with rule type', () => {
  const manifest = makeManifest();
  manifest.format!.timeout_seconds = 0;
  expectError(validate(manifest), { path: 'format.timeout_seconds', rule: 'type' });
});

test('unknown key in format fails with rule additional-property', () => {
  const manifest = makeManifest();
  (manifest.format as unknown as Record<string, unknown>)['mode'] = 'blocking';
  expectError(validate(manifest), { path: 'format.mode', rule: 'additional-property' });
});

test('format.fileset referencing an undeclared fileset fails', () => {
  const manifest = makeManifest();
  manifest.format!.fileset = 'nope';
  expectError(validate(manifest), { path: 'format.fileset', rule: 'format-fileset-reference' });
});

test('format.fileset pointing at a repo_all fileset fails with format-fileset-source', () => {
  const manifest = makeManifest();
  manifest.filesets[0]!.source = 'repo_all';
  expectError(validate(manifest), { path: 'format.fileset', rule: 'format-fileset-source' });
});

test('a format fileset diff_filter including deleted (D) fails with format-fileset-filter', () => {
  const manifest = makeManifest();
  manifest.filesets[0]!.diff_filter = 'ACMRD';
  expectError(validate(manifest), { path: 'format.fileset', rule: 'format-fileset-filter' });
});

test('a format fileset diff_filter within ACMR validates', () => {
  const manifest = makeManifest();
  manifest.filesets[0]!.diff_filter = 'AM';
  assert.equal(validate(manifest).ok, true);
});
