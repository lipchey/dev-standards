import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseUnifiedDiff,
  normalizeCoverageKeys,
  computeCoverage,
  loadCoverage,
  parseThreshold,
  remoteAndBranch,
} from '../../tools/diff-cover.mjs';

/* Local istanbul-entry shape — the dep-free .mjs tool exports no types. */
type CoverageEntry = {
  path?: string;
  statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
  s: Record<string, number>;
};

// Build an istanbul-shape entry from [startLine, endLine, hits] statements.
function cov(statements: Array<[number, number, number]>): CoverageEntry {
  const statementMap: Record<string, { start: { line: number }; end: { line: number } }> = {};
  const s: Record<string, number> = {};
  statements.forEach(([start, end, hits], i) => {
    statementMap[i] = { start: { line: start }, end: { line: end } };
    s[i] = hits;
  });
  return { statementMap, s };
}

/* ---- parseUnifiedDiff ---- (diffs mirror real `git diff --unified=0` output:
 * each file section opens with a `diff --git` line, then `--- `/`+++ ` headers) */

test('parseUnifiedDiff: single hunk with explicit +c,d', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -0,0 +3,2 @@',
    '+one',
    '+two',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff), { 'src/a.ts': [3, 4] });
});

test('parseUnifiedDiff: +c with d omitted means one line', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '+++ b/src/a.ts', '@@ -5 +5 @@', '+changed'].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff), { 'src/a.ts': [5] });
});

test('parseUnifiedDiff: multiple hunks across two files', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '+a1',
    '@@ -10,0 +11,2 @@',
    '+a11',
    '+a12',
    'diff --git a/src/b.ts b/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -0,0 +7,1 @@',
    '+b7',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff), { 'src/a.ts': [1, 11, 12], 'src/b.ts': [7] });
});

test('parseUnifiedDiff: deletion-only hunk (+c,0) yields no new lines', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '+++ b/src/a.ts', '@@ -4,2 +3,0 @@'].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff), {});
});

test('parseUnifiedDiff: file deleted (+++ /dev/null) is skipped', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff), {});
});

test('parseUnifiedDiff: an added body line starting with "+++ " is not a false file header', () => {
  // The added source line is `++ counter;` → the diff prints it as `+++ counter;`.
  // A naive `startsWith("+++ ")` check would treat it as a new-file header.
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,1 @@',
    '+++ counter;',
    '@@ -10,0 +20,1 @@',
    '+later',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff), { 'src/a.ts': [1, 20] });
});

/* ---- normalizeCoverageKeys ---- */

test('normalizeCoverageKeys: absolute keys become root-relative POSIX', () => {
  const root = '/repo';
  const out = normalizeCoverageKeys(
    { '/repo/src/a.ts': cov([[1, 1, 1]]) },
    root,
  );
  assert.deepEqual(Object.keys(out), ['src/a.ts']);
});

test('normalizeCoverageKeys: prefers entry.path over the object key', () => {
  const out = normalizeCoverageKeys(
    { someKey: { ...cov([[1, 1, 1]]), path: '/repo/src/a.ts' } },
    '/repo',
  );
  assert.deepEqual(Object.keys(out), ['src/a.ts']);
});

test('normalizeCoverageKeys: entries outside the root are dropped', () => {
  const out = normalizeCoverageKeys(
    { '/repo/src/a.ts': cov([[1, 1, 1]]), '/etc/passwd.ts': cov([[1, 1, 1]]) },
    '/repo',
  );
  assert.deepEqual(Object.keys(out), ['src/a.ts']);
});

test('normalizeCoverageKeys: duplicate normalized key is a loud fail', () => {
  assert.throws(
    () =>
      normalizeCoverageKeys(
        {
          k1: { ...cov([[1, 1, 1]]), path: '/repo/src/a.ts' },
          k2: { ...cov([[2, 2, 1]]), path: '/repo/src/a.ts' },
        },
        '/repo',
      ),
    /duplicate normalized coverage key/,
  );
});

