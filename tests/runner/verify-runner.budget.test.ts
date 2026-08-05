// Budget enforcement needs an invalid-by-validator manifest; valid timeout sums fit budget.
import './helpers/telemetry-off.ts'; // MUST be first: default the sink off for direct (non-npm) runs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTier } from '../../runner/src/verify-runner.ts';
import type { Manifest } from '../../runner/src/types.ts';

function stub(name: string): string {
  return fileURLToPath(new URL(`../stubs/${name}`, import.meta.url));
}

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

function noopCheck() {
  return { name: 'noop', argv: [process.execPath, stub('ok.mjs')], timeout_seconds: 1 };
}

// A check that would run far longer than the tier budget; the per-tier deadline caps its
// spawn timeout, so it is SIGKILLed at the deadline and the tier then fails closed.
function slowCheck() {
  return { name: 'slow', argv: [process.execPath, stub('sleep.mjs'), '5'], timeout_seconds: 30 };
}

test('runTier fails closed when the tier wall-clock budget is exceeded', () => {
  // Other tiers stay generous, so the throw must come from fast_seconds. A tiny positive
  // budget makes the slow check spawn, get deadline-capped, and overrun deterministically.
  // Use a temp root: the exhaustion path best-effort writes a partial report.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-budget-'));
  try {
    const m = manifest({
      budgets: { staged_seconds: 300, fast_seconds: 0.05, full_seconds: 300, audit_seconds: 300 },
      tiers: { staged: [], fast: [slowCheck()], full: [], audit: [] },
    });
    assert.throws(() => runTier(m, root, 'fast'), /budget exceeded/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FIX #7: a report-write failure in the deadline catch does not mask the original error', () => {
  // A non-existent root makes emitReport (writeReport → realpathSync) throw; the injected
  // clock forces the pre-return budget assertion to throw first. The ORIGINAL budget error
  // must survive the best-effort report write, not be replaced by its ENOENT.
  const missingRoot = path.join(os.tmpdir(), `ds-nope-${process.pid}-${Date.now()}`);
  const budgetMs = 300 * 1000;
  let n = 0;
  const clock = (): number => (n++ === 0 ? 0 : budgetMs + 1); // startedAt=0, then past deadline
  const m = manifest({ filesets: [], tiers: { staged: [], fast: [], full: [], audit: [] } });
  assert.throws(
    () => runTier(m, missingRoot, 'fast', clock),
    (err: unknown) =>
      err instanceof Error && /budget exceeded/i.test(err.message) && !/realpath|ENOENT/i.test(err.message),
    'the original budget error must survive a report-write failure',
  );
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

test('a report-only check timeout is an operational failure and returns non-zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-budget-'));
  try {
    const m = manifest({
      budgets: { staged_seconds: 300, fast_seconds: 3, full_seconds: 300, audit_seconds: 300 },
      tiers: {
        staged: [],
        fast: [
          {
            name: 'report-only-slow',
            argv: [process.execPath, stub('sleep.mjs'), '5'],
            timeout_seconds: 1,
            mode: 'report-only',
          },
        ],
        full: [],
        audit: [],
      },
    });
    assert.equal(runTier(m, root, 'fast'), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an invoked empty audit tier fails instead of reporting a false-green audit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-budget-'));
  try {
    assert.throws(() => runTier(manifest(), root, 'audit'), /audit tier is not configured|no checks/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a tier does not expand filesets that none of its checks reference', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-budget-'));
  try {
    const m = manifest({
      filesets: [
        {
          name: 'unused-staged',
          source: 'git_staged',
          include: ['**/*.ts'],
          exclude: [],
        },
      ],
      tiers: { staged: [], fast: [noopCheck()], full: [], audit: [] },
    });
    // `root` is deliberately not a Git repository. Expanding the unused git_staged fileset
    // would fail; a selected tier should touch only the filesets its checks consume.
    assert.equal(runTier(m, root, 'fast'), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
