import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFeatureSlug, SlugError } from '../../deep-review/src/feature-slug.ts';

test('slug-accepts-lowercase-digits-dashes-length-1-to-60', () => {
  assert.equal(sanitizeFeatureSlug('a'), 'a');
  assert.equal(sanitizeFeatureSlug('abc-123'), 'abc-123');
  assert.equal(sanitizeFeatureSlug('a'.repeat(60)), 'a'.repeat(60));
});

test('slug-rejects-instead-of-rewriting-hostile-input', () => {
  const bad = [
    '',
    'A',
    'has/slash',
    'has\\slash',
    '..',
    '../etc',
    '../../etc',
    '-leading',
    'semi;rm-rf',
    '$(touch-pwned)',
    '`touch-pwned`',
    `nul${String.fromCharCode(0)}byte`,
    'non-ascii-é',
    'a'.repeat(200),
  ];

  for (const value of bad) {
    assert.throws(
      () => sanitizeFeatureSlug(value),
      (err: unknown) => err instanceof SlugError && err.input === value,
      `expected ${JSON.stringify(value)} to be rejected verbatim`,
    );
  }
});

test('slug-error-keeps-hostile-value-as-data-only', () => {
  const hostile = '$(echo pwned)';
  try {
    sanitizeFeatureSlug(hostile);
  } catch (err) {
    assert.ok(err instanceof SlugError);
    assert.equal(err.input, hostile, 'the original value is retained only as data for reporting');
    assert.match(err.message, /invalid feature slug/);
    return;
  }
  assert.fail('expected hostile slug to throw');
});

