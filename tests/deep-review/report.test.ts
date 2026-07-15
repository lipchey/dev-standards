// E4 — the metadata-only report writer. renderReport emits ONLY finding metadata
// (id/severity/file:line/title/impact/status/sha), collapsing embedded
// newline/control whitespace so a finding can never break the markdown or smuggle
// a code block. Every lifecycle bucket renders its own section, and a HANDOFF_
// BLOCKING status opens the report with an INCOMPLETE marker. The secret scan is
// injected as a SecretScanResult: `unavailable` aborts fail-closed, `hit` aborts,
// `clean` writes. All effects (now / write) are injected — no real disk or scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EXIT_OK, EXIT_FAILURE, EXIT_SCANNER_UNAVAILABLE } from '../../deep-review/src/types.ts';
import type { FindingRecord, FindingsFileV2 } from '../../deep-review/src/types.ts';
import { renderReport, writeReport } from '../../deep-review/src/report.ts';
import type { WriteReportDeps } from '../../deep-review/src/report.ts';

// ── Builders ─────────────────────────────────────────────────────────────────

function validFinding(over: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: 'f-001',
    severity: 'P1',
    file: 'src/app.ts',
    line: 42,
    title: 'unchecked untrusted input reaches exec',
    impact: 'remote command execution',
    needs_plan: false,
    test_ref: 'verify:fast',
    slice_files: ['src/app.ts'],
    classification: 'fixable-now',
    status: 'fixed',
    sha: 'abc1234',
    ...over,
  };
}

function validFile(findings: FindingRecord[], mode: FindingsFileV2['mode'] = 'review-and-refactor'): FindingsFileV2 {
  return {
    schema: 2,
    mode,
    generated_at: '2026-06-14T00:00:00Z',
    run_id: null,
    base_sha: null,
    revision: 0,
    verification: null,
    self_review: null,
    findings,
  };
}

// One finding in EACH of the seven lifecycle buckets.
function allBuckets(): FindingsFileV2 {
  return validFile([
    validFinding({ id: 'f-fixed', status: 'fixed', classification: 'fixable-now', sha: 'deadbeef01' }),
    validFinding({ id: 'f-pending', status: 'pending', classification: 'fixable-now', title: 'awaiting fix', sha: '' }),
    validFinding({
      id: 'f-infra',
      status: 'infra-blocked',
      classification: 'fixable-now',
      title: 'spawn failed',
      infra_error: 'ENOENT',
      sha: '',
    }),
    validFinding({ id: 'f-failed', status: 'fix-failed', title: 'test stayed red', sha: '' }),
    validFinding({
      id: 'f-notouch',
      status: 'no-touch',
      classification: 'no-touch',
      file: 'auth/secret.ts',
      line: 10,
      title: 'secret in a no-touch file',
      sha: '',
    }),
    validFinding({
      id: 'f-plan',
      status: 'needs-plan',
      needs_plan: true,
      classification: 'needs-plan',
      title: 'cross-cutting refactor needs a plan',
      sha: '',
    }),
    validFinding({ id: 'f-invalid', status: 'invalid', classification: '', title: 'unsafe path localized', sha: '' }),
  ]);
}

// An in-memory write seam capturing (rootDir, relPath, content).
function captureWrites(): {
  writes: Array<{ rootDir: string; relPath: string; content: string }>;
  write: NonNullable<WriteReportDeps['write']>;
} {
  const writes: Array<{ rootDir: string; relPath: string; content: string }> = [];
  return {
    writes,
    write: (rootDir, relPath, content) => {
      writes.push({ rootDir, relPath, content });
      return path.resolve(rootDir, relPath);
    },
  };
}

const FIXED_NOW = (): Date => new Date('2026-06-14T12:30:00Z');

// ── renderReport (pure) ──────────────────────────────────────────────────────

test('renders a section for every lifecycle bucket, incl. Pending / Infra-blocked / Invalid', () => {
  const md = renderReport(allBuckets());
  for (const heading of ['Fixed', 'Pending', 'Infra-blocked', 'Fix-failed', 'No-touch', 'Needs-plan', 'Invalid']) {
    assert.match(md, new RegExp(`## ${heading}`), `missing section: ${heading}`);
  }
  // Fixed carries its SHA; the rejected buckets carry their one-line plan.
  assert.match(md, /deadbeef01/);
  assert.match(md, /awaiting fix/);
  assert.match(md, /cross-cutting refactor needs a plan/);
  assert.match(md, /unsafe path localized/);
});

