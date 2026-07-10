import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  readFindings,
  mutateFindings,
  assertSafeRepoPath,
  FindingsValidationError,
  FindingsConflictError,
} from '../../deep-review/src/findings-io.ts';
import type { MutateFindingsDeps } from '../../deep-review/src/findings-io.ts';
import { EXIT_FINDINGS_CONFLICT } from '../../deep-review/src/types.ts';
import type { FindingRecord, FindingsFileV2 } from '../../deep-review/src/types.ts';

// A NUL/control char built in code so this source file stays pure ASCII.
const NUL = String.fromCharCode(0);

const REPORTS_ROOT = '/repo/reports';
const FINDINGS_PATH = '/repo/reports/quality/findings.json';
const LOCK_PATH = `${FINDINGS_PATH}.lock`;

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
    mode: 'review-only',
    generated_at: '2026-06-14T00:00:00Z',
    run_id: null,
    base_sha: null,
    revision: 0,
    verification: null,
    findings,
    ...over,
  };
}

// A raw JSON payload so we can inject shapes the typed builders cannot (unknown
// keys, wrong JS types, bad enums, a v1 file).
function rawFile(value: unknown): string {
  return JSON.stringify(value);
}

function assertRule(fn: () => unknown, rule: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(
      err instanceof FindingsValidationError,
      `expected FindingsValidationError, got ${String(err)}`,
    );
    assert.equal(err.rule, rule, `expected rule "${rule}", got "${err.rule}"`);
    return true;
  });
}

// ── Test doubles ─────────────────────────────────────────────────────────────

interface MemMutate {
  store: Map<string, string>;
  locks: Map<string, string>;
  deps: MutateFindingsDeps;
}

// An in-memory MutateFindingsDeps: a store keyed by absolute path, an in-memory
// lock map, an injectable set of "alive" pids, and an optional realpath map (for
// the symlink-escape case). writeConfined resolves relPath under root exactly as
// the real one does, so store keys match the findings path.
function memMutate(
  initial: Record<string, string> = {},
  opts: { alivePids?: number[]; realpathMap?: Record<string, string>; pid?: number } = {},
): MemMutate {
  const store = new Map<string, string>(Object.entries(initial));
  const locks = new Map<string, string>();
  const alive = new Set<number>(opts.alivePids ?? []);
  const deps: MutateFindingsDeps = {
    readFile: (p: string): string => {
      const value = store.get(p);
      if (value === undefined) throw new Error(`ENOENT: ${p}`);
      return value;
    },
    writeConfined: (root, rel, content): string => {
      const target = path.resolve(root, rel);
      store.set(target, content);
      return target;
    },
    realpath: (p: string): string => opts.realpathMap?.[p] ?? p,
    lock: {
      create: (lockPath, content): boolean => {
        if (locks.has(lockPath)) return false;
        locks.set(lockPath, content);
        return true;
      },
      read: (lockPath): string | null => locks.get(lockPath) ?? null,
      remove: (lockPath): void => {
        locks.delete(lockPath);
      },
      isAlive: (pid): boolean => alive.has(pid),
    },
    now: () => '2026-07-10T00:00:00.000Z',
    pid: () => opts.pid ?? 4242,
  };
  return { store, locks, deps };
}

const CTX = { reportsRootAbs: REPORTS_ROOT };

// ── readFindings (schema v2) ─────────────────────────────────────────────────

test('reads a well-formed v2 findings file and round-trips every field', () => {
  const file = validFile(
    [
      validFinding({ id: 'f-001', sha: 'deadbeef', classification: 'fixable-now', status: 'fixed' }),
      validFinding({
        id: 'f-002',
        severity: 'P3',
        file: 'lib/util.ts',
        line: 7,
        slice_files: ['lib/util.ts', 'lib/helper.ts'],
        needs_plan: true,
        test_ref: 'verify:full',
        classification: 'needs-plan',
        status: 'needs-plan',
      }),
    ],
    { run_id: 'run-1', base_sha: 'base-1', revision: 3, verification: null },
  );
  const parsed = readFindings('/f.json', { readFile: () => rawFile(file) });
  assert.deepEqual(parsed, file);
});

