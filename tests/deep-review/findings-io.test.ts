import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFindings,
  writeFindings,
  assertSafeRepoPath,
  FindingsValidationError,
} from '../../deep-review/src/findings-io.ts';
import type { FindingRecord, FindingsFile } from '../../deep-review/src/types.ts';

// A NUL/control char built in code so this source file stays pure ASCII.
const NUL = String.fromCharCode(0);

// ── Test doubles ─────────────────────────────────────────────────────────────

// In-memory fs seam so the validator/serializer never touch real disk.
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
    mode: 'review-only',
    generated_at: '2026-06-14T00:00:00Z',
    findings,
  };
}

// A raw JSON payload placed on the in-memory fs so we can inject shapes the typed
// builders cannot (unknown keys, wrong JS types, bad enums).
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

// ── Tests ────────────────────────────────────────────────────────────────────

test('reads a well-formed findings file and round-trips unrelated fields byte-stable', () => {
  const original = validFile([
    validFinding({ id: 'f-001', sha: 'deadbeef', classification: 'fixable-now', status: 'fixed' }),
    validFinding({
      id: 'f-002',
      severity: 'P3',
      file: 'lib/util.ts',
      line: 7,
      slice_files: ['lib/util.ts', 'lib/helper.ts'],
      needs_plan: true,
      classification: 'needs-plan',
      status: 'needs-plan',
    }),
  ]);

  const { store, deps } = memFs();
  writeFindings('/findings.json', original, deps);
  const bytesA = store.get('/findings.json');
  assert.ok(bytesA !== undefined);

  const roundTripped = readFindings('/findings.json', deps);
  assert.deepEqual(roundTripped, original);

  writeFindings('/findings.json', roundTripped, deps);
  const bytesB = store.get('/findings.json');
  assert.equal(bytesB, bytesA);
});

test('rejects an unknown top-level or finding key (rule: additional-property)', () => {
  const { deps } = memFs({
    '/top.json': rawFile({ ...validFile([validFinding()]), bogus_top: 1 }),
    '/finding.json': rawFile(
      validFile([{ ...validFinding(), bogus_finding: 1 } as unknown as FindingRecord]),
    ),
  });
  assertRule(() => readFindings('/top.json', deps), 'additional-property');
  assertRule(() => readFindings('/finding.json', deps), 'additional-property');
});

test('rejects a bad severity / mode enum (rule: enum)', () => {
  const { deps } = memFs({
    '/sev.json': rawFile(
      validFile([{ ...validFinding(), severity: 'P4' } as unknown as FindingRecord]),
    ),
    '/mode.json': rawFile({ ...validFile([validFinding()]), mode: 'bogus-mode' }),
  });
  assertRule(() => readFindings('/sev.json', deps), 'enum');
  assertRule(() => readFindings('/mode.json', deps), 'enum');
});

test('rejects a finding whose file OR slice_files entry has a ".." segment / leading "-" / absolute path / control char -> status "invalid" (rule: path-unsafe)', () => {
  const unsafe = ['../secret.ts', '-rf.ts', '/etc/passwd', 'C:\\Windows\\system32', `src/a${NUL}b.ts`, 'a/../b.ts'];

  // assertSafeRepoPath surfaces the rule directly (the primitive E3 reuses).
  for (const candidate of unsafe) {
    assertRule(() => assertSafeRepoPath(candidate), 'path-unsafe');
  }
  // A safe path must pass the primitive.
  assert.doesNotThrow(() => assertSafeRepoPath('src/nested/app.ts'));

  // During readFindings the violation is localized to the finding: status "invalid".
  for (const bad of unsafe) {
    const viaFile = memFs({
      '/f.json': rawFile(validFile([validFinding({ file: bad, slice_files: ['src/app.ts'] })])),
    });
    const fromFile = readFindings('/f.json', viaFile.deps);
    assert.equal(
      fromFile.findings[0]?.status,
      'invalid',
      `file=${JSON.stringify(bad)} should mark status invalid`,
    );

    const viaSlice = memFs({
      '/s.json': rawFile(validFile([validFinding({ file: 'src/app.ts', slice_files: [bad] })])),
    });
    const fromSlice = readFindings('/s.json', viaSlice.deps);
    assert.equal(
      fromSlice.findings[0]?.status,
      'invalid',
      `slice_files=${JSON.stringify(bad)} should mark status invalid`,
    );
  }
});