/* ---- computeCoverage ---- */

test('computeCoverage: a changed line is covered when its statement has s>0', () => {
  const result = computeCoverage({ 'src/a.ts': [5] }, { 'src/a.ts': cov([[5, 5, 3]]) });
  assert.deepEqual(result, {
    total: 100,
    files: [{ path: 'src/a.ts', changedExecutable: 1, covered: 1, pct: 100 }],
  });
});

test('computeCoverage: a changed line at s=0 is executable but uncovered', () => {
  const result = computeCoverage({ 'src/a.ts': [5] }, { 'src/a.ts': cov([[5, 5, 0]]) });
  assert.equal(result.total, 0);
  assert.deepEqual(result.files[0], { path: 'src/a.ts', changedExecutable: 1, covered: 1 * 0, pct: 0 });
});

test('computeCoverage: a non-executable changed line is excluded from the denominator', () => {
  // Line 6 is not spanned by any statement (blank/comment) → not counted.
  const result = computeCoverage({ 'src/a.ts': [5, 6] }, { 'src/a.ts': cov([[5, 5, 1]]) });
  assert.equal(result.total, 100);
  assert.equal(result.files[0]?.changedExecutable, 1);
});

test('computeCoverage: a changed file absent from coverage is excluded, not scored 0%', () => {
  const result = computeCoverage(
    { 'src/a.ts': [5], 'README.md': [1, 2] },
    { 'src/a.ts': cov([[5, 5, 1]]) },
  );
  assert.equal(result.total, 100);
  assert.deepEqual(result.files.map((f) => f.path), ['src/a.ts']);
});

test('computeCoverage: files matching an --exclude glob are skipped', () => {
  const result = computeCoverage(
    { 'src/a.ts': [5], 'src/a.test.ts': [5] },
    { 'src/a.ts': cov([[5, 5, 1]]), 'src/a.test.ts': cov([[5, 5, 0]]) },
    { excludes: ['**/*.test.ts'] },
  );
  assert.equal(result.total, 100);
  assert.deepEqual(result.files.map((f) => f.path), ['src/a.ts']);
});

test('computeCoverage: total is aggregate covered/executable across files', () => {
  const result = computeCoverage(
    { 'src/a.ts': [5], 'src/b.ts': [1, 2] },
    { 'src/a.ts': cov([[5, 5, 1]]), 'src/b.ts': cov([[1, 1, 0], [2, 2, 0]]) },
  );
  // 1 covered of 3 executable = 33.33
  assert.equal(result.total, 33.33);
});

test('computeCoverage: threshold boundary — exactly 70 passes', () => {
  const statements = Array.from({ length: 10 }, (_, i): [number, number, number] => [
    i + 1,
    i + 1,
    i < 7 ? 1 : 0,
  ]);
  const changed = Array.from({ length: 10 }, (_, i) => i + 1);
  const result = computeCoverage({ 'src/a.ts': changed }, { 'src/a.ts': cov(statements) });
  assert.equal(result.total, 70);
  assert.ok((result.total as number) >= 70, '70 must satisfy a threshold of 70');
});

test('computeCoverage: zero executable changed lines → total is N/A (null)', () => {
  // Only line 6 changed; the sole statement starts on line 5 → nothing executable changed.
  const result = computeCoverage({ 'src/a.ts': [6] }, { 'src/a.ts': cov([[5, 5, 1]]) });
  assert.equal(result.total, null);
  assert.deepEqual(result.files, []);
});

test('computeCoverage: a covered outer statement does not mask an uncovered statement on the same line', () => {
  // Outer statement starts line 1 (hit); a nested statement starts line 2 (NOT hit).
  // Span-expansion would mark line 2 covered by the outer; start-line semantics do not.
  const result = computeCoverage(
    { 'src/a.ts': [1, 2] },
    { 'src/a.ts': cov([[1, 3, 5], [2, 2, 0]]) },
  );
  // line 1 covered (outer hit), line 2 uncovered (its own statement unhit) → 1/2 = 50%.
  assert.equal(result.total, 50);
});

