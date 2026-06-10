import test from 'node:test';
import assert from 'node:assert/strict';
import { matches } from '../../runner/src/glob.ts';

test('**/*.ts matches a nested .ts file', () => {
  assert.equal(matches('runner/src/validate.ts', '**/*.ts'), true);
  assert.equal(matches('validate.ts', '**/*.ts'), true);
  assert.equal(matches('runner/src/validate.js', '**/*.ts'), false);
});

test('*.md matches a root-level file but does not cross /', () => {
  assert.equal(matches('README.md', '*.md'), true);
  assert.equal(matches('docs/README.md', '*.md'), false);
});

test('docs/** matches any depth under docs', () => {
  assert.equal(matches('docs/a/b.md', 'docs/**'), true);
  assert.equal(matches('docs/a.md', 'docs/**'), true);
  assert.equal(matches('other/a/b.md', 'docs/**'), false);
});

test('literal paths match exactly', () => {
  assert.equal(matches('runner/src/glob.ts', 'runner/src/glob.ts'), true);
  assert.equal(matches('runner/src/glob.ts', 'runner/src/git.ts'), false);
  assert.equal(matches('runner/src/glob.ts.bak', 'runner/src/glob.ts'), false);
});

test('* does not cross /', () => {
  assert.equal(matches('src/index.ts', 'src/*.ts'), true);
  assert.equal(matches('src/nested/index.ts', 'src/*.ts'), false);
});

test('a middle ** matches zero or more intervening directories', () => {
  assert.equal(matches('a/c', 'a/**/c'), true);
  assert.equal(matches('a/b/c', 'a/**/c'), true);
  assert.equal(matches('a/b/d/c', 'a/**/c'), true);
  assert.equal(matches('a/b/cx', 'a/**/c'), false);
});

test('matches resists catastrophic backtracking on many doublestars (ReDoS)', () => {
  // Former RegExp translation was exponential on adjacent doublestars.
  const pattern = '**/'.repeat(14) + 'x.ts';
  const input = 'a/'.repeat(14) + 'no-match.js';
  const start = process.hrtime.bigint();
  const result = matches(input, pattern);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(result, false);
  assert.ok(elapsedMs < 1000, `glob match took ${elapsedMs.toFixed(1)}ms, expected < 1000ms (ReDoS)`);
});
