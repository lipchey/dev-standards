// E4 — the metadata-only secret-scanned report writer. The PRIMARY safety
// guarantee is construction: `renderReport` emits ONLY finding metadata
// (id/severity/file:line/title/impact/status/sha), collapsing any embedded
// newline/control whitespace in title/impact to a single space so a finding can
// never break the markdown structure or smuggle a multi-line code block. The
// secret scan is a best-effort SECOND layer: a hit aborts the write. Both the
// pure renderer and the writer (with injected now()/scanner/fs-write seams) are
// unit-tested here with no real disk or scan, plus one case that exercises the
// real default scanner (no-op-clean in dev-standards / every fixture repo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EXIT_OK, EXIT_FAILURE } from '../../deep-review/src/types.ts';
import type { FindingRecord, FindingsFile } from '../../deep-review/src/types.ts';
import { renderReport, writeReport } from '../../deep-review/src/report.ts';
import type { WriteReportDeps } from '../../deep-review/src/report.ts';

// ── Builders ───────────────────────────────────────────────────────────────────

function validFinding(over: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: 'f-001',
    severity: 'P1',
    file: 'src/app.ts',
    line: 42,
    title: 'unchecked untrusted input reaches exec',
    impact: 'remote command execution',
    needs_plan: false,
    test_cmd: ['npm', 'test'],
    slice_files: ['src/app.ts'],
    classification: 'fixable-now',
    status: 'fixed',
    sha: 'abc1234',
    ...over,
  };
}

function validFile(findings: FindingRecord[], mode: FindingsFile['mode'] = 'review-and-refactor'): FindingsFile {
  return { schema: 1, mode, generated_at: '2026-06-14T00:00:00Z', findings };
}

// A findings file with one finding in EACH of the four report buckets.
function mixedFile(): FindingsFile {
  return validFile([
    validFinding({ id: 'f-fixed', severity: 'P1', file: 'src/app.ts', line: 42, status: 'fixed', sha: 'deadbeef01' }),
    validFinding({
      id: 'f-notouch',
      severity: 'P2',
      file: 'auth/secret.ts',
      line: 10,
      title: 'secret rotated in a no-touch file',
      impact: 'must be handled by a human',
      classification: 'no-touch',
      status: 'no-touch',
      sha: '',
    }),
    validFinding({
      id: 'f-plan',
      severity: 'P1',
      file: 'lib/util.ts',
      line: 5,
      title: 'cross-cutting refactor needs a plan',
      impact: 'touches many call sites',
      needs_plan: true,
      classification: 'needs-plan',
      status: 'needs-plan',
      sha: '',
    }),
    validFinding({
      id: 'f-failed',
      severity: 'P3',
      file: 'src/broken.ts',
      line: 1,
      title: 'attempted fix did not pass its test',
      impact: 'reverted, left for follow-up',
      status: 'fix-failed',
      sha: '',
    }),
  ]);
}

// An in-memory write seam that records what was written.
function captureWrites(): { writes: Array<{ path: string; content: string }>; writeFile: WriteReportDeps['writeFile'] } {
  const writes: Array<{ path: string; content: string }> = [];
  return { writes, writeFile: (p, content) => writes.push({ path: p, content }) };
}

const FIXED_NOW = (): Date => new Date('2026-06-14T12:30:00Z');

// ── renderReport (pure) ──────────────────────────────────────────────────────

test('renders a metadata-only markdown report: fixed slices + SHAs, then the no-touch / needs-plan / fix-failed buckets with their plan lines', () => {
  const md = renderReport(mixedFile());

  // The four buckets are present as section headers.
  assert.match(md, /Fixed/);
  assert.match(md, /No-touch/);
  assert.match(md, /Needs-plan/);
  assert.match(md, /Fix-failed/);

  // The fixed finding carries its SHA; the rejected buckets carry their one-line
  // plan (title + impact).
  assert.match(md, /deadbeef01/);
  assert.match(md, /secret rotated in a no-touch file/);
  assert.match(md, /must be handled by a human/);
  assert.match(md, /cross-cutting refactor needs a plan/);
  assert.match(md, /attempted fix did not pass its test/);
  assert.match(md, /reverted, left for follow-up/);

  // Every finding's id, severity and file:line appear (metadata).
  assert.match(md, /f-fixed/);
  assert.match(md, /src\/app\.ts:42/);
  assert.match(md, /auth\/secret\.ts:10/);
  assert.match(md, /P1/);
});