test('reads a bound file with a verification record', () => {
  const file = validFile([validFinding({ status: 'fixed', sha: 'abc', classification: 'fixable-now' })], {
    run_id: 'run-1',
    base_sha: 'base-1',
    revision: 4,
    verification: { sha: 'head-sha', scope: 'verify:fast', completed_at: '2026-06-14T00:00:00Z' },
  });
  const parsed = readFindings('/f.json', { readFile: () => rawFile(file) });
  assert.deepEqual(parsed.verification, { sha: 'head-sha', scope: 'verify:fast', completed_at: '2026-06-14T00:00:00Z' });
});

test('rejects a v1 (schema 1) file loudly with a regenerate instruction (rule: schema-version)', () => {
  const v1 = {
    schema: 1,
    mode: 'review-only',
    generated_at: '2026-06-14T00:00:00Z',
    findings: [],
  };
  assert.throws(
    () => readFindings('/f.json', { readFile: () => rawFile(v1) }),
    (err: unknown) => {
      assert.ok(err instanceof FindingsValidationError);
      assert.equal(err.rule, 'schema-version');
      assert.match(err.message, /schema v1 unsupported; regenerate via review\/classify; old file left untouched/);
      return true;
    },
  );
});

test('rejects a finding carrying the removed test_cmd field with an actionable message (rule: removed-field)', () => {
  const withCmd = validFile([{ ...validFinding(), test_cmd: ['npm', 'test'] } as unknown as FindingRecord]);
  assert.throws(
    () => readFindings('/f.json', { readFile: () => rawFile(withCmd) }),
    (err: unknown) => {
      assert.ok(err instanceof FindingsValidationError);
      assert.equal(err.rule, 'removed-field');
      assert.match(err.message, /test_cmd was removed; use test_ref: verify:fast \| verify:full/);
      return true;
    },
  );
});

test('rejects a bad test_ref enum (rule: enum)', () => {
  const bad = validFile([{ ...validFinding(), test_ref: 'verify:medium' } as unknown as FindingRecord]);
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(bad) }), 'enum');
});

test('rejects a duplicate finding id (rule: duplicate-id)', () => {
  const dup = validFile([validFinding({ id: 'dup' }), validFinding({ id: 'dup', file: 'lib/x.ts' })]);
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(dup) }), 'duplicate-id');
});

test('rejects run_id set but base_sha null (must be both null or both set) (rule: type)', () => {
  const half = validFile([validFinding()], { run_id: 'run-1', base_sha: null });
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(half) }), 'type');
});

test('rejects a negative revision (rule: type)', () => {
  const neg = validFile([validFinding()], { revision: -1 });
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(neg) }), 'type');
});

test('rejects an unknown top-level or finding key (rule: additional-property)', () => {
  const badTop = { ...validFile([validFinding()]), bogus_top: 1 };
  const badFinding = validFile([{ ...validFinding(), bogus: 1 } as unknown as FindingRecord]);
  assertRule(() => readFindings('/t.json', { readFile: () => rawFile(badTop) }), 'additional-property');
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(badFinding) }), 'additional-property');
});

test('an unsafe file/slice_files path localizes to status "invalid" (rule path-unsafe not thrown)', () => {
  const unsafe = ['../secret.ts', '-rf.ts', '/etc/passwd', `src/a${NUL}b.ts`, 'a/../b.ts'];
  for (const bad of unsafe) {
    const viaFile = validFile([validFinding({ file: bad, slice_files: ['src/app.ts'] })]);
    assert.equal(
      readFindings('/f.json', { readFile: () => rawFile(viaFile) }).findings[0]?.status,
      'invalid',
      `file=${JSON.stringify(bad)} should localize to invalid`,
    );
    const viaSlice = validFile([validFinding({ file: 'src/app.ts', slice_files: [bad] })]);
    assert.equal(
      readFindings('/s.json', { readFile: () => rawFile(viaSlice) }).findings[0]?.status,
      'invalid',
      `slice_files=${JSON.stringify(bad)} should localize to invalid`,
    );
  }
  // assertSafeRepoPath still surfaces the path-unsafe rule directly (E3 reuses it).
  assertRule(() => assertSafeRepoPath('../escape.ts'), 'path-unsafe');
  assert.doesNotThrow(() => assertSafeRepoPath('src/nested/app.ts'));
});

