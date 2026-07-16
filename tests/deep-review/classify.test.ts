import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { classifyFinding, classifyAll, classifyAndBind } from '../../deep-review/src/classify.ts';
import { readFindings } from '../../deep-review/src/findings-io.ts';
import type { MutateFindingsDeps } from '../../deep-review/src/findings-io.ts';
import type { FindingRecord, FindingsFileV2 } from '../../deep-review/src/types.ts';

const REPORTS_ROOT = '/repo/reports';
const FINDINGS_PATH = '/repo/reports/quality/findings.json';

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
    classification: '',
    status: 'pending',
    sha: '',
    ...over,
  };
}

function validFile(findings: FindingRecord[], over: Partial<FindingsFileV2> = {}): FindingsFileV2 {
  return {
    schema: 2,
    mode: 'review-and-refactor',
    generated_at: '2026-06-14T00:00:00Z',
    run_id: null,
    base_sha: null,
    revision: 0,
    verification: null,
    self_review: null,
    findings,
    ...over,
  };
}

// A minimal in-memory MutateFindingsDeps (see findings-io.test.ts). No lock
// contention and no symlinks — classifyAndBind exercises the classify + bind fn.
function memMutate(initial: Record<string, string>): {
  store: Map<string, string>;
  deps: MutateFindingsDeps;
} {
  const store = new Map<string, string>(Object.entries(initial));
  const locks = new Map<string, string>();
  const deps: MutateFindingsDeps = {
    readFile: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeConfined: (root, rel, content) => {
      const target = path.resolve(root, rel);
      store.set(target, content);
      return target;
    },
    realpath: (p) => p,
    lock: {
      create: (lp, c) => (locks.has(lp) ? false : (locks.set(lp, c), true)),
      read: (lp) => locks.get(lp) ?? null,
      remove: (lp) => {
        locks.delete(lp);
      },
      isAlive: () => false,
    },
    now: () => '2026-07-10T00:00:00.000Z',
    pid: () => 4242,
  };
  return { store, deps };
}

const noneNoTouch = (): boolean => false;
const allNoTouch = (): boolean => true;

// ── classifyFinding (pure) ───────────────────────────────────────────────────

test('no-touch file -> {no-touch, no-touch}, even with needs_plan false', () => {
  const result = classifyFinding(validFinding({ file: 'auth/secret.ts' }), (p) => p === 'auth/secret.ts');
  assert.deepEqual(result, { classification: 'no-touch', status: 'no-touch' });
});

test('needs_plan true + editable -> {needs-plan, needs-plan}', () => {
  const result = classifyFinding(validFinding({ needs_plan: true }), noneNoTouch);
  assert.deepEqual(result, { classification: 'needs-plan', status: 'needs-plan' });
});

test('editable + needs_plan false -> {fixable-now, pending}', () => {
  const result = classifyFinding(validFinding({ needs_plan: false }), noneNoTouch);
  assert.deepEqual(result, { classification: 'fixable-now', status: 'pending' });
});

test('no-touch WINS over needs_plan', () => {
  const result = classifyFinding(validFinding({ needs_plan: true }), allNoTouch);
  assert.deepEqual(result, { classification: 'no-touch', status: 'no-touch' });
});

test('defense-in-depth: a no-touch slice_files entry routes an editable file to no-touch', () => {
  const finding = validFinding({ file: 'src/app.ts', slice_files: ['src/app.ts', 'tools/danger.sh'] });
  const result = classifyFinding(finding, (p) => p === 'tools/danger.sh');
  assert.deepEqual(result, { classification: 'no-touch', status: 'no-touch' });
});

// ── classifyAll (protected statuses + infra-blocked reset) ───────────────────

