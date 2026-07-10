import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runValidate } from '../../runner/src/validate-quality-manifest.ts';
import { run as runMigrate } from '../../runner/src/migrate-quality-manifest.ts';
import type { Manifest } from '../../runner/src/types.ts';

const validManifest: Manifest = {
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

function writeTempManifest(contents: string): { manifestPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cli-'));
  const manifestPath = path.join(dir, 'quality.json');
  fs.writeFileSync(manifestPath, contents, 'utf8');
  return { manifestPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function missingManifestPath(): { manifestPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cli-'));
  return {
    manifestPath: path.join(dir, 'does-not-exist.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('validate: missing --manifest prints usage on stderr and exits 2', () => {
  const result = runValidate([]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout.length, 0, 'usage faults must not write to stdout');
  assert.ok(
    result.stderr.some((line) => /usage/i.test(line)),
    `expected a usage message; got ${JSON.stringify(result.stderr)}`,
  );
});

test('validate: --manifest without a value exits 2', () => {
  const result = runValidate(['--manifest']);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.length > 0, 'expected a usage message on stderr');
});

test('validate: an unknown/extra argument exits 2', () => {
  const result = runValidate(['--manifest', 'quality.json', '--surprise']);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.length > 0, 'expected a usage message on stderr');
});

test('validate: a nonexistent manifest path exits 1', () => {
  const { manifestPath, cleanup } = missingManifestPath();
  try {
    const result = runValidate(['--manifest', manifestPath]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.length > 0, 'expected at least one error line on stderr');
  } finally {
    cleanup();
  }
});

test('validate: invalid manifest exits 1 and prints every validation error', () => {
  // Two independent faults prove every validator error is surfaced.
  const broken = { ...validManifest, stack: 'not-a-stack', version: 2 };
  const { manifestPath, cleanup } = writeTempManifest(JSON.stringify(broken));
  try {
    const result = runValidate(['--manifest', manifestPath]);
    assert.equal(result.code, 1);
    const blob = result.stderr.join('\n');
    assert.match(blob, /stack/, `expected the stack error; got ${blob}`);
    assert.match(blob, /version/, `expected the version error; got ${blob}`);
  } finally {
    cleanup();
  }
});

test('validate: invalid JSON exits 1', () => {
  const { manifestPath, cleanup } = writeTempManifest('{ not valid json');
  try {
    const result = runValidate(['--manifest', manifestPath]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.length > 0, 'expected the json-parse error on stderr');
  } finally {
    cleanup();
  }
});

test('validate: a valid manifest exits 0 with the "valid quality manifest" phrase', () => {
  const { manifestPath, cleanup } = writeTempManifest(JSON.stringify(validManifest));
  try {
    const result = runValidate(['--manifest', manifestPath]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr.length, 0, 'a valid manifest must not write to stderr');
    assert.match(
      result.stdout.join('\n'),
      /valid quality manifest/,
      `expected the exact success phrase; got ${JSON.stringify(result.stdout)}`,
    );
  } finally {
    cleanup();
  }
});

test('migrate: missing --manifest exits 2', () => {
  const result = runMigrate([]);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.length > 0, 'expected a usage message on stderr');
});

test('migrate: an unknown/extra argument exits 2', () => {
  const result = runMigrate(['--manifest', 'quality.json', '--surprise']);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.length > 0, 'expected a usage message on stderr');
});

test('migrate: an invalid manifest exits 1 and prints validation errors', () => {
  const broken = { ...validManifest, stack: 'not-a-stack' };
  const { manifestPath, cleanup } = writeTempManifest(JSON.stringify(broken));
  try {
    const result = runMigrate(['--manifest', manifestPath]);
    assert.equal(result.code, 1);
    assert.match(result.stderr.join('\n'), /stack/, 'expected the stack error on stderr');
  } finally {
    cleanup();
  }
});

test('migrate: a valid version-1 manifest exits 0 and reports no available migration', () => {
  const { manifestPath, cleanup } = writeTempManifest(JSON.stringify(validManifest));
  try {
    const result = runMigrate(['--manifest', manifestPath]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr.length, 0, 'a clean run must not write to stderr');
    const blob = result.stdout.join('\n');
    assert.match(blob, /no .*migration/i, `expected a "no migration" message; got ${blob}`);
    assert.match(blob, /\b1\b/, `expected the schema version 1 to be named; got ${blob}`);
  } finally {
    cleanup();
  }
});
