// Black-box test for the verify-runner error boundary. Like fixtures.test.ts,
// it BUILDS the verify-runner bundle in a `before()` hook (the other two
// `npm run build` entrypoints are Task 9 and don't exist yet, so only
// verify-runner.ts is bundled). Unlike fixtures.test.ts it is fully
// self-contained: it creates its OWN non-git tmpdir and manifest, so it is
// safe to run any time.
//
// It pins the contract that a tier run in a non-git directory fails CLEANLY:
// `git ls-files` throws during fileset expansion, but the entrypoint converts
// that crash into a one-line stderr message and a non-zero exit, never an
// uncaught stack trace (which would also leak the absolute cwd).
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from this file (tests/runner/verify-runner.test.ts -> ../../).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerPath = path.join(repoRoot, 'runner', 'dist', 'verify-runner.mjs');

/** A minimal manifest that passes the hand validator: one repo_all fileset and a
 * fast tier with one trivial check, all tier timeout sums within budget. */
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
  // Build only verify-runner.ts (Task 9 entrypoints do not exist yet), with the
  // same flags as the root build script, so the suite is robust to task order.
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

    // Non-zero exit: fileset expansion runs `git ls-files` which fails here.
    assert.equal(typeof run.status, 'number', 'runner must exit with a numeric status');
    assert.notEqual(run.status, 0, 'a tier run in a non-git dir must exit non-zero');

    // Clean failure: a single-line message, never an uncaught Node stack trace
    // (which would render `    at <frame>` lines and leak the absolute cwd).
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