// ── mutateFindings (lock + confinement + immutability + atomic write) ─────────

test('mutateFindings applies fn under the lock, bumps revision, writes, and releases the lock', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) });
  const out = mutateFindings(
    FINDINGS_PATH,
    CTX,
    (file) => ({ ...file, findings: file.findings.map((f) => ({ ...f, status: 'no-touch', classification: 'no-touch' })) }),
    mem.deps,
  );
  assert.equal(out.revision, 1, 'revision bumped inside the mutator');
  assert.equal(out.findings[0]?.status, 'no-touch');
  // The written bytes round-trip back to the same object.
  const persisted = readFindings(FINDINGS_PATH, { readFile: (p) => mem.store.get(p) ?? '' });
  assert.deepEqual(persisted, out);
  // The lock is released after a successful mutation.
  assert.equal(mem.locks.size, 0, 'lock released');
});

test('mutateFindings binds an unbound draft (null -> value allowed); a later run_id change is rejected (rule: immutable)', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) });
  // null -> value: the bind is allowed.
  const bound = mutateFindings(
    FINDINGS_PATH,
    CTX,
    (file) => ({ ...file, run_id: 'run-1', base_sha: 'base-1' }),
    mem.deps,
  );
  assert.equal(bound.run_id, 'run-1');
  assert.equal(bound.base_sha, 'base-1');
  // value -> different value: rejected as immutable, and the lock is still released.
  assert.throws(
    () =>
      mutateFindings(FINDINGS_PATH, CTX, (file) => ({ ...file, run_id: 'run-2' }), mem.deps),
    (err: unknown) => {
      assert.ok(err instanceof FindingsValidationError);
      assert.equal(err.rule, 'immutable');
      return true;
    },
  );
  assert.equal(mem.locks.size, 0, 'lock released even when the mutator throws');
});

test('mutateFindings re-validates fn output: a duplicate id introduced by fn is rejected (rule: duplicate-id)', () => {
  const mem = memMutate({
    [FINDINGS_PATH]: rawFile(validFile([validFinding({ id: 'a' }), validFinding({ id: 'b', file: 'lib/b.ts' })])),
  });
  assert.throws(
    () =>
      mutateFindings(
        FINDINGS_PATH,
        CTX,
        (file) => ({ ...file, findings: file.findings.map((f) => ({ ...f, id: 'a' })) }),
        mem.deps,
      ),
    (err: unknown) => err instanceof FindingsValidationError && err.rule === 'duplicate-id',
  );
});

test('mutateFindings: a LIVE lock holder yields EXIT_FINDINGS_CONFLICT and does NOT clobber the file or the lock', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) }, { alivePids: [999] });
  // Simulate a concurrent mutator A holding the lock with a live pid.
  mem.locks.set(LOCK_PATH, JSON.stringify({ pid: 999, created_at: 'x' }));
  const before = mem.store.get(FINDINGS_PATH);
  assert.throws(
    () => mutateFindings(FINDINGS_PATH, CTX, (file) => file, mem.deps),
    (err: unknown) => {
      assert.ok(err instanceof FindingsConflictError, `expected FindingsConflictError, got ${String(err)}`);
      assert.equal(err.exitCode, EXIT_FINDINGS_CONFLICT);
      return true;
    },
  );
  assert.equal(mem.store.get(FINDINGS_PATH), before, 'the file must be untouched on a conflict');
  assert.ok(mem.locks.has(LOCK_PATH), "the live holder's lock must survive");
});

