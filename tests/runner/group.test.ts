import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCheckGroup } from '../../runner/src/group.ts';
import type { Check, CheckGroup, CheckResult } from '../../runner/src/types.ts';

const stub = fileURLToPath(new URL('../stubs/group-attributor.mjs', import.meta.url));

function checks(): Check[] {
  return ['a', 'b', 'c'].map((name) => ({
    name,
    argv: ['unused'],
    timeout_seconds: 1,
    group: 'quality',
  }));
}

function group(argv: string[], overrides: Partial<CheckGroup> = {}): CheckGroup {
  return {
    name: 'quality',
    argv,
    artifact_dir: 'out/group-results',
    members: [
      { check: 'a', result_key: 'a' },
      { check: 'b', result_key: 'b' },
      { check: 'c', result_key: 'c' },
    ],
    ...overrides,
  };
}

function entry(status: string, exitCode: number | null, durationMs = 10) {
  return { status, exitCode, durationMs };
}

function artifact(results: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { v: 1, nonce: '$NONCE', timingSource: 'stub-v1', results, ...overrides };
}

function argvFor(scenario: string, value?: unknown, marker?: string): string[] {
  const argv = [process.execPath, stub, scenario];
  if (value !== undefined) argv.push(typeof value === 'string' ? value : JSON.stringify(value));
  if (marker !== undefined) argv.push(marker);
  return argv;
}

function run(root: string, argv: string[], overrides: Partial<CheckGroup> = {}, timeoutMs = 3000) {
  return runCheckGroup({ group: group(argv, overrides), checks: checks(), tier: 'fast', cwd: root, timeoutMs });
}

function assertAllErrors(results: CheckResult[], reason: RegExp): void {
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, null);
    assert.equal(result.mode, 'blocking');
    assert.match(result.reason ?? '', reason);
  }
}

function completeResults() {
  return { a: entry('pass', 0, 10), b: entry('pass', 0, 20), c: entry('pass', 0, 30) };
}

