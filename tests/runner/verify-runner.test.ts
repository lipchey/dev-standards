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
import type { CheckResult, Manifest } from '../../runner/src/types.ts';

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

test('prints each check configured timeout before spawning it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runner-timeout-'));
  try {
    const manifestPath = path.join(tmp, 'quality.json');
    const manifest = structuredClone(MANIFEST) as unknown as Manifest;
    manifest.filesets = [];
    manifest.tiers.fast = [
      {
        name: 'visible-noop',
        argv: [process.execPath, '-e', 'process.stdout.write("child started\\n")'],
        timeout_seconds: 7,
        mode: 'report-only',
      },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const run = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
      env: { ...process.env, DS_TELEMETRY_PATH: 'off' },
    });

    assert.equal(run.status, 0, `runner failed:\n${run.stderr}`);
    const configuredLine = '  check visible-noop [report-only] configured timeout 7s';
    assert.equal(
      run.stdout.split('\n').filter((line) => line === configuredLine).length,
      1,
      `expected exactly one timeout line, got:\n${run.stdout}`,
    );
    assert.ok(
      run.stdout.indexOf(configuredLine) < run.stdout.indexOf('child started'),
      `timeout line must be visible before the check spawns, got:\n${run.stdout}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('configured timeout line stays truthful when an empty fileset skips the check before spawn', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runner-skipped-timeout-'));
  try {
    const init = spawnSync('git', ['init', tmp], { encoding: 'utf8' });
    assert.equal(init.status, 0, `git init failed:\n${init.stderr}`);

    const manifestPath = path.join(tmp, 'quality.json');
    const manifest = structuredClone(MANIFEST) as unknown as Manifest;
    manifest.tiers.fast = [
      {
        name: 'skipped-noop',
        argv: [process.execPath, '-e', 'process.stdout.write("child started\\n")'],
        timeout_seconds: 7,
        skip_if_empty: 'repo_ts',
      },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const run = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
      env: { ...process.env, DS_TELEMETRY_PATH: 'off' },
    });

    assert.equal(run.status, 0, `runner failed:\n${run.stderr}`);
    assert.match(run.stdout, /^ {2}check skipped-noop \[blocking\] configured timeout 7s$/m);
    assert.match(run.stdout, /^ {2}skipped skipped-noop \[blocking\] 0ms exit -$/m);
    assert.doesNotMatch(run.stdout, /running skipped-noop|child started/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function lastLine(stream: string): string {
  return stream.trimEnd().split('\n').at(-1) ?? '';
}

/* A red run used to end byte-identically to a green one: the only failure marker was the inline
   summarize() line, which every later passing check pushes out of a `tail`. The checks below are
   ordered so the failure is NOT last inline — the terminal record has to bring it back. */
test('a blocking failure ends the run with a failed record that re-prints only the blockers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runner-record-fail-'));
  try {
    const init = spawnSync('git', ['init', tmp], { encoding: 'utf8' });
    assert.equal(init.status, 0, `git init failed:\n${init.stderr}`);

    const manifestPath = path.join(tmp, 'quality.json');
    const manifest = structuredClone(MANIFEST) as unknown as Manifest;
    manifest.tiers.fast = [
      { name: 'failing-check', argv: [process.execPath, '-e', 'process.exit(3)'], timeout_seconds: 30 },
      { name: 'later-pass', argv: [process.execPath, '--version'], timeout_seconds: 30 },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const run = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
      env: { ...process.env, DS_TELEMETRY_PATH: 'off' },
    });

    assert.equal(run.status, 1, `a blocking failure must exit 1, got ${run.status}:\n${run.stderr}`);
    assert.equal(lastLine(run.stdout), 'VERIFY RESULT: scope=fast outcome=failed blockers=1 checks=2');
    // The record cites the same summarize() line the inline pass emitted — for the blocker only.
    const reprint = run.stdout.slice(run.stdout.indexOf('blocking failures:\n'));
    assert.match(reprint, /^ {2}fail\s+failing-check \[blocking\] \d+ms exit 3$/m);
    assert.doesNotMatch(reprint, /later-pass/);
    assert.ok(
      run.stdout.indexOf('report: ') < run.stdout.indexOf('blocking failures:'),
      `the record must follow the report line, got:\n${run.stdout}`,
    );
    assert.doesNotMatch(run.stderr, /VERIFY RESULT/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a green run ends with a passed record on stdout, after the report line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runner-record-ok-'));
  try {
    const init = spawnSync('git', ['init', tmp], { encoding: 'utf8' });
    assert.equal(init.status, 0, `git init failed:\n${init.stderr}`);

    const manifestPath = path.join(tmp, 'quality.json');
    const manifest = structuredClone(MANIFEST) as unknown as Manifest;
    manifest.tiers.fast = [
      { name: 'passing-check', argv: [process.execPath, '--version'], timeout_seconds: 30 },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const run = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
      env: { ...process.env, DS_TELEMETRY_PATH: 'off' },
    });

    assert.equal(run.status, 0, `runner failed:\n${run.stderr}`);
    assert.equal(lastLine(run.stdout), 'VERIFY RESULT: scope=fast outcome=passed checks=1');
    assert.doesNotMatch(run.stdout, /blocking failures:/);
    assert.ok(
      run.stdout.indexOf('report: ') < run.stdout.indexOf('VERIFY RESULT'),
      `the record must follow the report line, got:\n${run.stdout}`,
    );
    assert.doesNotMatch(run.stderr, /VERIFY RESULT/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* A tier that throws never reaches its exit decision, so it is neither passed nor failed. Without
   its own record the grammar would have a hole exactly where a reader most needs one: `aborted`
   and `failed` mean different things (a spent deadline hides the checks that never ran). */
test('an aborted tier ends with an aborted record on stderr, after the detail line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runner-record-abort-'));
  try {
    // No git init: the tier aborts while resolving filesets, the same path a spent deadline takes.
    const manifestPath = path.join(tmp, 'quality.json');
    fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST), 'utf8');

    const run = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
      env: { ...process.env, DS_TELEMETRY_PATH: 'off' },
    });

    assert.equal(run.status, 1, `an aborted tier must exit 1, got ${run.status}:\n${run.stderr}`);
    assert.equal(lastLine(run.stderr), 'VERIFY RESULT: scope=fast outcome=aborted');
    assert.ok(
      run.stderr.indexOf('error running fast tier:') < run.stderr.indexOf('VERIFY RESULT'),
      `the detail line must survive above the record, got:\n${run.stderr}`,
    );
    assert.doesNotMatch(run.stdout, /VERIFY RESULT/);
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