test('computeCoverage: multiple statements on one line → covered if any is hit (max count)', () => {
  const result = computeCoverage(
    { 'src/a.ts': [4] },
    { 'src/a.ts': cov([[4, 4, 0], [4, 4, 3]]) },
  );
  assert.equal(result.total, 100);
});

test('computeCoverage: an --include source file absent from coverage is a loud fail', () => {
  assert.throws(
    () =>
      computeCoverage(
        { 'src/new.ts': [1, 2] },
        { 'src/a.ts': cov([[1, 1, 1]]) },
        { includes: ['src/**/*.ts'] },
      ),
    /matches --include but has no coverage entry/,
  );
});

test('computeCoverage: absent file with no --include is still skipped (not a fail)', () => {
  const result = computeCoverage(
    { 'src/a.ts': [1], 'README.md': [1] },
    { 'src/a.ts': cov([[1, 1, 1]]) },
    { includes: ['src/**/*.ts'] },
  );
  // README.md does not match --include → skipped, not a loud fail.
  assert.equal(result.total, 100);
  assert.deepEqual(result.files.map((f) => f.path), ['src/a.ts']);
});

/* ---- loadCoverage (freshness, C10) ---- */

function tmpFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-cover-'));
  const file = path.join(dir, 'coverage-final.json');
  fs.writeFileSync(file, contents);
  return file;
}

test('loadCoverage: a fresh coverage file is parsed and returned', () => {
  const file = tmpFile(JSON.stringify({ 'src/a.ts': cov([[1, 1, 1]]) }));
  try {
    const map = loadCoverage(file);
    assert.ok(map['src/a.ts']);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('loadCoverage: a stale coverage file (old mtime) is a loud fail', () => {
  const file = tmpFile('{}');
  try {
    const old = Math.floor(Date.now() / 1000) - 1000; // 1000s old > 600s backstop
    fs.utimesSync(file, old, old);
    assert.throws(() => loadCoverage(file), /stale/);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('loadCoverage: a missing coverage file is a loud fail', () => {
  assert.throws(() => loadCoverage('/nonexistent/coverage-final.json'), /not found/);
});

/* ---- parseThreshold (R2-1: a blank threshold must not disable the gate) ---- */

test('parseThreshold: blank / whitespace is rejected, not silently 0', () => {
  assert.throws(() => parseThreshold(''), /\[0, 100\]/);
  assert.throws(() => parseThreshold('   '), /\[0, 100\]/);
});

test('parseThreshold: non-numeric and out-of-range are rejected', () => {
  assert.throws(() => parseThreshold('abc'), /\[0, 100\]/);
  assert.throws(() => parseThreshold('-1'), /\[0, 100\]/);
  assert.throws(() => parseThreshold('101'), /\[0, 100\]/);
});

test('parseThreshold: valid values including the endpoints', () => {
  assert.equal(parseThreshold('70'), 70);
  assert.equal(parseThreshold('0'), 0);
  assert.equal(parseThreshold('100'), 100);
  assert.equal(parseThreshold(' 42.5 '), 42.5);
});

/* ---- remoteAndBranch (R2-2: deepen the base ref's OWN remote) ---- */

test('remoteAndBranch: derives the ref\'s own remote and branch', () => {
  assert.deepEqual(remoteAndBranch('origin/main'), ['origin', 'main']);
  assert.deepEqual(remoteAndBranch('refs/remotes/upstream/main'), ['upstream', 'main']);
  assert.deepEqual(remoteAndBranch('upstream/feature/x'), ['upstream', 'feature/x']);
  assert.deepEqual(remoteAndBranch('main'), ['origin', 'main']);
});
