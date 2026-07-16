import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject } from 'ajv/dist/2020.js';
import { validate } from '../../runner/src/validate.ts';
import { expandArgv } from '../../runner/src/exec.ts';
import { expandFileset } from '../../runner/src/filesets.ts';
import type { Manifest, ValidationResult } from '../../runner/src/types.ts';

const schemaPath = fileURLToPath(new URL('../../schemas/quality.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as AnySchemaObject;
const ajv = new Ajv2020({ allErrors: true });
const validateFn = ajv.compile(schema);

// Minimal valid manifest with a fileset + a format block; mutated per case.
function baseManifest(): Manifest {
  return {
    version: 1,
    repo: 'fixture-repo',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 10, fast_seconds: 60, full_seconds: 120, audit_seconds: 120 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: true,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [{ name: 'staged_fmt', source: 'git_staged', include: ['src/**/*.ts'] }],
    tiers: { staged: [], fast: [], full: [] },
    format: { argv: ['prettier', '--write'], fileset: 'staged_fmt', timeout_seconds: 30 },
  };
}

// Both the hand validator and Ajv must agree AND reach the expected verdict (schema-validator parity).
function assertParity(m: Manifest, expectValid: boolean): ValidationResult {
  const hand = validate(m);
  const schemaOk = validateFn(m) === true;
  const dump = `hand:\n${JSON.stringify(hand.errors, null, 2)}\najv:\n${JSON.stringify(validateFn.errors, null, 2)}`;
  assert.equal(hand.ok, schemaOk, `hand (${hand.ok}) and schema (${schemaOk}) disagree.\n${dump}`);
  assert.equal(hand.ok, expectValid, `expected ${expectValid ? 'valid' : 'invalid'}.\n${dump}`);
  return hand;
}

function hasError(result: ValidationResult, path: string, rule: string): boolean {
  return result.errors.some((e) => e.path === path && e.rule === rule);
}

// ── BUG-06: an empty include/exclude pattern must be rejected by BOTH validators. An "" pattern
// matches no real repo file, so a blocking check with skip_if_empty would silently go `skipped`. ──

test('BUG-06: include with an empty-string item is rejected by both validators (min-length)', () => {
  const m = baseManifest();
  m.filesets[0]!.include = [''];
  const hand = assertParity(m, false);
  assert.ok(hasError(hand, 'filesets[0].include[0]', 'min-length'), 'hand min-length at the empty item');
});

test('BUG-06: an empty item mixed with a valid one is still rejected', () => {
  const m = baseManifest();
  m.filesets[0]!.include = ['src/**/*.ts', ''];
  const hand = assertParity(m, false);
  assert.ok(hasError(hand, 'filesets[0].include[1]', 'min-length'));
});

test('BUG-06: an empty exclude item is rejected too', () => {
  const m = baseManifest();
  m.filesets[0]!.exclude = [''];
  assertParity(m, false);
});

test('BUG-06 runtime tie: an empty include pattern matches no real file (the silent-skip mechanism)', () => {
  const matched = expandFileset(
    { name: 'x', source: 'repo_all', include: [''] },
    { cwd: '/', trackedFiles: () => ['src/a.ts', 'README.md'] },
  );
  assert.deepEqual(matched, [], 'empty pattern selects nothing — why a blocking check would skip');
});

// ── BUG-08: a fileset name must match the {files:<name>} token grammar (^[A-Za-z0-9_-]+$), else it
// validates yet cannot be referenced. Restricted in schema AND validator. ──

test('BUG-08: a dotted fileset name is rejected by both validators (pattern)', () => {
  const m = baseManifest();
  m.filesets[0]!.name = 'src.ts';
  m.format!.fileset = 'src.ts';
  const hand = assertParity(m, false);
  assert.ok(hasError(hand, 'filesets[0].name', 'pattern'), 'hand pattern error on the dotted name');
});

test('BUG-08: a fileset name with a space is rejected by both validators', () => {
  const m = baseManifest();
  m.filesets[0]!.name = 'src ts';
  m.format!.fileset = 'src ts';
  assertParity(m, false);
});

test('BUG-08: valid token-grammar names still pass both validators', () => {
  for (const name of ['src_ts', 'repo-ts', 'A1']) {
    const m = baseManifest();
    m.filesets[0]!.name = name;
    m.format!.fileset = name;
    assertParity(m, true);
  }
});

test('BUG-08 runtime tie: the dotted name validation matches expandArgv (unreferenceable ↔ rejected)', () => {
  // A dotted name cannot be referenced: expandArgv leaves the token literal (why it is rejected).
  assert.deepEqual(
    expandArgv(['tool', '{files:src.ts}'], new Map([['src.ts', ['a.ts']]])),
    ['tool', '{files:src.ts}'],
    'a dotted token is NOT expanded — it passes through as a literal',
  );
  // A token-grammar name expands to its file list.
  assert.deepEqual(
    expandArgv(['tool', '{files:src-ts}'], new Map([['src-ts', ['a.ts']]])),
    ['tool', 'a.ts'],
  );
});

// ── BUG-07: a {files:<fileset>} token anywhere in format.argv is forbidden by the hand validator
// (the runner appends the safe staged list itself). Ajv does NOT express this, so it is hand-only. ──

test('BUG-07: a placeholder is rejected in every format.argv position (hand validator)', () => {
  const positions: Array<{ label: string; argv: string[]; index: number }> = [
    { label: 'argv[0]', argv: ['{files:staged_fmt}'], index: 0 },
    { label: 'middle', argv: ['prettier', '{files:staged_fmt}'], index: 1 },
    { label: 'last', argv: ['prettier', '--write', '{files:staged_fmt}'], index: 2 },
  ];
  for (const { label, argv, index } of positions) {
    const m = baseManifest();
    m.format!.argv = argv;
    const hand = validate(m);
    assert.equal(hand.ok, false, `${label}: expected the hand validator to reject`);
    assert.ok(
      hasError(hand, `format.argv[${index}]`, 'format-argv-token'),
      `${label}: expected a format-argv-token error at index ${index}; got:\n${JSON.stringify(hand.errors, null, 2)}`,
    );
  }
});

test('BUG-07: a normal formatter argv (no token) still validates', () => {
  const m = baseManifest();
  m.format!.argv = ['prettier', '--write', '--log-level=warn'];
  assert.equal(validate(m).ok, true);
});