test('mutateFindings: a DEAD lock holder is cleared and the mutation retries once and succeeds', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) }, { alivePids: [] });
  // A stale lock from a dead pid 999 (not in the alive set).
  mem.locks.set(LOCK_PATH, JSON.stringify({ pid: 999, created_at: 'x' }));
  const out = mutateFindings(FINDINGS_PATH, CTX, (file) => ({ ...file, revision: file.revision }), mem.deps);
  assert.equal(out.revision, 1, 'the mutation proceeded after clearing the stale lock');
  assert.equal(mem.locks.size, 0, 'the lock is released at the end');
});

test('mutateFindings rejects a findings path that escapes paths.reports via ".." (rule: path-unsafe), before any read', () => {
  const escaping = '/repo/reports/../evil.json';
  const mem = memMutate();
  assertRule(() => mutateFindings(escaping, CTX, (f) => f, mem.deps), 'path-unsafe');
  assert.equal(mem.locks.size, 0, 'no lock is taken on a confinement failure');
});

test('mutateFindings rejects a findings path that is a symlink escaping paths.reports (rule: path-unsafe)', () => {
  // Lexically inside reports, but realpath resolves outside the root.
  const mem = memMutate(
    {},
    {
      realpathMap: {
        [FINDINGS_PATH]: '/outside/findings.json',
        [REPORTS_ROOT]: REPORTS_ROOT,
      },
    },
  );
  assertRule(() => mutateFindings(FINDINGS_PATH, CTX, (f) => f, mem.deps), 'path-unsafe');
});

// ── F1 lock takeover protocol (unparseable = conflict; safe release) ───────────

test('F1: an UNPARSEABLE/incomplete lock body is a CONFLICT (a competitor mid-create), not a stale takeover', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) });
  // Garbage that JSON.parse cannot read (or the empty window between O_EXCL create and body write).
  mem.locks.set(LOCK_PATH, 'not-json-yet');
  const before = mem.store.get(FINDINGS_PATH);
  assert.throws(
    () => mutateFindings(FINDINGS_PATH, CTX, (file) => file, mem.deps),
    (err: unknown) => err instanceof FindingsConflictError && err.exitCode === EXIT_FINDINGS_CONFLICT,
  );
  assert.equal(mem.store.get(FINDINGS_PATH), before, 'the file must be untouched on a conflict');
  assert.ok(mem.locks.has(LOCK_PATH), 'the unparseable lock must survive (never removed on a conflict)');
});

test('F1/G1: a takeover whose post-create re-read shows a FOREIGN nonce -> CONFLICT, the foreign lock is never double-removed', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) });
  const before = mem.store.get(FINDINGS_PATH);
  let lockCreates = 0;
  let reads = 0;
  const removedPaths: string[] = [];
  // Scripted, path-aware lock: initial acquire sees a DEAD holder; we win the takeover GUARD and,
  // under it, re-confirm the (still dead) lock, remove it and create our own; but the final
  // defensive re-read shows a FOREIGN nonce -> CONFLICT, and we must NOT unlink that foreign lock.
  mem.deps.lock = {
    create: (lockPath): boolean => {
      if (lockPath.endsWith('.takeover')) return true; // we win the takeover guard
      lockCreates += 1;
      return lockCreates >= 2; // first lock create (contended) fails; the takeover create "succeeds"
    },
    read: (lockPath): string => {
      if (lockPath.endsWith('.takeover')) return JSON.stringify({ pid: 4242, nonce: 'guard' });
      reads += 1;
      // reads 1 (initial) + 2 (under the guard): the DEAD holder we may take over; read 3 (final
      // defensive re-read after our create): a FOREIGN nonce that must trip the conflict.
      return reads <= 2
        ? JSON.stringify({ pid: 999, created_at: 'x' })
        : JSON.stringify({ pid: 7, nonce: 'FOREIGN', created_at: 'y' });
    },
    remove: (lockPath): void => {
      removedPaths.push(lockPath);
    },
    isAlive: (): boolean => false,
  };
  assert.throws(
    () => mutateFindings(FINDINGS_PATH, CTX, (file) => file, mem.deps),
    (err: unknown) => err instanceof FindingsConflictError && err.exitCode === EXIT_FINDINGS_CONFLICT,
  );
  assert.equal(mem.store.get(FINDINGS_PATH), before, 'no write when the takeover race is lost');
  assert.equal(
    removedPaths.filter((p) => p === LOCK_PATH).length,
    1,
    'the stale lock is removed exactly once; the foreign winner is never unlinked a second time',
  );
});