test('one group process attributes three ordered result rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-'));
  const observation = path.join(root, 'observation.json');
  const artifactDir = path.join(root, 'out/group-results');
  const unrelated = path.join(artifactDir, 'quality.other.json');
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(unrelated, 'keep');
    const results = run(root, argvFor('json-observe', artifact(completeResults()), observation));
    const observed = JSON.parse(fs.readFileSync(observation, 'utf8'));
    assert.equal(observed.count, 1);
    assert.match(observed.nonce, /^[a-f0-9]{32}$/);
    assert.equal(observed.artifactPath, path.join(artifactDir, `quality.${observed.nonce}.json`));
    assert.equal(fs.existsSync(observed.artifactPath), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    assert.deepEqual(results.map(({ name, status, timingSource }) => ({ name, status, timingSource })), [
      { name: 'a', status: 'pass', timingSource: 'stub-v1' },
      { name: 'b', status: 'pass', timingSource: 'stub-v1' },
      { name: 'c', status: 'pass', timingSource: 'stub-v1' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one reported failure affects only its member', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-'));
  try {
    const payload = completeResults();
    payload.b = entry('fail', 7, 21);
    const results = run(root, argvFor('json', artifact(payload)));
    assert.deepEqual(results.map(({ status, exitCode }) => ({ status, exitCode })), [
      { status: 'pass', exitCode: 0 },
      { status: 'fail', exitCode: 7 },
      { status: 'pass', exitCode: 0 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed group with no artifact makes every member blocking error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-'));
  try {
    assertAllErrors(run(root, argvFor('sleep', '5000'), {}, 50), /^group artifact missing$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a partial artifact keeps attributed statuses and blocks missing members', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-'));
  try {
    const results = run(root, argvFor('json', artifact({ a: entry('pass', 0) })));
    assert.equal(results[0]?.status, 'pass');
    for (const result of results.slice(1)) {
      assert.equal(result.status, 'error');
      assert.equal(result.reason, 'group member unattributed');
      assert.equal('timingSource' in result, false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const corruptCases: Array<[string, string, unknown, RegExp]> = [
  ['absent', 'absent', undefined, /^group artifact missing$/],
  ['unparsable', 'raw', '{', /^group artifact corrupt:/],
  ['non-object document', 'raw', '[]', /^group artifact corrupt:/],
  ['bad nonce', 'json', artifact(completeResults(), { nonce: 'wrong' }), /^group artifact corrupt:/],
  ['bad version', 'json', artifact(completeResults(), { v: 2 }), /^group artifact corrupt:/],
  ['bad results object', 'json', artifact(completeResults(), { results: [] }), /^group artifact corrupt:/],
  ['non-object member', 'json', artifact({ ...completeResults(), a: null }), /^group artifact corrupt:/],
  ['missing member key', 'json', artifact({ ...completeResults(), a: { status: 'pass', exitCode: 0 } }), /^group artifact corrupt:/],
  ['extra member key', 'json', artifact({ ...completeResults(), a: { ...entry('pass', 0), extra: true } }), /^group artifact corrupt:/],
  ['unknown status', 'json', artifact({ ...completeResults(), a: entry('unknown', 0) }), /^group artifact corrupt:/],
  ['extra key', 'json', artifact({ ...completeResults(), extra: entry('pass', 0) }), /^group artifact corrupt:/],
  ['fractional duration', 'json', artifact({ ...completeResults(), a: entry('pass', 0, 1.5) }), /^group artifact corrupt:/],
  ['negative duration', 'json', artifact({ ...completeResults(), a: entry('pass', 0, -1) }), /^group artifact corrupt:/],
  ['non-number duration', 'json', artifact({ ...completeResults(), a: { ...entry('pass', 0), durationMs: null } }), /^group artifact corrupt:/],
  ['non-integer exit code', 'json', artifact({ ...completeResults(), a: entry('fail', 1.5) }), /^group artifact corrupt:/],
  ['unsafe exit code', 'json', artifact({ ...completeResults(), a: entry('fail', 9007199254740992) }), /^group artifact corrupt:/],
  ['missing timing source', 'json', artifact(completeResults(), { timingSource: undefined }), /^group artifact corrupt:/],
  ['non-string timing source', 'json', artifact(completeResults(), { timingSource: 1 }), /^group artifact corrupt:/],
  ['newline timing source', 'json', artifact(completeResults(), { timingSource: 'bad\nsource' }), /^group artifact corrupt:/],
  ['long timing source', 'json', artifact(completeResults(), { timingSource: 'a'.repeat(65) }), /^group artifact corrupt:/],
  ['symlink artifact', 'symlink', artifact(completeResults()), /^group artifact corrupt:/],
];

for (const [name, scenario, value, reason] of corruptCases) {
  test(`corrupt artifact: ${name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-corrupt-'));
    try {
      assertAllErrors(run(root, argvFor(scenario, value)), reason);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('corrupt artifact: a FIFO returns one blocking error per member without hanging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-fifo-'));
  const groupModule = new URL('../../runner/src/group.ts', import.meta.url).href;
  const source = `
    import { runCheckGroup } from ${JSON.stringify(groupModule)};
    const checks = ['a', 'b', 'c'].map((name) => ({
      name,
      argv: ['unused'],
      timeout_seconds: 1,
      group: 'quality',
    }));
    const results = runCheckGroup({
      group: {
        name: 'quality',
        argv: [process.execPath, ${JSON.stringify(stub)}, 'fifo'],
        artifact_dir: 'out/group-results',
        members: checks.map(({ name }) => ({ check: name, result_key: name })),
      },
      checks,
      tier: 'fast',
      cwd: ${JSON.stringify(root)},
      timeoutMs: 3000,
    });
    process.stdout.write(JSON.stringify(results));
  `;
  try {
    const probe = spawnSync(
      process.execPath,
      ['--import=tsx', '--input-type=module', '--eval', source],
      { encoding: 'utf8', killSignal: 'SIGKILL', timeout: 1000 },
    );
    assert.notEqual(
      (probe.error as NodeJS.ErrnoException | undefined)?.code,
      'ETIMEDOUT',
      'the FIFO probe must return before its one-second process deadline',
    );
    assert.equal(probe.status, 0, probe.stderr);
    assertAllErrors(
      JSON.parse(probe.stdout) as CheckResult[],
      /^group artifact corrupt: read failed$/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt artifact: a directory reports its read failure and is removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-directory-'));
  const artifactDir = path.join(root, 'out/group-results');
  try {
    assertAllErrors(run(root, argvFor('directory')), /^group artifact corrupt: read failed$/);
    assert.deepEqual(fs.readdirSync(artifactDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const unresolvedCases: Array<[string, ReturnType<typeof entry>, string]> = [
  ['skipped', entry('skipped', null), 'group member reported skipped'],
  ['bypassed', entry('bypassed', 2), 'group member reported bypassed'],
  ['pass with null exit', entry('pass', null), 'group member exit code contradicts status'],
  ['pass with non-zero exit', entry('pass', 2), 'group member exit code contradicts status'],
  ['fail with zero exit', entry('fail', 0), 'group member exit code contradicts status'],
  ['fail with null exit', entry('fail', null), 'group member exit code contradicts status'],
];

for (const [name, reported, reason] of unresolvedCases) {
  test(`one unresolved member: ${name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-unresolved-'));
    try {
      const results = run(
        root,
        argvFor('json', artifact({ ...completeResults(), b: reported })),
      );
      assert.equal(results[0]?.status, 'pass');
      assert.deepEqual(results[1], {
        name: 'b',
        tier: 'fast',
        status: 'error',
        exitCode: null,
        durationMs: 0,
        mode: 'blocking',
        reason,
      });
      assert.equal(results[2]?.status, 'pass');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const status of ['error', 'timeout'] as const) {
  test(`${status} normalizes an integer exit code to null`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-normalize-'));
    try {
      const results = run(
        root,
        argvFor('json', artifact({ ...completeResults(), b: entry(status, 3) })),
      );
      assert.equal(results[1]?.status, status);
      assert.equal(results[1]?.exitCode, null);
      assert.equal(results[1]?.timingSource, 'stub-v1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a member duration above its timeout is reclassified to timeout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-member-timeout-'));
  try {
    const results = run(
      root,
      argvFor('json', artifact({ ...completeResults(), a: entry('fail', 4, 1001) })),
    );
    assert.deepEqual(results[0], {
      name: 'a', tier: 'fast', status: 'timeout', exitCode: null, durationMs: 1001,
      mode: 'blocking', timingSource: 'stub-v1',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a member duration equal to its timeout keeps its reported status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-member-boundary-'));
  try {
    const results = run(
      root,
      argvFor('json', artifact({ ...completeResults(), a: entry('pass', 0, 1000) })),
    );
    assert.equal(results[0]?.status, 'pass');
    assert.equal(results[0]?.exitCode, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a non-zero group exit cannot override a complete artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-exit-'));
  try {
    const results = run(root, [...argvFor('json-exit', artifact(completeResults())), '9']);
    assert.deepEqual(results.map((result) => result.status), ['pass', 'pass', 'pass']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const lifecycleCases: Array<[string, (root: string) => CheckResult[], RegExp]> = [
  [
    'confined path resolution',
    (root) => run(root, argvFor('absent'), { artifact_dir: '../outside' }),
    /^group execution failed: confined path resolution failed$/,
  ],
  [
    'spawn',
    (root) => run(root, [path.join(root, 'missing-group-command')]),
    /^group execution failed: spawn failed$/,
  ],
  ['read', (root) => run(root, argvFor('absent')), /^group artifact missing$/],
  ['parse', (root) => run(root, argvFor('raw', '{')), /^group artifact corrupt: invalid JSON$/],
  [
    'validation',
    (root) => run(root, argvFor('json', artifact(completeResults(), { v: 2 }))),
    /^group artifact corrupt: unsupported version$/,
  ],
];

for (const [name, invoke, reason] of lifecycleCases) {
  test(`lifecycle failure: ${name} returns one blocking row per member`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-lifecycle-'));
    try {
      let results: CheckResult[] = [];
      assert.doesNotThrow(() => { results = invoke(root); }, name);
      assertAllErrors(results, reason);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a pre-delete failure returns one blocking row per member', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-pre-delete-'));
  const original = fs.rmSync;
  let calls = 0;
  const mocked = t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
    calls += 1;
    if (calls === 1) throw new Error('pre-delete forced');
    return original(...args);
  });
  try {
    assertAllErrors(
      run(root, argvFor('json', artifact(completeResults()))),
      /^group execution failed: pre-delete failed$/,
    );
  } finally {
    mocked.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cleanup failure cannot override complete attribution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-group-cleanup-'));
  const original = fs.rmSync;
  let calls = 0;
  const mocked = t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
    calls += 1;
    if (calls === 2) throw new Error('cleanup forced');
    return original(...args);
  });
  try {
    const results = run(root, argvFor('json', artifact(completeResults())));
    assert.deepEqual(results.map((result) => result.status), ['pass', 'pass', 'pass']);
  } finally {
    mocked.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