test('the report body contains only titles/impacts/SHAs/paths -- never a finding\'s raw code/body (metadata-only assertion)', () => {
  // A title carrying embedded newlines + a markdown code fence + control chars:
  // it must be collapsed to a SINGLE line so it can never start a fenced code
  // block or break the markdown structure.
  const SENTINEL_CMD = 'SENTINEL-TESTCMD-TOKEN';
  const file = validFile([
    validFinding({
      id: 'f-evil',
      title: 'line-before\n```\nrm -rf /\n```\nline-after',
      impact: 'a\r\n\tb',
      // a non-metadata field — must never be rendered.
      test_cmd: [SENTINEL_CMD, '--run'],
      status: 'fixed',
      sha: 'cafe00',
    }),
  ]);

  const md = renderReport(file);
  const lines = md.split('\n');

  // The two halves of the multi-line title landed on the SAME output line — the
  // embedded newlines were collapsed to spaces (single-line-per-field).
  const titleLine = lines.find((l) => l.includes('line-before'));
  assert.ok(titleLine, 'title rendered');
  assert.ok(titleLine.includes('line-after'), 'title newlines collapsed onto one line');

  // No output line is a bare code fence: the smuggled ``` cannot open a block.
  assert.ok(!lines.some((l) => l.trimStart().startsWith('```')), 'no injected code fence');

  // The non-metadata test_cmd is never rendered.
  assert.ok(!md.includes(SENTINEL_CMD), 'test_cmd (non-metadata) not in report');
});

test('empty findings / all-rejected findings still produce a valid report (no crash)', () => {
  // Empty: still a non-empty, valid report (just the header / empty sections).
  const empty = renderReport(validFile([]));
  assert.equal(typeof empty, 'string');
  assert.ok(empty.length > 0);

  // All-rejected (no fixed finding): the rejected buckets render, no crash.
  const rejected = renderReport(
    validFile([
      validFinding({ id: 'r-1', classification: 'no-touch', status: 'no-touch', sha: '' }),
      validFinding({ id: 'r-2', needs_plan: true, classification: 'needs-plan', status: 'needs-plan', sha: '' }),
      validFinding({ id: 'r-3', status: 'fix-failed', sha: '' }),
    ]),
  );
  assert.match(rejected, /No-touch/);
  assert.match(rejected, /Needs-plan/);
  assert.match(rejected, /Fix-failed/);
});

// ── writeReport (injected now / scanner / fs-write) ──────────────────────────

test('writes to <reportsDir>/deep-review-<date>.md using an injected clock (fixed date -> deterministic filename)', () => {
  const cap = captureWrites();
  const result = writeReport(mixedFile(), {
    reportsDir: '/var/reports',
    writeFile: cap.writeFile,
    now: FIXED_NOW,
    scan: () => null, // clean
  });

  const expected = path.join('/var/reports', 'deep-review-2026-06-14.md');
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.machineError, undefined);
  assert.equal(result.path, expected);
  assert.equal(cap.writes.length, 1);
  assert.equal(cap.writes[0]?.path, expected);
  // The written content is exactly the rendered (scanned) body.
  assert.equal(cap.writes[0]?.content, renderReport(mixedFile()));
});

test('default scanner (no tools/run-gitleaks wrapper) resolves to no-op-clean -> file written (encodes the real dev-standards/fixture behavior)', () => {
  const cap = captureWrites();
  // `scan` OMITTED -> the real createSecretScanner() default, resolved at
  // process.cwd() (the dev-standards repo / a fixture repo) where no
  // tools/run-gitleaks wrapper exists, so it is a NO-OP returning clean.
  const result = writeReport(mixedFile(), {
    reportsDir: '/var/reports',
    writeFile: cap.writeFile,
    now: FIXED_NOW,
  });

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.machineError, undefined);
  assert.equal(result.path, path.join('/var/reports', 'deep-review-2026-06-14.md'));
  assert.equal(cap.writes.length, 1, 'default scanner is no-op-clean -> file written');
});

test('an INJECTED scanner that returns a hit aborts: the file is NOT written, EXIT_FAILURE + machine error with step "secret-scan"', () => {
  const cap = captureWrites();
  const result = writeReport(mixedFile(), {
    reportsDir: '/var/reports',
    writeFile: cap.writeFile,
    now: FIXED_NOW,
    scan: () => 'gitleaks flagged the PR content (exit 1): aws-access-key',
  });

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.path, undefined);
  assert.ok(result.machineError, 'machine error present');
  assert.equal(result.machineError?.step, 'secret-scan');
  assert.match(result.machineError?.stderr_tail ?? '', /aws-access-key/);
  assert.equal(cap.writes.length, 0, 'file NOT written on a secret-scan hit');
});