test('G1: a LATE remover cannot delete the LIVE lock a concurrent takeover installed -> CONFLICT, live lock untouched', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) });
  const before = mem.store.get(FINDINGS_PATH);
  const removedPaths: string[] = [];
  let reads = 0;
  const A_LIVE = JSON.stringify({ pid: 111, nonce: 'A', created_at: 'a' }); // the taker-over's LIVE lock
  const DEAD = JSON.stringify({ pid: 999, created_at: 'x' }); // the original dead holder
  // B is the LATE remover: it observed the DEAD holder, then (delayed) reaches the takeover after A
  // has already completed its takeover and freed the guard. The guard re-read must catch A's LIVE
  // lock and refuse -- B must never remove it (the exact race a plain remove+create loses).
  mem.deps.lock = {
    // The findings lock is always already present (B never wins the initial create); the guard is
    // free (A already unlinked it).
    create: (lockPath): boolean => lockPath.endsWith('.takeover'),
    read: (lockPath): string => {
      if (lockPath.endsWith('.takeover')) return A_LIVE; // unused on the guard-create-success path
      reads += 1;
      // read 1 (initial): the DEAD holder B decides is stale; read 2 (under the guard): A already
      // took over -> a LIVE lock B must leave alone.
      return reads === 1 ? DEAD : A_LIVE;
    },
    remove: (lockPath): void => {
      removedPaths.push(lockPath);
    },
    isAlive: (pid): boolean => pid === 111, // A (111) is alive; the dead holder (999) is not
  };
  assert.throws(
    () => mutateFindings(FINDINGS_PATH, CTX, (file) => file, mem.deps),
    (err: unknown) => err instanceof FindingsConflictError && err.exitCode === EXIT_FINDINGS_CONFLICT,
  );
  assert.equal(mem.store.get(FINDINGS_PATH), before, 'no write when the live lock is left alone');
  assert.ok(!removedPaths.includes(LOCK_PATH), "the taker-over's LIVE lock is NEVER removed by a late remover");
  assert.ok(removedPaths.every((p) => p.endsWith('.takeover')), 'only our own takeover guard is released');
});

test('G1: a takeover GUARD held by a DEAD pid (a crashed takeover) -> CONFLICT with a manual-removal hint, no recursive guard', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) });
  const removedPaths: string[] = [];
  mem.deps.lock = {
    create: (): boolean => false, // both the lock AND the guard already exist
    read: (lockPath): string =>
      lockPath.endsWith('.takeover')
        ? JSON.stringify({ pid: 777, nonce: 'crashed', created_at: 'z' }) // guard held by a dead pid
        : JSON.stringify({ pid: 999, created_at: 'x' }), // the stale lock
    remove: (lockPath): void => {
      removedPaths.push(lockPath);
    },
    isAlive: (): boolean => false, // both the lock holder and the guard holder are dead
  };
  assert.throws(
    () => mutateFindings(FINDINGS_PATH, CTX, (file) => file, mem.deps),
    (err: unknown) => {
      assert.ok(err instanceof FindingsConflictError, `expected FindingsConflictError, got ${String(err)}`);
      assert.match(err.message, /crashed takeover; remove it manually/);
      return true;
    },
  );
  assert.deepEqual(removedPaths, [], 'a crashed guard is never auto-removed (no recursive guards)');
});

test('F1: release NEVER unlinks a FOREIGN lock (a taker-over won the lock after we returned)', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()])) });
  let removed = 0;
  // Acquire succeeds on the first create; but at release time the lock carries a FOREIGN
  // nonce, so release must leave it alone.
  mem.deps.lock = {
    create: (): boolean => true,
    read: (): string => JSON.stringify({ pid: 7, nonce: 'FOREIGN', created_at: 'y' }),
    remove: (): void => {
      removed += 1;
    },
    isAlive: (): boolean => false,
  };
  const out = mutateFindings(FINDINGS_PATH, CTX, (file) => file, mem.deps);
  assert.equal(out.revision, 1, 'the mutation itself succeeded');
  assert.equal(removed, 0, 'release must not unlink a lock whose nonce is not ours');
});

