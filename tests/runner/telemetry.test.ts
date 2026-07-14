import './helpers/telemetry-off.ts'; // MUST be first: default the sink off for direct (non-npm) runs
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendRunEvent,
  buildRunEvent,
  gitContext,
  resolveSinkPath,
  type RunEvent,
} from '../../runner/src/telemetry.ts';
import { runTier } from '../../runner/src/verify-runner.ts';
import type { CheckResult, Manifest } from '../../runner/src/types.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerPath = path.join(repoRoot, 'runner', 'dist', 'verify-runner.mjs');

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return { name: 'c', tier: 'fast', status: 'pass', exitCode: 0, durationMs: 1, mode: 'blocking', ...overrides };
}

function event(overrides: Partial<Omit<RunEvent, 'v'>> = {}): RunEvent {
  return buildRunEvent({
    startedAt: '2026-07-10T00:00:00.000Z',
    finishedAt: '2026-07-10T00:00:01.000Z',
    repo: 'r',
    scope: 'fast',
    branch: 'main',
    head_sha: 'deadbeef',
    exit: 0,
    aborted: false,
    results: [result()],
    ...overrides,
  });
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A non-git manifest with no filesets and a passing noop check: the normal path runs even in a
// non-git dir, so a spawned runner emits exactly one aborted:false event.
const NOOP_MANIFEST = {
  version: 1,
  repo: 'tmp-telemetry',
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
  filesets: [],
  tiers: {
    staged: [],
    fast: [{ name: 'noop', argv: ['node', '--version'], timeout_seconds: 5 }],
    full: [],
    audit: [],
  },
} as const;

function budgetManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    repo: 'tmp',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 300, fast_seconds: 300, full_seconds: 300, audit_seconds: 300 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: false,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [],
    tiers: { staged: [], fast: [], full: [], audit: [] },
    ...overrides,
  };
}

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

// The proof, per the acceptance: under `npm test` the suite defaults the sink off, so no test
// can ever write the operator's real events.jsonl. Removing the package-level default (or the
// CI env) turns this red.
test('the test suite defaults DS_TELEMETRY_PATH=off (npm test cannot write the real home sink)', () => {
  assert.equal(process.env.DS_TELEMETRY_PATH, 'off');
  assert.equal(resolveSinkPath(), null);
});

test('resolveSinkPath: off -> null, unset -> default home path, custom -> that path', () => {
  assert.equal(resolveSinkPath({ DS_TELEMETRY_PATH: 'off' }), null);
  assert.equal(
    resolveSinkPath({}),
    path.join(os.homedir(), '.local', 'share', 'dev-standards', 'events.jsonl'),
  );
  assert.equal(resolveSinkPath({ DS_TELEMETRY_PATH: '/tmp/x/events.jsonl' }), '/tmp/x/events.jsonl');
});

