import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFinding, classifyAll } from '../../deep-review/src/classify.ts';
import { readFindings, writeFindings } from '../../deep-review/src/findings-io.ts';
import type { FindingRecord, FindingStatus, FindingsFile } from '../../deep-review/src/types.ts';

// ── Test doubles ─────────────────────────────────────────────────────────────

// In-memory fs seam (matches findings-io.test.ts) so the round-trip never touches
// real disk.
function memFs(initial: Record<string, string> = {}): {
  store: Map<string, string>;
  deps: { readFile: (p: string) => string; writeFile: (p: string, content: string) => void };
} {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    deps: {
      readFile: (p: string): string => {
        const value = store.get(p);
        if (value === undefined) throw new Error(`ENOENT: ${p}`);
        return value;
      },
      writeFile: (p: string, content: string): void => {
        store.set(p, content);
      },
    },
  };
}

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
    classification: '',
    status: 'pending',
    sha: '',
    ...over,
  };
}

function validFile(findings: FindingRecord[]): FindingsFile {
  return {
    schema: 1,
    mode: 'review-and-refactor',
    generated_at: '2026-06-14T00:00:00Z',
    findings,
  };
}

// Pure isNoTouchFn stubs for the unit-level classifyFinding cases.
const noneNoTouch = (): boolean => false;
const allNoTouch = (): boolean => true;

// ── classifyFinding (pure) ───────────────────────────────────────────────────

test('a finding whose file is in the no-touch set -> classification "no-touch", status "no-touch" (even if needs_plan is false)', () => {
  const finding = validFinding({ file: 'auth/secret.ts', needs_plan: false });
  const result = classifyFinding(finding, (p) => p === 'auth/secret.ts');
  assert.deepEqual(result, { classification: 'no-touch', status: 'no-touch' });
});

test('a finding with needs_plan: true and an editable file -> classification "needs-plan", status "needs-plan"', () => {
  const finding = validFinding({ file: 'src/app.ts', needs_plan: true });
  const result = classifyFinding(finding, noneNoTouch);
  assert.deepEqual(result, { classification: 'needs-plan', status: 'needs-plan' });
});

test('a finding with needs_plan: false and an editable file -> classification "fixable-now", status "pending"', () => {
  const finding = validFinding({ file: 'src/app.ts', needs_plan: false });
  const result = classifyFinding(finding, noneNoTouch);
  assert.deepEqual(result, { classification: 'fixable-now', status: 'pending' });
});

test('no-touch WINS over needs_plan: needs_plan: true in a no-touch file -> "no-touch" (never autonomously planned-then-edited there)', () => {
  // SAFETY: a no-touch path is ALWAYS emitted as a plan, never autonomously
  // planned-then-edited; no-touch must win even when needs_plan asks for a plan.
  const finding = validFinding({ file: 'auth/secret.ts', needs_plan: true });
  const result = classifyFinding(finding, allNoTouch);
  assert.deepEqual(result, { classification: 'no-touch', status: 'no-touch' });
});

test('defense-in-depth: an editable file with a NO-TOUCH slice_files entry -> classification "no-touch" (routing mirrors commit-slice enforcement)', () => {
  const finding = validFinding({
    file: 'src/app.ts',
    slice_files: ['src/app.ts', 'tools/danger.sh'],
    needs_plan: false,
  });
  const result = classifyFinding(finding, (p) => p === 'tools/danger.sh');
  assert.deepEqual(result, { classification: 'no-touch', status: 'no-touch' });
});

// ── classifyAll (over a file, incl. an already-invalid finding) ──────────────

test('classifyAll: an editable file with a no-touch slice_files entry classifies as "no-touch"', () => {
  const file = validFile([
    validFinding({ id: 'f-x', file: 'src/app.ts', slice_files: ['src/app.ts', 'tools/danger.sh'], needs_plan: false }),
  ]);
  const out = classifyAll(file, ['tools/**']);
  assert.deepEqual(
    [out.findings[0]?.classification, out.findings[0]?.status],
    ['no-touch', 'no-touch'],
  );
});

test('an "invalid"-path finding (from findings-io) is left status "invalid", classification untouched', () => {
  // needs_plan: true would otherwise classify to needs-plan; the invalid status
  // (set by findings-io path-safety) must short-circuit and survive untouched.
  const invalid = validFinding({
    id: 'bad-1',
    file: 'src/app.ts',
    needs_plan: true,
    classification: '',
    status: 'invalid',
  });
  const out = classifyAll(validFile([invalid]), ['auth/**']);
  const finding = out.findings[0];
  assert.ok(finding);
  assert.equal(finding.status, 'invalid');
  assert.equal(finding.classification, '');
});

test('classify writes results in place; unrelated fields and other findings round-trip byte-stable', () => {
  const original = validFile([
    validFinding({ id: 'f-001', file: 'src/app.ts', needs_plan: false }),
    validFinding({
      id: 'f-002',
      file: 'lib/util.ts',
      needs_plan: true,
      slice_files: ['lib/util.ts', 'lib/helper.ts'],
    }),
    validFinding({ id: 'f-003', file: 'auth/keys.ts', needs_plan: false, slice_files: ['auth/keys.ts'] }),
    validFinding({ id: 'f-004', file: 'tools/x.ts', status: 'invalid', classification: '' }),
  ]);

  const set = ['auth/**'];
  const out = classifyAll(original, set);

  // Each non-invalid finding receives its [classification, status]; the invalid
  // one is left exactly as-is.
  assert.deepEqual(
    out.findings.map((f) => [f.classification, f.status]),
    [
      ['fixable-now', 'pending'],
      ['needs-plan', 'needs-plan'],
      ['no-touch', 'no-touch'],
      ['', 'invalid'],
    ],
  );

  // Every field OTHER than classification/status round-trips unchanged.
  const stripDecision = (f: FindingRecord): FindingRecord => ({
    ...f,
    classification: '',
    status: 'pending' as FindingStatus,
  });
  out.findings.forEach((after, i) => {
    const before = original.findings[i];
    assert.ok(before);
    assert.deepEqual(stripDecision(after), stripDecision(before), `finding ${i} unrelated fields drifted`);
  });

  // Top-level metadata is preserved.
  assert.equal(out.schema, original.schema);
  assert.equal(out.mode, original.mode);
  assert.equal(out.generated_at, original.generated_at);

  // classify is idempotent and round-trips byte-stable:
  // write -> read -> classify again -> write yields identical bytes.
  const { store, deps } = memFs();
  writeFindings('/f.json', out, deps);
  const bytes1 = store.get('/f.json');
  assert.ok(bytes1 !== undefined);

  const reread = readFindings('/f.json', deps);
  const reclassified = classifyAll(reread, set);
  writeFindings('/f.json', reclassified, deps);
  const bytes2 = store.get('/f.json');
  assert.equal(bytes2, bytes1);
});