test('opens with an INCOMPLETE marker naming the HANDOFF_BLOCKING count (pending + infra-blocked)', () => {
  const md = renderReport(allBuckets());
  // The marker is the FIRST line, counting the 2 blocking findings.
  assert.equal(md.split('\n')[0], '> INCOMPLETE: 2 findings not terminal');
});

test('no INCOMPLETE marker when nothing is pending / infra-blocked (report starts at the title)', () => {
  const terminal = validFile([
    validFinding({ id: 'a', status: 'fixed', sha: 'sha-a' }),
    validFinding({ id: 'b', status: 'no-touch', classification: 'no-touch', sha: '' }),
    validFinding({ id: 'c', status: 'invalid', classification: '', sha: '' }),
  ]);
  const md = renderReport(terminal);
  assert.equal(md.split('\n')[0], '# Deep-Review Report');
  assert.doesNotMatch(md, /INCOMPLETE/);
});

test('metadata-only: a title with embedded newlines + a code fence collapses to one line, no bare fence, no non-metadata', () => {
  const SENTINEL = 'SENTINEL-NONMETA';
  const file = validFile([
    validFinding({
      id: 'f-evil',
      title: 'line-before\n```\nrm -rf /\n```\nline-after',
      impact: `a\r\n\t${SENTINEL}`,
      status: 'fixed',
      sha: 'cafe00',
    }),
  ]);
  const md = renderReport(file);
  const lines = md.split('\n');
  const titleLine = lines.find((l) => l.includes('line-before'));
  assert.ok(titleLine, 'title rendered');
  assert.ok(titleLine.includes('line-after'), 'title newlines collapsed onto one line');
  assert.ok(!lines.some((l) => l.trimStart().startsWith('```')), 'no injected code fence at line start');
});

// ── writeReport (injected now / write / scanResult) ──────────────────────────

test('a clean scan writes to <reportsDir>/deep-review-<date>.md and returns the path', () => {
  const cap = captureWrites();
  const result = writeReport(allBuckets(), {
    reportsDir: '/var/reports',
    scanResult: { status: 'clean' },
    now: FIXED_NOW,
    write: cap.write,
  });
  const expected = path.resolve('/var/reports', 'deep-review-2026-06-14.md');
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.machineError, undefined);
  assert.equal(result.path, expected);
  assert.equal(cap.writes.length, 1);
  assert.equal(cap.writes[0]?.relPath, 'deep-review-2026-06-14.md');
  assert.equal(cap.writes[0]?.content, renderReport(allBuckets()));
});

test('an UNAVAILABLE scanner aborts fail-closed: EXIT_SCANNER_UNAVAILABLE, file NOT written', () => {
  const cap = captureWrites();
  const result = writeReport(allBuckets(), {
    reportsDir: '/var/reports',
    scanResult: { status: 'unavailable', reason: 'gitleaks wrapper missing' },
    now: FIXED_NOW,
    write: cap.write,
  });
  assert.equal(result.exitCode, EXIT_SCANNER_UNAVAILABLE);
  assert.equal(result.path, undefined);
  assert.equal(result.machineError?.step, 'secret-scan');
  assert.match(result.machineError?.stderr_tail ?? '', /gitleaks wrapper missing/);
  assert.equal(cap.writes.length, 0, 'file NOT written when the scanner is unavailable');
});

test('a scan HIT aborts: EXIT_FAILURE, file NOT written, machine error step "secret-scan"', () => {
  const cap = captureWrites();
  const result = writeReport(allBuckets(), {
    reportsDir: '/var/reports',
    scanResult: { status: 'hit', findings: 'gitleaks: aws-access-key at line 3' },
    now: FIXED_NOW,
    write: cap.write,
  });
  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.path, undefined);
  assert.equal(result.machineError?.step, 'secret-scan');
  assert.match(result.machineError?.stderr_tail ?? '', /aws-access-key/);
  assert.equal(cap.writes.length, 0, 'file NOT written on a secret-scan hit');
});