// ── F2 optimistic-revision CAS ─────────────────────────────────────────────────

test('F2: expectedRevision mismatch -> FindingsConflictError (exit 16), no write, lock released', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()], { revision: 5 })) });
  const before = mem.store.get(FINDINGS_PATH);
  assert.throws(
    () => mutateFindings(FINDINGS_PATH, CTX, (file) => file, mem.deps, 4), // read 4, on disk 5
    (err: unknown) => err instanceof FindingsConflictError && err.exitCode === EXIT_FINDINGS_CONFLICT,
  );
  assert.equal(mem.store.get(FINDINGS_PATH), before, 'a stale CAS never clobbers a newer file');
  assert.equal(mem.locks.size, 0, 'the lock is released after the CAS refusal');
});

test('F2: expectedRevision match -> proceeds and bumps the revision', () => {
  const mem = memMutate({ [FINDINGS_PATH]: rawFile(validFile([validFinding()], { revision: 5 })) });
  const out = mutateFindings(FINDINGS_PATH, CTX, (file) => file, mem.deps, 5);
  assert.equal(out.revision, 6, 'a matching CAS proceeds normally');
});

// ── F5 status/field coupling ───────────────────────────────────────────────────

const BOUND = { run_id: 'run-1', base_sha: 'base-1' } as const;

test('F5: status "fixed" with an EMPTY sha -> status-coupling reject', () => {
  const bad = validFile([validFinding({ status: 'fixed', sha: '' })], BOUND);
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(bad) }), 'status-coupling');
});

test('F5: a NON-fixed status carrying a sha -> status-coupling reject', () => {
  const bad = validFile([validFinding({ status: 'pending', sha: 'abc' })], BOUND);
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(bad) }), 'status-coupling');
});

test('F5: infra_error present without an infra-blocked status -> status-coupling reject', () => {
  const bad = validFile([{ ...validFinding({ status: 'fixed', sha: 'abc' }), infra_error: 'x' }], BOUND);
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(bad) }), 'status-coupling');
});

test('F5: an infra-blocked status WITHOUT infra_error -> status-coupling reject', () => {
  const bad = validFile([validFinding({ status: 'infra-blocked', sha: '' })], BOUND);
  assertRule(() => readFindings('/f.json', { readFile: () => rawFile(bad) }), 'status-coupling');
});

test('F5: an UNBOUND file (run_id null) cannot carry fixed / fix-failed / infra-blocked', () => {
  const cases: FindingRecord[] = [
    validFinding({ id: 'a', status: 'fixed', sha: 'deadbeef' }),
    validFinding({ id: 'b', status: 'fix-failed', sha: '' }),
    { ...validFinding({ id: 'c', status: 'infra-blocked', sha: '' }), infra_error: 'spawn ENOENT' },
  ];
  for (const finding of cases) {
    const bad = validFile([finding], { run_id: null, base_sha: null });
    assertRule(() => readFindings('/f.json', { readFile: () => rawFile(bad) }), 'status-coupling');
  }
});

test('F5: legitimate BOUND lifecycle statuses still validate', () => {
  const ok = validFile(
    [
      validFinding({ id: 'a', status: 'fixed', sha: 'deadbeef', classification: 'fixable-now' }),
      validFinding({ id: 'b', status: 'fix-failed', sha: '', classification: 'fixable-now' }),
      { ...validFinding({ id: 'c', status: 'infra-blocked', sha: '' }), infra_error: 'spawn ENOENT' },
      validFinding({ id: 'd', status: 'pending', sha: '' }),
    ],
    BOUND,
  );
  assert.doesNotThrow(() => readFindings('/f.json', { readFile: () => rawFile(ok) }));
});