test('rejects git pathspec-magic + glob metachars as path-unsafe (empty / "." / "./" / "a/./b" / "foo//bar" / leading ":" / glob "* ? [ ]") and still accepts a normal path', () => {
  // Glob metacharacters are built by codepoint so this source stays free of glob
  // bytes (mirrors the engine's codepoint scans).
  const STAR = String.fromCharCode(0x2a); // *
  const QUESTION = String.fromCharCode(0x3f); // ?
  const LBRACKET = String.fromCharCode(0x5b); // [
  const RBRACKET = String.fromCharCode(0x5d); // ]
  const unsafe = [
    '',
    '.',
    './',
    'a/./b',
    'foo//bar',
    ':/',
    ':(exclude)x',
    `src/${STAR}.ts`,
    `glob${QUESTION}.ts`,
    `a${LBRACKET}b${RBRACKET}.ts`,
  ];
  for (const candidate of unsafe) {
    assertRule(() => assertSafeRepoPath(candidate), 'path-unsafe');
  }
  // A normal repo-relative path must NOT be over-rejected.
  assert.doesNotThrow(() => assertSafeRepoPath('runner/src/glob.ts'));
  assert.doesNotThrow(() => assertSafeRepoPath('src/nested/app.ts'));

  // In a findings file the violation is localized to the finding: status "invalid".
  const localized = [':(exclude)x', `src/${STAR}.ts`, '.', './'];
  for (const bad of localized) {
    const viaFile = memFs({
      '/f.json': rawFile(validFile([validFinding({ file: bad, slice_files: ['src/app.ts'] })])),
    });
    assert.equal(
      readFindings('/f.json', viaFile.deps).findings[0]?.status,
      'invalid',
      `file=${JSON.stringify(bad)} should mark status invalid`,
    );
    const viaSlice = memFs({
      '/s.json': rawFile(validFile([validFinding({ file: 'src/app.ts', slice_files: [bad] })])),
    });
    assert.equal(
      readFindings('/s.json', viaSlice.deps).findings[0]?.status,
      'invalid',
      `slice_files=${JSON.stringify(bad)} should mark status invalid`,
    );
  }
});

test('rejects a non-integer line or a missing required field (rule: type / required)', () => {
  const { deps } = memFs({
    '/line.json': rawFile(validFile([{ ...validFinding(), line: 1.5 } as unknown as FindingRecord])),
    '/missing.json': rawFile(
      validFile([
        (() => {
          const f = validFinding() as unknown as Record<string, unknown>;
          delete f['impact'];
          return f as unknown as FindingRecord;
        })(),
      ]),
    ),
  });
  assertRule(() => readFindings('/line.json', deps), 'type');
  assertRule(() => readFindings('/missing.json', deps), 'required');
});

test('rejects an empty or non-string-array test_cmd, or a test_cmd entry with a control/NUL char (rule: type / non-empty)', () => {
  const { deps } = memFs({
    '/empty.json': rawFile(validFile([{ ...validFinding(), test_cmd: [] } as unknown as FindingRecord])),
    '/notarray.json': rawFile(
      validFile([{ ...validFinding(), test_cmd: 'npm test' } as unknown as FindingRecord]),
    ),
    '/emptystr.json': rawFile(
      validFile([{ ...validFinding(), test_cmd: ['npm', ''] } as unknown as FindingRecord]),
    ),
    '/control.json': rawFile(
      validFile([{ ...validFinding(), test_cmd: ['npm', `te${NUL}st`] } as unknown as FindingRecord]),
    ),
  });
  assertRule(() => readFindings('/empty.json', deps), 'non-empty');
  assertRule(() => readFindings('/notarray.json', deps), 'type');
  assertRule(() => readFindings('/emptystr.json', deps), 'non-empty');
  assertRule(() => readFindings('/control.json', deps), 'type');
});

test('slice_files defaults to [file] when omitted; a non-string-array slice_files is rejected (rule: type)', () => {
  const omitted = (() => {
    const f = validFinding({ file: 'src/only.ts' }) as unknown as Record<string, unknown>;
    delete f['slice_files'];
    return f as unknown as FindingRecord;
  })();
  const { deps } = memFs({
    '/omitted.json': rawFile(validFile([omitted])),
    '/notarray.json': rawFile(
      validFile([{ ...validFinding(), slice_files: 'src/app.ts' } as unknown as FindingRecord]),
    ),
  });
  const parsed = readFindings('/omitted.json', deps);
  assert.deepEqual(parsed.findings[0]?.slice_files, ['src/only.ts']);
  assertRule(() => readFindings('/notarray.json', deps), 'type');
});

test('writeFindings then readFindings is idempotent (same bytes)', () => {
  const file = validFile([validFinding({ id: 'a-1' }), validFinding({ id: 'b-2', severity: 'P2' })]);
  const { store, deps } = memFs();

  writeFindings('/a.json', file, deps);
  const bytes1 = store.get('/a.json');
  const reread = readFindings('/a.json', deps);
  writeFindings('/b.json', reread, deps);
  const bytes2 = store.get('/b.json');

  assert.equal(bytes2, bytes1);
});
