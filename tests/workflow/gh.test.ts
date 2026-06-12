import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhAdapter, GhError, machineReadableGhError } from '../../workflow/src/gh.ts';

interface SpawnCall {
  file: string;
  args: string[];
  options: { shell: false; encoding: 'utf8'; timeout: number };
}

function spawnFixture(responses: Array<{ status: number; stdout?: string; stderr?: string }>) {
  const calls: SpawnCall[] = [];
  const spawn = (file: string, args: string[], options: SpawnCall['options']) => {
    calls.push({ file, args, options });
    const response = responses.shift() ?? { status: 0, stdout: '{}', stderr: '' };
    return {
      status: response.status,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
    };
  };
  return { calls, spawn };
}

test('fixed-argv-no-shell', () => {
  const fx = spawnFixture([{ status: 0, stdout: '[{"number":42,"url":"https://example.test/pr/42"}]' }]);
  const gh = createGhAdapter({ spawn: fx.spawn, timeoutMs: 1234 });

  const pr = gh.findPrByHead('feature/s14-ship');

  assert.equal(pr?.number, 42);
  assert.equal(fx.calls.length, 1, 'one gh call, no silent retries');
  assert.equal(fx.calls[0]?.file, 'gh');
  assert.deepEqual(fx.calls[0]?.args, [
    'pr',
    'list',
    '--head',
    'feature/s14-ship',
    '--json',
    'number,url,state,mergedAt,headRefName,headRefOid',
    '--limit',
    '1',
  ]);
  assert.deepEqual(fx.calls[0]?.options, { shell: false, encoding: 'utf8', timeout: 1234 });
});

test('json-parse-of-stub-output', () => {
  const fx = spawnFixture([{ status: 0, stdout: '[{"number":7,"url":"https://example.test/pr/7","state":"OPEN"}]' }]);
  const gh = createGhAdapter({ spawn: fx.spawn });

  assert.deepEqual(gh.findPrByHead('feature/json'), {
    number: 7,
    url: 'https://example.test/pr/7',
    state: 'OPEN',
  });
});

test('pr-view-json-includes-state-mergedat-headref', () => {
  const fx = spawnFixture([
    {
      status: 0,
      stdout: '{"number":42,"state":"MERGED","mergedAt":"2026-06-12T10:00:00Z","headRefName":"feature/s14-ship"}',
    },
  ]);
  const gh = createGhAdapter({ spawn: fx.spawn });

  const pr = gh.viewPr(42);

  assert.equal(pr.state, 'MERGED');
  assert.equal(pr.mergedAt, '2026-06-12T10:00:00Z');
  assert.equal(pr.headRefName, 'feature/s14-ship');
  assert.deepEqual(fx.calls[0]?.args, [
    'pr',
    'view',
    '42',
    '--json',
    'number,url,state,mergedAt,headRefName,headRefOid,isDraft,mergeable',
  ]);
});

test('nonzero-gh-exit-machine-readable-error', () => {
  const fx = spawnFixture([{ status: 1, stderr: 'network down\ntry again later\n' }]);
  const gh = createGhAdapter({ spawn: fx.spawn });

  assert.throws(
    () => gh.viewPr(42, 'pr-view'),
    (error) => {
      assert.ok(error instanceof GhError);
      assert.equal(error.command, 'gh pr view 42 --json number,url,state,mergedAt,headRefName,headRefOid,isDraft,mergeable');
      assert.equal(error.step, 'pr-view');
      assert.equal(error.stderr_tail, 'network down\ntry again later');
      assert.deepEqual(machineReadableGhError(error), {
        error: {
          command: error.command,
          step: 'pr-view',
          message: error.message,
          stderr_tail: 'network down\ntry again later',
        },
      });
      return true;
    },
  );
  assert.equal(fx.calls.length, 1, 'a gh failure is surfaced once, never retried silently');
});

test('no-silent-retries', () => {
  const fx = spawnFixture([{ status: 1, stderr: 'failure' }, { status: 0, stdout: '{}' }]);
  const gh = createGhAdapter({ spawn: fx.spawn });

  assert.throws(() => gh.viewPr(99), GhError);

  assert.equal(fx.calls.length, 1);
});

test('argv-option-injection-screened', () => {
  const fx = spawnFixture([]);
  const gh = createGhAdapter({ spawn: fx.spawn });

  assert.throws(() => gh.findPrByHead('-bad'), /unsafe branch/i);
  assert.throws(() => gh.findPrByHead('feature/bad:main'), /unsafe branch/i);
  assert.throws(() => gh.createPr({ base: 'main', head: '-bad', title: 't', bodyFile: '/tmp/body.md' }), /unsafe branch/i);
  assert.throws(() => gh.deleteLocalBranchArgs('main'), /refuses.*base/i);
  assert.deepEqual(gh.deleteLocalBranchArgs('feature/safe'), ['branch', '-D', '--', 'feature/safe']);
  assert.equal(fx.calls.length, 0, 'rejected branch operands never reach spawn');
});