test('classifyAll NEVER re-derives a PROTECTED status (fixed / fix-failed / invalid)', () => {
  const file = validFile([
    validFinding({ id: 'a', status: 'fixed', classification: 'fixable-now', sha: 'sha-a' }),
    validFinding({ id: 'b', status: 'fix-failed', classification: 'fixable-now' }),
    validFinding({ id: 'c', status: 'invalid', classification: '' }),
    validFinding({ id: 'd', status: 'pending', needs_plan: true }),
  ]);
  const out = classifyAll(file, ['auth/**']);
  assert.deepEqual(
    out.findings.map((f) => [f.id, f.classification, f.status]),
    [
      ['a', 'fixable-now', 'fixed'],
      ['b', 'fixable-now', 'fix-failed'],
      ['c', '', 'invalid'],
      // only the pending finding is re-derived (needs_plan true -> needs-plan)
      ['d', 'needs-plan', 'needs-plan'],
    ],
  );
});

test('classifyAll resets infra-blocked to pending and drops its infra_error', () => {
  const file = validFile([
    validFinding({ id: 'x', status: 'infra-blocked', classification: 'fixable-now', infra_error: 'spawn ENOENT' }),
  ]);
  const out = classifyAll(file, []);
  const finding = out.findings[0];
  assert.ok(finding);
  assert.equal(finding.status, 'pending');
  assert.equal(finding.classification, 'fixable-now');
  assert.equal(finding.infra_error, undefined, 'stale infra_error is cleared on reset');
});

test('classifyAll is idempotent for non-protected findings', () => {
  const file = validFile([
    validFinding({ id: 'p', file: 'src/app.ts', needs_plan: false }),
    validFinding({ id: 'q', file: 'auth/keys.ts' }),
  ]);
  const once = classifyAll(file, ['auth/**']);
  const twice = classifyAll(once, ['auth/**']);
  assert.deepEqual(twice, once);
});

// ── classifyAndBind (classify + unbound->bound in one CAS write) ─────────────

test('classifyAndBind binds run_id + base_sha from the descriptor in one write when the draft is unbound', () => {
  const mem = memMutate({ [FINDINGS_PATH]: JSON.stringify(validFile([validFinding()])) });
  const out = classifyAndBind(
    FINDINGS_PATH,
    { reportsRootAbs: REPORTS_ROOT, descriptor: { run_id: 'run-9', base_sha: 'base-9' } },
    [],
    mem.deps,
  );
  assert.equal(out.run_id, 'run-9');
  assert.equal(out.base_sha, 'base-9');
  assert.equal(out.revision, 1, 'classify + bind is a single CAS write');
  assert.equal(out.findings[0]?.status, 'pending');
  // Persisted bytes agree.
  const persisted = readFindings(FINDINGS_PATH, { readFile: (p) => mem.store.get(p) ?? '' });
  assert.deepEqual(persisted, out);
});

test('classifyAndBind leaves a review-only run (no descriptor) unbound', () => {
  const mem = memMutate({ [FINDINGS_PATH]: JSON.stringify(validFile([validFinding()], { mode: 'review-only' })) });
  const out = classifyAndBind(FINDINGS_PATH, { reportsRootAbs: REPORTS_ROOT, descriptor: null }, [], mem.deps);
  assert.equal(out.run_id, null);
  assert.equal(out.base_sha, null);
  assert.equal(out.revision, 1);
});

test('classifyAndBind does not re-bind an already-bound file (run_id stays), classify still applies', () => {
  const bound = validFile([validFinding({ needs_plan: true })], { run_id: 'run-1', base_sha: 'base-1', revision: 5 });
  const mem = memMutate({ [FINDINGS_PATH]: JSON.stringify(bound) });
  const out = classifyAndBind(
    FINDINGS_PATH,
    { reportsRootAbs: REPORTS_ROOT, descriptor: { run_id: 'run-1', base_sha: 'base-1' } },
    [],
    mem.deps,
  );
  assert.equal(out.run_id, 'run-1');
  assert.equal(out.revision, 6);
  assert.equal(out.findings[0]?.status, 'needs-plan');
});
