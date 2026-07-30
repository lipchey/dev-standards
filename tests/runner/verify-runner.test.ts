import './helpers/telemetry-off.ts'; // MUST be first: default the sink off for direct (non-npm) runs
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBlockingResult } from '../../runner/src/verify-runner.ts';
import { writeReport } from '../../runner/src/report.ts';
import type { CheckResult } from '../../runner/src/types.ts';

function result(overrides: Partial<CheckResult>): CheckResult {
  return { name: 'c', tier: 'fast', status: 'pass', exitCode: 0, durationMs: 1, mode: 'blocking', ...overrides };
}

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
    fast: [
      {
        name: 'noop',
        argv: ['node', '--version'],
        timeout_seconds: 5,
        skip_if_empty: 'repo_ts',
      },
    ],
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
      env: { ...process.env, DS_TELEMETRY_PATH: 'off' },
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

// isBlockingResult IS the tier's exit decision (`results.some(isBlockingResult) ? 1 : 0`).
// Bug caught: a broken report-only check passing its tier fail-open because 'error' was
// treated as mode-gated like an ordinary finding.
test('isBlockingResult: error blocks in any mode; a report-only finding does not', () => {
  assert.equal(isBlockingResult(result({ status: 'error', mode: 'report-only', exitCode: null })), true);
  assert.equal(isBlockingResult(result({ status: 'error', mode: 'blocking', exitCode: null })), true);
  assert.equal(isBlockingResult(result({ status: 'fail', mode: 'report-only' })), false);
  assert.equal(isBlockingResult(result({ status: 'fail', mode: 'blocking' })), true);
});

// Bug caught: a hung report-only tool being treated as a non-blocking finding even though it
// produced no usable audit result.
test('isBlockingResult: timeout blocks in any mode; bypassed/pass/skipped never block', () => {
  assert.equal(isBlockingResult(result({ status: 'timeout', mode: 'blocking', exitCode: null })), true);
  assert.equal(isBlockingResult(result({ status: 'timeout', mode: 'report-only', exitCode: null })), true);
  assert.equal(isBlockingResult(result({ status: 'bypassed', mode: 'blocking', exitCode: 1, reason: 'x' })), false);
  assert.equal(isBlockingResult(result({ status: 'pass' })), false);
  assert.equal(isBlockingResult(result({ status: 'skipped', exitCode: null })), false);
});

// Bug caught: writeReport filtering out the optional `reason`, so a bypassed/errored check's
// explanation never reaches the persisted report.
test('reason round-trips through the written report JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-report-'));
  try {
    const results: CheckResult[] = [
      result({ name: 'bypassed-check', status: 'bypassed', exitCode: 1, reason: 'flaky in CI' }),
      result({ name: 'errored-check', status: 'error', exitCode: null, reason: 'ENOENT' }),
    ];
    const filePath = writeReport(
      { repo: 'r', scope: 'fast', generatedAt: 'now', results },
      tmp,
      'reports/quality',
    );
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(parsed.results[0].reason, 'flaky in CI');
    assert.equal(parsed.results[1].reason, 'ENOENT');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
