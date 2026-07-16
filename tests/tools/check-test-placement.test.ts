import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, main, matches } from '../../tools/check-test-placement.mjs';

const maps = [
  { testRoot: 'tests/runner', sourceRoot: 'runner/src', sourceExt: '.ts' },
  { testRoot: 'tests/tools', sourceRoot: 'tools', sourceExt: '.mjs' },
  { testRoot: 'tests/tools', sourceRoot: 'scripts', sourceExt: '.sh' },
];
const testGlobs = ['**/*.test.ts', '**/*.test.mjs'];
const ev = (files: string[], ignoreGlobs: string[] = []) =>
  evaluate(files, { maps, testGlobs, ignoreGlobs });

test('mirrored test at the top of an area passes', () => {
  const r = ev(['runner/src/exec.ts', 'tests/runner/exec.test.ts']);
  assert.equal(r.ok, true);
});

test('subfolder is mirrored: test in a subdir maps to source in the same subdir', () => {
  const r = ev(['runner/src/http/client.ts', 'tests/runner/http/client.test.ts']);
  assert.equal(r.ok, true);
});

test('subfolder MISMATCH is a finding: source is nested but the test sits at the area root', () => {
  const r = ev(['runner/src/http/client.ts', 'tests/runner/client.test.ts']);
  assert.equal(r.ok, false);
  assert.equal(r.misplaced[0]?.expected, 'runner/src/client.ts');
});

test('dot-strip lets one source own several test variants (exec.bypass.test.ts -> exec.ts)', () => {
  const r = ev(['runner/src/exec.ts', 'tests/runner/exec.test.ts', 'tests/runner/exec.bypass.test.ts']);
  assert.equal(r.ok, true);
});

test('cross-root subject: a tests/tools test whose subject is a scripts/*.sh passes (multi-map)', () => {
  const r = ev(['scripts/seed.sh', 'tests/tools/seed.test.ts']);
  assert.equal(r.ok, true);
});

test('misplaced: a test whose subject exists in no mapped root/ext is a finding', () => {
  const r = ev(['tests/runner/ghost.test.ts']);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.misplaced.map((m) => m.test),
    ['tests/runner/ghost.test.ts'],
  );
});

test('--ignore suppresses a cross-cutting test with no 1:1 subject', () => {
  const r = ev(['tests/runner/glob-conformance.test.ts'], ['tests/runner/glob-conformance.test.ts']);
  assert.equal(r.ok, true);
});

test('a test outside every mapped root is not this gate concern (skipped, not flagged)', () => {
  const r = ev(['tests/e2e/smoke.test.ts']);
  assert.equal(r.ok, true);
});

test('hyphens are NOT stripped (dot-strip only), since hyphens are part of real source basenames', () => {
  /* An exact hyphenated name resolves as-is... */
  const exact = ev(['tools/check-new-deps.mjs', 'tests/tools/check-new-deps.test.ts']);
  assert.equal(exact.ok, true);
  /* ...but slug.test.ts must NOT be hyphen-stripped onto feature-slug.ts — that would be a false pass. */
  const miss = ev(['runner/src/feature-slug.ts', 'tests/runner/slug.test.ts']);
  assert.equal(miss.ok, false);
});

test('matcher: ** matches at any depth incl. zero segments; * stays within a segment', () => {
  assert.equal(matches('a.test.ts', '**/*.test.ts'), true);
  assert.equal(matches('tests/runner/a.test.ts', '**/*.test.ts'), true);
  /* trailing ** — the shape used by the ignore globs (tests/deep-review-e2e/**): */
  assert.equal(matches('tests/e2e/deep/x.test.ts', 'tests/e2e/**'), true);
  assert.equal(matches('other/x.test.ts', 'tests/e2e/**'), false);
  assert.equal(matches('a/b.ts', 'a/*'), true);
  assert.equal(matches('a/b/c.ts', 'a/*'), false);
});

test('overlapping roots: rel/candidates are resolved per-map, never cross-contaminated', () => {
  const overMaps = [
    { testRoot: 'tests/runner', sourceRoot: 'runner/src', sourceExt: '.ts' },
    { testRoot: 'tests', sourceRoot: 'src', sourceExt: '.ts' },
  ];
  const run = (files: string[]) => evaluate(files, { maps: overMaps, testGlobs, ignoreGlobs: [] });
  assert.equal(run(['runner/src/a.ts', 'tests/runner/a.test.ts']).ok, true); // narrow map resolves it
  assert.equal(run(['src/a.ts', 'tests/runner/a.test.ts']).ok, false); // src/a.ts must NOT satisfy it
  assert.equal(run(['src/runner/a.ts', 'tests/runner/a.test.ts']).ok, true); // broad map's real candidate
});

test('a sibling that shares a name prefix (tests/runner-x) is not matched by the tests/runner root', () => {
  assert.equal(ev(['tests/runner-x/a.test.ts']).ok, true); // no map matches -> skipped, not flagged
});

test('a leading-dot stem is not dot-stripped away (the dot>0 guard)', () => {
  assert.equal(ev(['runner/src/.hidden.ts', 'tests/runner/.hidden.test.ts']).ok, true);
});

test('empty file list: nothing to check, ok', () => {
  assert.equal(ev([]).ok, true);
});

/* main() exit-code contract: 0 = ok, 1 = finding, 2 = operational (an internal throw). The distinct
   code 2 lets the runner's operational_exit_codes classify a throw as an 'error', not a finding. */
test('main: a mirrored pair is exit 0; a misplaced test is exit 1', () => {
  const argv = ['--map', 'tests/runner:runner/src:.ts', '--test-glob', '**/*.test.ts', '--'];
  assert.equal(main([...argv, 'runner/src/a.ts', 'tests/runner/a.test.ts']), 0);
  assert.equal(main([...argv, 'tests/runner/ghost.test.ts']), 1);
});

test('main: no --map is an operational failure (exit 2), never a finding', () => {
  assert.equal(main(['--test-glob', '**/*.test.ts', '--', 'tests/runner/a.test.ts']), 2);
});

test('main: a malformed --map is an operational failure (exit 2)', () => {
  assert.equal(main(['--map', 'tests/runner:runner/src', '--', 'x']), 2);
});

test('main: a trailing-slash map root fails closed (exit 2), never a silent no-op', () => {
  assert.equal(main(['--map', 'tests/runner/:runner/src:.ts', '--', 'x']), 2);
});

test('main: an empty --test-glob fails closed (exit 2), never silently disabling the check', () => {
  assert.equal(main(['--map', 'tests/runner:runner/src:.ts', '--test-glob', '', '--', 'x']), 2);
});

test('main: an unsupported glob in --ignore is an operational failure (exit 2)', () => {
  assert.equal(main(['--map', 'tests/runner:runner/src:.ts', '--ignore', 'a/[b].ts', '--', 'x']), 2);
});
