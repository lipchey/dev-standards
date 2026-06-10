import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { expandArgv, runCheck } from '../../runner/src/exec.ts';
import type { RunCheckInput } from '../../runner/src/exec.ts';
import type { Check } from '../../runner/src/types.ts';

function stub(name: string): string {
  return fileURLToPath(new URL(`../stubs/${name}`, import.meta.url));
}

function check(argv: string[], overrides: Partial<Check> = {}): Check {
  return { name: 'c', argv, timeout_seconds: 30, ...overrides };
}

function input(c: Check, filesByName = new Map<string, string[]>()): RunCheckInput {
  return { check: c, tier: 'fast', cwd: process.cwd(), filesByName };
}

test('exit 0 becomes status pass', () => {
  const result = runCheck(input(check([process.execPath, stub('ok.mjs')])));
  assert.equal(result.status, 'pass');
  assert.equal(result.exitCode, 0);
});

test('exit 1 becomes status fail', () => {
  const result = runCheck(input(check([process.execPath, stub('fail.mjs')])));
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
});

test('timeout becomes status timeout and exitCode null', () => {
  const result = runCheck(
    input(check([process.execPath, stub('sleep.mjs'), '5'], { timeout_seconds: 1 })),
  );
  assert.equal(result.status, 'timeout');
  assert.equal(result.exitCode, null);
});

test('expandArgv replaces a {files:x} token with the fileset spread', () => {
  const out = expandArgv(['tool', '{files:x}'], new Map([['x', ['a.ts', 'b.ts']]]));
  assert.deepEqual(out, ['tool', 'a.ts', 'b.ts']);
});

test('expandArgv rejects an option-like expanded file operand (argv option injection)', () => {
  // Token-expanded repo filenames can be parsed as tool options.
  assert.throws(
    () => expandArgv(['eslint', '{files:ts}'], new Map([['ts', ['--config=evil.ts', 'src/good.ts']]])),
    /option-like|injection/i,
  );
  assert.throws(
    () => expandArgv(['tool', '{files:ts}'], new Map([['ts', ['-rf.ts']]])),
    /option-like|injection/i,
  );
});

test('expandArgv rejects an @-prefixed expanded file operand (response-file injection)', () => {
  // Tools like tsc treat @ operands as response files.
  assert.throws(
    () => expandArgv(['tsc', '{files:ts}'], new Map([['ts', ['@evil', 'src/good.ts']]])),
    /option-like|injection/i,
  );
});

test('runCheck fails closed on an @-prefixed expanded operand (response-file injection)', () => {
  assert.throws(
    () =>
      runCheck(
        input(check([process.execPath, '{files:ts}']), new Map([['ts', ['@evil']]])),
      ),
    /option-like|injection/i,
  );
});

test('expandArgv passes through a literal option the manifest author wrote', () => {
  // Only fileset-expanded operands are guarded; manifest-authored flags are trusted.
  const out = expandArgv(
    ['tool', '--max-warnings=0', '{files:ts}'],
    new Map([['ts', ['src/my-file.ts', 'src/a.ts']]]),
  );
  assert.deepEqual(out, ['tool', '--max-warnings=0', 'src/my-file.ts', 'src/a.ts']);
});

test('argv collapsing to zero elements becomes status skipped, no throw', () => {
  const result = runCheck(input(check(['{files:empty}']), new Map([['empty', []]])));
  assert.equal(result.status, 'skipped');
  assert.equal(result.exitCode, null);
});

test('skip_if_empty skips the check when its fileset expands empty', () => {
  const result = runCheck(
    input(
      check([process.execPath, stub('ok.mjs')], { skip_if_empty: 'staged' }),
      new Map([['staged', []]]),
    ),
  );
  assert.equal(result.status, 'skipped');
});

test('skip_if_empty skips the check when its fileset is absent', () => {
  const result = runCheck(
    input(check([process.execPath, stub('ok.mjs')], { skip_if_empty: 'missing' })),
  );
  assert.equal(result.status, 'skipped');
});

test('a missing binary (ENOENT) becomes status fail (exitCode 1), not timeout', () => {
  const result = runCheck(input(check(['this-binary-does-not-exist-xyz'])));
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.status, 'timeout');
});
