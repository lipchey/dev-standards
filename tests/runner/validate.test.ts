import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../runner/src/validate.ts';
import type {
  Check,
  Manifest,
  ValidationError,
  ValidationResult,
} from '../../runner/src/types.ts';

/**
 * Minimal but complete valid manifest. Budgets and timeouts are sized so each
 * failure case below needs only one small mutation (e.g. the single fast check
 * sits well inside `fast_seconds`, so one bump pushes the tier over budget).
 */
const baseManifest: Manifest = {
  version: 1,
  repo: 'fixture-repo',
  stack: 'node-service',
  scheduler_class: 'local-only',
  budgets: {
    staged_seconds: 10,
    fast_seconds: 60,
    full_seconds: 120,
    audit_seconds: 120,
  },
  policy: {
    mutates_by_default: false,
    format_fix_staged_allowed: false,
    typed_eslint_in_precommit: false,
    block_new_dead_code_only: true,
  },
  paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
  generated: { hooks_dir: '.githooks' },
  workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
  filesets: [{ name: 'repo_ts', source: 'repo_all', include: ['src/**/*.ts'] }],
  tiers: {
    staged: [],
    fast: [{ name: 'typecheck', argv: ['npm', 'run', 'typecheck'], timeout_seconds: 30 }],
    full: [],
  },
  workflow: { enabled: false },
};

/** Deep-fresh valid manifest per call; tests mutate their own copy freely. */
function makeManifest(): Manifest {
  return structuredClone(baseManifest);
}

function firstFastCheck(manifest: Manifest): Check {
  const check = manifest.tiers.fast[0];
  if (check === undefined) {
    throw new Error('fixture manifest must contain one fast-tier check');
  }
  return check;
}

function findError(
  result: ValidationResult,
  match: { path?: string; rule?: string },
): ValidationError | undefined {
  return result.errors.find(
    (error) =>
      (match.path === undefined || error.path === match.path) &&
      (match.rule === undefined || error.rule === match.rule),
  );
}

/** Asserts ok === false plus the presence of a matching error, dumping actual errors on miss. */
function expectError(result: ValidationResult, match: { path?: string; rule?: string }): void {
  assert.equal(result.ok, false, 'expected validation to fail (ok: false), got ok: true');
  const found = findError(result, match);
  assert.ok(
    found,
    `expected an error matching ${JSON.stringify(match)}; received errors:\n` +
      JSON.stringify(result.errors, null, 2),
  );
}

test('valid manifest passes', () => {
  const result = validate(makeManifest());
  assert.equal(
    result.ok,
    true,
    `expected valid manifest to pass; received errors:\n${JSON.stringify(result.errors, null, 2)}`,
  );
  assert.equal(result.errors.length, 0, 'expected zero errors for a valid manifest');
});

test('missing timeout_seconds fails at tiers.fast[0].timeout_seconds', () => {
  const manifest = makeManifest();
  // Invalid by construction: Check requires timeout_seconds, so cast narrowly to delete it.
  delete (firstFastCheck(manifest) as unknown as { timeout_seconds?: number }).timeout_seconds;
  expectError(validate(manifest), { path: 'tiers.fast[0].timeout_seconds', rule: 'required' });
});

test('tier timeout sum over budget fails with rule tier-budget', () => {
  const manifest = makeManifest();
  // Sole fast check: bumping it one past the budget makes the tier sum exceed fast_seconds.
  firstFastCheck(manifest).timeout_seconds = manifest.budgets.fast_seconds + 1;
  expectError(validate(manifest), { rule: 'tier-budget' });
});

test('unknown stack enum fails at stack', () => {
  const manifest = makeManifest();
  // Invalid by construction: not a Stack enum member, so cast narrowly to assign it.
  (manifest as unknown as { stack: string }).stack = 'not-a-stack';
  expectError(validate(manifest), { path: 'stack', rule: 'enum' });
});

test('non-array argv fails at tiers.fast[0].argv', () => {
  const manifest = makeManifest();
  // Invalid by construction: argv must be string[], so cast narrowly to assign a string.
  (firstFastCheck(manifest) as unknown as { argv: string }).argv = 'npm run typecheck';
  expectError(validate(manifest), { path: 'tiers.fast[0].argv', rule: 'type' });
});

test('unknown {files:name} token fails with rule files-token-reference', () => {
  const manifest = makeManifest();
  // Type-valid mutation: the token references a fileset name that does not exist.
  firstFastCheck(manifest).argv = ['eslint', '{files:nope}'];
  expectError(validate(manifest), { rule: 'files-token-reference' });
});

test('workflow.enabled true fails in Phase 1a with rule workflow-enabled', () => {
  const manifest = makeManifest();
  // Invalid by construction: Manifest only allows { enabled: false }, so cast narrowly.
  (manifest as unknown as { workflow: { enabled: boolean } }).workflow = { enabled: true };
  expectError(validate(manifest), { rule: 'workflow-enabled' });
});