test('fresh machine: a sink whose parent dirs do not exist -> two runs -> exactly 2 lines', () => {
  const dir = tmpdir('ds-tel-fresh-');
  try {
    const sink = path.join(dir, 'a', 'b', 'c', 'events.jsonl'); // parents absent
    assert.equal(fs.existsSync(path.dirname(sink)), false);
    appendRunEvent(event({ exit: 0 }), { DS_TELEMETRY_PATH: sink });
    appendRunEvent(event({ exit: 1 }), { DS_TELEMETRY_PATH: sink });
    const lines = fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).exit, 0);
    assert.equal(JSON.parse(lines[1]!).exit, 1);
    // Provisioned private, per §1.
    assert.equal(fs.statSync(sink).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Fail-open: the internal try/catch around the fs write is THE fence. Removing it makes
// appendRunEvent throw (no warning captured) -> this test goes red.
test('fail-open: an unwritable sink never throws and emits one stderr warning', () => {
  const dir = tmpdir('ds-tel-failopen-');
  try {
    const notADir = path.join(dir, 'file');
    fs.writeFileSync(notADir, 'x');
    const sink = path.join(notADir, 'nested', 'events.jsonl'); // parent is a file -> ENOTDIR

    const original = process.stderr.write.bind(process.stderr);
    let captured = '';
    (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array): boolean => {
      captured += chunk.toString();
      return true;
    });
    try {
      appendRunEvent(event(), { DS_TELEMETRY_PATH: sink }); // must not throw
    } finally {
      process.stderr.write = original;
    }
    assert.match(captured, /warning: telemetry write to .*failed:/);
    assert.equal(fs.existsSync(sink), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRunEvent truncates a reason to 200 chars; short reasons and inputs are untouched', () => {
  const long = 'x'.repeat(300);
  const results: CheckResult[] = [
    result({ name: 'a', status: 'bypassed', exitCode: 1, reason: long }),
    result({ name: 'b', status: 'error', exitCode: null, reason: 'short' }),
  ];
  const e = buildRunEvent({
    startedAt: 's', finishedAt: 'f', repo: 'r', scope: 'fast',
    branch: null, head_sha: null, exit: 1, aborted: false, results,
  });
  assert.equal(e.results[0]!.reason!.length, 200);
  assert.equal(e.results[1]!.reason, 'short');
  // The caller's array is never mutated (report.ts still persists the full reason).
  assert.equal(results[0]!.reason!.length, 300);
});

test('gitContext: non-git dir -> both null; real repo -> branch + sha; detached HEAD -> branch null', () => {
  const nonGit = tmpdir('ds-tel-nongit-');
  const repo = tmpdir('ds-tel-git-');
  try {
    assert.deepEqual(gitContext(nonGit), { branch: null, head_sha: null });

    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    };
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'one');
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const onBranch = gitContext(repo);
    assert.match(onBranch.branch ?? '', /^\S+$/);
    assert.equal(onBranch.head_sha, head);

    git('checkout', '-q', head); // detached
    const detached = gitContext(repo);
    assert.equal(detached.branch, null, 'detached HEAD reports no branch');
    assert.equal(detached.head_sha, head);
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Abort path (in-process): a budget-exhausted tier re-throws, but first emits one aborted:true
// event with a null exit and the partial results — independent of report writing.
test('abort path: a budget-exhausted tier emits aborted:true, exit null', () => {
  const root = tmpdir('ds-tel-abort-');
  const saved = process.env.DS_TELEMETRY_PATH;
  const sink = path.join(root, 'events.jsonl');
  try {
    process.env.DS_TELEMETRY_PATH = sink;
    const m = budgetManifest({
      budgets: { staged_seconds: 300, fast_seconds: 0.05, full_seconds: 300, audit_seconds: 300 },
      tiers: {
        staged: [],
        fast: [{ name: 'slow', argv: [process.execPath, '-e', 'setTimeout(()=>{},5000)'], timeout_seconds: 30 }],
        full: [],
        audit: [],
      },
    });
    assert.throws(() => runTier(m, root, 'fast'), /budget exceeded|deadline/i);
    const lines = fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]!);
    assert.equal(e.aborted, true);
    assert.equal(e.exit, null);
    assert.equal(e.v, 1);
  } finally {
    if (saved === undefined) delete process.env.DS_TELEMETRY_PATH;
    else process.env.DS_TELEMETRY_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// End-to-end env contract on the bundled runner: a tmp path writes exactly one line; `off`
// on a re-run writes nothing (the line count stays at 1).
test('env contract (spawned runner): a tmp path writes one line; off writes nothing', () => {
  const dir = tmpdir('ds-tel-env-');
  try {
    const manifestPath = path.join(dir, 'quality.json');
    fs.writeFileSync(manifestPath, JSON.stringify(NOOP_MANIFEST), 'utf8');
    const sink = path.join(dir, 'sink', 'events.jsonl');

    const withPath = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
      env: { ...process.env, DS_TELEMETRY_PATH: sink },
    });
    assert.equal(withPath.status, 0, `runner must exit 0, stderr:\n${withPath.stderr}`);
    let lines = fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'one run -> one line');
    const e = JSON.parse(lines[0]!);
    assert.equal(e.aborted, false);
    assert.equal(e.exit, 0);
    assert.equal(e.branch, null, 'non-git cwd -> branch null');
    assert.equal(e.head_sha, null, 'non-git cwd -> head_sha null');
    assert.equal(e.scope, 'fast');
    assert.equal(e.results.length, 1);

    const withOff = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
      env: { ...process.env, DS_TELEMETRY_PATH: 'off' },
    });
    assert.equal(withOff.status, 0, `runner must exit 0 with off, stderr:\n${withOff.stderr}`);
    lines = fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'off must not append a second line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* The two sinks are independent by contract: a normal-path REPORT write failure still fails
   the run loudly, but must not lose the telemetry event (emit happens before the report). */
test('a normal-path report-write failure does not lose the telemetry event', () => {
  const dir = tmpdir('ds-tel-report-fail-');
  try {
    const manifestPath = path.join(dir, 'quality.json');
    fs.writeFileSync(manifestPath, JSON.stringify(NOOP_MANIFEST), 'utf8');
    /* `reports` as a plain file makes writeReport's mkdir of reports/quality throw. */
    fs.writeFileSync(path.join(dir, 'reports'), 'not a directory', 'utf8');
    const sink = path.join(dir, 'sink', 'events.jsonl');

    const run = spawnSync(process.execPath, [runnerPath, '--manifest', manifestPath, '--fast'], {
      encoding: 'utf8',
      env: { ...process.env, DS_TELEMETRY_PATH: sink },
    });
    assert.notEqual(run.status, 0, 'a report-write failure must still fail the run');
    const lines = fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'the event must be written despite the report failure');
    const e = JSON.parse(lines[0]!);
    assert.equal(e.aborted, false);
    assert.equal(e.exit, 0, 'the checks themselves passed; only the report write failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
