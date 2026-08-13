import './helpers/telemetry-off.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTier } from '../../runner/src/verify-runner.ts';
import type { Check, Manifest } from '../../runner/src/types.ts';

const stub = fileURLToPath(new URL('../stubs/group-attributor.mjs', import.meta.url));

function entry(status: string, exitCode: number | null, durationMs = 10) {
  return { status, exitCode, durationMs };
}

function artifact(results: Record<string, unknown>) {
  return JSON.stringify({ v: 1, nonce: '$NONCE', timingSource: 'stub-v1', results });
}

function groupedChecks(): Check[] {
  return ['b', 'a', 'c'].map((name) => ({
    name,
    argv: ['unused'],
    timeout_seconds: 1,
    group: 'quality',
  }));
}

function manifest(groupArgv: string[], fast = groupedChecks()): Manifest {
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
    tiers: { staged: [], fast, full: [], audit: [] },
    groups: [{
      name: 'quality',
      argv: groupArgv,
      artifact_dir: 'out/group-results',
      members: [
        { check: 'c', result_key: 'c' },
        { check: 'a', result_key: 'a' },
        { check: 'b', result_key: 'b' },
      ],
    }],
  };
}

function report(root: string) {
  return JSON.parse(fs.readFileSync(path.join(root, 'reports/quality/verify-fast.json'), 'utf8'));
}

test('the first grouped check runs once and emits members in tier order', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-tier-'));
  const marker = path.join(root, 'count');
  const payload = artifact({
    a: entry('pass', 0), b: entry('fail', 2), c: entry('pass', 0),
  });
  const before: Check = { name: 'before', argv: [process.execPath, '-e', ''], timeout_seconds: 1 };
  const after: Check = { name: 'after', argv: [process.execPath, '-e', ''], timeout_seconds: 1 };
  const output: string[] = [];
  const write = t.mock.method(process.stdout, 'write', ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    const grouped = groupedChecks();
    const m = manifest([process.execPath, stub, 'json', payload, marker], [before, ...grouped, after]);
    assert.equal(runTier(m, root, 'fast'), 1);
    assert.equal(fs.readFileSync(marker, 'utf8'), '1');
    assert.deepEqual(report(root).results.map((result: { name: string }) => result.name), [
      'before', 'b', 'a', 'c', 'after',
    ]);
    const inline = output.join('').split('blocking failures:')[0]!;
    for (const name of ['b', 'a', 'c']) {
      assert.equal(
        inline.split('\n').filter((line) => /^ {2}(?:pass|fail|error|timeout)\s+/.test(line) && line.includes(` ${name} [blocking]`)).length,
        1,
      );
    }
  } finally {
    write.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const state of ['complete', 'partial'] as const) {
  test(`a tier-budget-bound ${state} artifact writes N rows and aborted telemetry`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-tier-budget-'));
    const sink = path.join(root, 'events.jsonl');
    const saved = process.env.DS_TELEMETRY_PATH;
    try {
      process.env.DS_TELEMETRY_PATH = sink;
      const results = state === 'complete'
        ? { a: entry('pass', 0), b: entry('pass', 0), c: entry('pass', 0) }
        : { a: entry('pass', 0) };
      const m = manifest([process.execPath, stub, 'json-sleep', artifact(results), '5000']);
      m.budgets.fast_seconds = 1;
      let calls = 0;
      const clock = (): number => [0, 100, 1001][Math.min(calls++, 2)]!;

      const started = Date.now();
      assert.throws(() => runTier(m, root, 'fast', clock), /budget exceeded|deadline/i);
      assert.ok(Date.now() - started < 2000);
      const rows = report(root).results;
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((row: { status: string }) => row.status),
        state === 'complete' ? ['pass', 'pass', 'pass'] : ['error', 'pass', 'error']);
      const events = fs.readFileSync(sink, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(events.length, 1);
      assert.equal(events[0].aborted, true);
      assert.equal(events[0].exit, null);
      assert.equal(events[0].results.length, 3);
    } finally {
      if (saved === undefined) delete process.env.DS_TELEMETRY_PATH;
      else process.env.DS_TELEMETRY_PATH = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('an exhausted budget at a group position writes one deadline row per member', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-tier-deadline-'));
  const marker = path.join(root, 'count');
  try {
    const m = manifest([
      process.execPath,
      stub,
      'json',
      artifact({ a: entry('pass', 0), b: entry('pass', 0), c: entry('pass', 0) }),
      marker,
    ]);
    m.budgets.fast_seconds = 1;
    let calls = 0;
    const clock = (): number => [0, 1000, 1001][Math.min(calls++, 2)]!;

    assert.throws(() => runTier(m, root, 'fast', clock), /tier budget|deadline/i);
    const rows = report(root).results;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row: { status: string }) => row.status), ['timeout', 'timeout', 'timeout']);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an undeclared group returns one execution error row per member', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-undeclared-'));
  try {
    const m = manifest([process.execPath, stub, 'absent']);
    m.groups = [];
    assert.equal(runTier(m, root, 'fast'), 1);
    const rows = report(root).results;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.status, 'error');
      assert.equal(row.exitCode, null);
      assert.equal(row.mode, 'blocking');
      assert.equal(row.reason, 'group execution failed: group "quality" is not declared');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the sum of member timeouts bounds the group when tier time remains', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-sum-timeout-'));
  try {
    const m = manifest([process.execPath, stub, 'sleep', '5000']);
    const started = Date.now();
    assert.equal(runTier(m, root, 'fast'), 1);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2500, `expected the group timeout after at least 2500ms, got ${elapsed}ms`);
    assert.deepEqual(
      report(root).results.map((row: { status: string }) => row.status),
      ['error', 'error', 'error'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
