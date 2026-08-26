import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest } from '../../runner/src/manifest.ts';
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
    fast: [{ name: 'typecheck', argv: ['npm', 'run', 'typecheck'], timeout_seconds: 30, covers: ['.'] }],
    full: [],
  },
};

function writeTempManifest(contents: string): { manifestPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
  const manifestPath = path.join(dir, 'quality.json');
  fs.writeFileSync(manifestPath, contents, 'utf8');
  return { manifestPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('loadManifest reads JSON and returns a Manifest', () => {
  const { manifestPath, cleanup } = writeTempManifest(JSON.stringify(validManifest));
  try {
    const result = loadManifest(manifestPath);
    assert.ok(result.ok, `expected ok; got ${JSON.stringify(result)}`);
    assert.deepEqual(result.manifest, validManifest);
  } finally {
    cleanup();
  }
});

test('loadManifest returns validation errors before runner execution', () => {
  const broken = { ...validManifest, stack: 'not-a-stack' };
  const { manifestPath, cleanup } = writeTempManifest(JSON.stringify(broken));
  try {
    const result = loadManifest(manifestPath);
    assert.ok(!result.ok, `expected validation failure; got ${JSON.stringify(result)}`);
    const stackError = result.errors.find((e) => e.path === 'stack' && e.rule === 'enum');
    assert.ok(
      stackError,
      `expected a stack/enum validation error; got ${JSON.stringify(result.errors)}`,
    );
  } finally {
    cleanup();
  }
});

test('loadManifest reports invalid JSON as a validation-style error at path ""', () => {
  const { manifestPath, cleanup } = writeTempManifest('{ this is not valid json');
  try {
    const result = loadManifest(manifestPath);
    assert.ok(!result.ok, `expected parse failure; got ${JSON.stringify(result)}`);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.path, '');
    assert.equal(result.errors[0]?.rule, 'json-parse');
  } finally {
    cleanup();
  }
});
