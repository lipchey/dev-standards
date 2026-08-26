import test from 'node:test';
import assert from 'node:assert/strict';
import { matches as runnerMatches } from '../../runner/src/glob.ts';
import { matches as companionMatches } from '../../tools/check-companion-tests.mjs';
import { matches as diffCoverMatches } from '../../tools/diff-cover.mjs';
import { validate } from '../../runner/src/validate.ts';
import type { Manifest } from '../../runner/src/types.ts';

/* BUG-09: the restricted glob dialect had three divergent `**` implementations. runner/src/glob.ts
   treated ANY adjacent `**` as a globstar crossing "/", while the two policy tools treat `**` as
   recursive only when it is a WHOLE path segment. Same manifest pattern → different file selection.

   Fix: `**` is a globstar only as a whole segment; an embedded double-star (a**b) is within-segment
   stars in all three matchers, and the validator REJECTS embedded `**` outright. This single table
   pins that all three matchers now agree, and includes the documented counterexamples. */

const MATCHERS: Array<[string, (p: string, pat: string) => boolean]> = [
  ['runner/src/glob.ts', runnerMatches],
  ['tools/check-companion-tests.mjs', companionMatches],
  ['tools/diff-cover.mjs', diffCoverMatches],
];

// [path, pattern, expected] — expected is the whole-segment-`**` semantics all three must share.
const TABLE: Array<[string, string, boolean]> = [
  // The three documented counterexamples: embedded `**` must NOT cross "/" (was true only in runner).
  ['a/x/b', 'a**b', false],
  ['src/deep/file.ts', 'src**.ts', false],
  ['a/x/b/c', 'a**/c', false],
  // An embedded `**` DOES act as a within-segment wildcard (no "/" crossed).
  ['axb', 'a**b', true],
  ['srcX.ts', 'src**.ts', true],
  // Whole-segment `**` (globstar) — unchanged, must still agree.
  ['runner/src/validate.ts', '**/*.ts', true],
  ['a.test.ts', '**/*.ts', true],
  ['docs/a/b.md', 'docs/**', true],
  ['a/c', 'a/**/c', true],
  ['a/b/c', 'a/**/c', true],
  ['a/b/d/c', 'a/**/c', true],
  // Single `*` never crosses "/".
  ['src/index.ts', 'src/*.ts', true],
  ['src/nested/index.ts', 'src/*.ts', false],
  ['README.md', '*.md', true],
  ['docs/README.md', '*.md', false],
];

for (const [path, pattern, expected] of TABLE) {
  test(`glob conformance: "${path}" vs "${pattern}" → ${expected} across all three matchers`, () => {
    for (const [name, matches] of MATCHERS) {
      assert.equal(
        matches(path, pattern),
        expected,
        `${name}: matches(${JSON.stringify(path)}, ${JSON.stringify(pattern)}) should be ${expected}`,
      );
    }
  });
}

// The validator rejects the mixed forms so a manifest can never carry an ambiguous pattern.
function withInclude(pattern: string): Manifest {
  return {
    version: 1,
    repo: 'fixture',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 10, fast_seconds: 60, full_seconds: 120, audit_seconds: 120 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: false,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [{ name: 'fs', source: 'repo_all', include: [pattern] }],
    tiers: {
      staged: [],
      fast: [{ name: 'noop', argv: ['node', '--version'], timeout_seconds: 5, covers: ['.'] }],
      full: [],
    },
  };
}

test('BUG-09: the validator rejects embedded-** patterns (glob-globstar-segment)', () => {
  for (const pattern of ['a**b', 'src**.ts', 'a**/c']) {
    const result = validate(withInclude(pattern));
    assert.equal(result.ok, false, `expected "${pattern}" to be rejected`);
    assert.ok(
      result.errors.some((e) => e.path === 'filesets[0].include[0]' && e.rule === 'glob-globstar-segment'),
      `expected a glob-globstar-segment error for "${pattern}"; got:\n${JSON.stringify(result.errors, null, 2)}`,
    );
  }
});

test('BUG-09: the validator still accepts whole-segment ** patterns', () => {
  for (const pattern of ['**/*.ts', 'docs/**', 'a/**/c', 'src/*.ts']) {
    assert.equal(validate(withInclude(pattern)).ok, true, `"${pattern}" should be accepted`);
  }
});
