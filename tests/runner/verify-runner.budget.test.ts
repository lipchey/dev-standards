// Unit test for the runtime tier-budget wiring in runTier. Unlike the black-box
// verify-runner.test.ts (which spawns the built bundle), this imports runTier
// directly: a *valid* manifest can never exceed its budget at runtime (the
// `tier-budget` rule guarantees sum(timeout_seconds) <= budget), so enforcement
// can only be exercised by handing runTier a manifest the validator would have
// rejected. Importing the module is safe because its CLI entrypoint is guarded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTier } from '../../runner/src/verify-runner.ts';
import type { Manifest } from '../../runner/src/types.ts';

/** Absolute path to a stub under tests/stubs/, resolved off this test file. */
function stub(name: string): string {
  return fileURLToPath(new URL(`../stubs/${name}`, import.meta.url));
}

/** A minimal, otherwise-valid manifest; budgets and tiers vary per test. */
function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    repo: 'tmp',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 300, fast_seconds: 300, full_seconds: 300, audit_seconds: 300 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: false,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [],
    tiers: { staged: [], fast: [], full: [], audit: [] },
    ...overrides,
  };
}

/** One trivial, silent, passing check (the `ok.mjs` stub exits 0 with no output). */
function noopCheck() {
  return { name: 'noop', argv: [process.execPath, stub('ok.mjs')], timeout_seconds: 1 };
}

test('runTier fails closed when the tier wall-clock budget is exceeded', () => {
  // fast_seconds: 0 — any real time spent running the check exceeds it. The
  // other tiers keep a generous budget, so a throw also pins that the run
  // consults the fast_seconds key specifically, not some other tier's budget.
  const m = manifest({
    budgets: { staged_seconds: 300, fast_seconds: 0, full_seconds: 300, audit_seconds: 300 },
    tiers: { staged: [], fast: [noopCheck()], full: [], audit: [] },
  });
  assert.throws(() => runTier(m, process.cwd(), 'fast'), /budget exceeded/i);
});

test('runTier completes and returns 0 when comfortably within budget', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-budget-'));
  try {
    const m = manifest({ tiers: { staged: [], fast: [noopCheck()], full: [], audit: [] } });
    assert.equal(runTier(m, root, 'fast'), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
