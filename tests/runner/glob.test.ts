import test from 'node:test';
import assert from 'node:assert/strict';
import { matches } from '../../runner/src/glob.ts';

test('**/*.ts matches a nested .ts file', () => {
  assert.equal(matches('runner/src/validate.ts', '**/*.ts'), true);
  // A leading `**/` matches zero directories too, so a root-level file matches.
  assert.equal(matches('validate.ts', '**/*.ts'), true);
  assert.equal(matches('runner/src/validate.js', '**/*.ts'), false);
});

test('*.md matches a root-level file but does not cross /', () => {
  assert.equal(matches('README.md', '*.md'), true);
  // `*` never crosses `/`, so a nested README is NOT matched by `*.md`.
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
  // A literal is anchored: it is not a substring/prefix match.
  assert.equal(matches('runner/src/glob.ts.bak', 'runner/src/glob.ts'), false);
});

test('* does not cross /', () => {
  // Positive: `src/*.ts` matches a single segment after `src/`.
  assert.equal(matches('src/index.ts', 'src/*.ts'), true);
  // Negative: it must not match a deeper path.
  assert.equal(matches('src/nested/index.ts', 'src/*.ts'), false);
});
