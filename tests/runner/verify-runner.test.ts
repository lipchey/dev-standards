import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerPath = path.join(repoRoot, 'runner', 'dist', 'verify-runner.mjs');

const MANIFEST = {
  version: 1,
  repo: 'tmp-non-git',
  stack: 'node-service',
  scheduler_class: 'local-only',
  budgets: { staged_seconds: 15, fast_seconds: 90, full_seconds: 300, audit_seconds: 300 },
  policy: {
    mutates_by_default: false,
    format_fix_staged_allowed: false,
    typed_eslint_in_precommit: false,
    block_new_dead_code_only: true,
  },
  paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
  generated: { hooks_dir: '.githooks' },
  workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
  filesets: [{ name: 'repo_ts', source: 'repo_all', include: ['src/**/*.ts'], exclude: [] }],
  tiers: {
    staged: [],
    fast: [{ name: 'noop', argv: ['node', '--version'], timeout_seconds: 5 }],
    full: [],
    audit: [],
  },
} as const;

before(() => {
  const build = spawnSync(
    'npx',
    [
      'esbuild',
      'runner/src/verify-runner.ts',
      '--bundle',
      '--platform=node',
      '--target=node20',
      '--format=esm',
      '--sourcemap=external',
      '--outdir=runner/dist',
      '--out-extension:.js=.mjs',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  assert.equal(build.status, 0, 'esbuild build of verify-runner.ts must succeed');
});

test('a tier run in a non-git dir fails cleanly: non-zero exit, no stack trace', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runner-'));
  try {
    const manifestPath = path.join(tmp, 'quality.json');
    fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST), 'utf8');

    const run = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
    });

    assert.equal(typeof run.status, 'number', 'runner must exit with a numeric status');
    assert.notEqual(run.status, 0, 'a tier run in a non-git dir must exit non-zero');

    // Stack frames would leak the absolute cwd.
    assert.doesNotMatch(
      run.stderr,
      /\n\s+at /,
      `stderr must not contain a stack frame, got:\n${run.stderr}`,
    );
    assert.match(
      run.stderr,
      /error running fast tier:/,
      `stderr must include the clean error prefix, got:\n${run.stderr}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
