import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, matches } from '../../tools/check-companion-tests.mjs';

const testGlobs = ['**/*.test.ts', '**/*.spec.ts'];

test('src-only fails: no staged test covers the staged source', () => {
  const result = evaluate(['src/a.ts'], { testGlobs });
  assert.equal(result.ok, false);
  assert.deepEqual(result.srcNeedingTests, ['src/a.ts']);
});

test('src + co-located test passes', () => {
  const result = evaluate(['src/a.ts', 'src/a.test.ts'], { testGlobs });
  assert.equal(result.ok, true);
});

test('test-only passes (nothing needs a companion)', () => {
  const result = evaluate(['src/a.test.ts'], { testGlobs });
  assert.equal(result.ok, true);
});

test('.d.ts-only passes: declaration files never require a test', () => {
  const result = evaluate(['src/x.d.ts'], { testGlobs });
  assert.equal(result.ok, true);
});

test('src + .d.ts, no test: only the source file counts as needing a test', () => {
  const result = evaluate(['src/a.ts', 'src/x.d.ts'], { testGlobs });
  assert.equal(result.ok, false);
  assert.deepEqual(result.srcNeedingTests, ['src/a.ts']);
});

test('deleted-test scenario: the runner\'s ACMR filter already dropped the deleted test, so a bare source file still fails', () => {
  const result = evaluate(['src/a.ts'], { testGlobs });
  assert.equal(result.ok, false);
});

test('empty file list passes: nothing staged to enforce', () => {
  const result = evaluate([], { testGlobs });
  assert.equal(result.ok, true);
  assert.deepEqual(result.srcNeedingTests, []);
  assert.deepEqual(result.testsStaged, []);
});

test('matcher: **/*.test.ts matches at any depth, including a root-level file (** consuming zero segments)', () => {
  assert.equal(matches('a.test.ts', '**/*.test.ts'), true); // zero-segment ** — the mutation guard
  assert.equal(matches('src/a.test.ts', '**/*.test.ts'), true);
  assert.equal(matches('src/x/y/a.test.ts', '**/*.test.ts'), true);
  assert.equal(matches('tests/a.test.ts', '**/*.test.ts'), true);
});

test('matcher: **/*.test.ts does not match a non-test source file', () => {
  assert.equal(matches('src/a.ts', '**/*.test.ts'), false);
});

test('matcher: * does not cross /', () => {
  assert.equal(matches('src/index.ts', 'src/*.ts'), true);
  assert.equal(matches('src/nested/index.ts', 'src/*.ts'), false);
});

test('matcher: rejects unsupported glob syntax in --tests patterns', () => {
  assert.throws(() => matches('src/a.ts', 'src/[a].ts'));
});
