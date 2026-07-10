// §5.0 preflight — the fix-mode availability gate for select-worktree / commit-slice / verify /
// handoff. Requires enabled === true, "review-and-refactor" in modes, and the guides dir present
// with >=1 .md (an availability check, NOT "guides loaded" — the runtime never reads a guide).
// A fail returns EXIT_PREFLIGHT via a §2.4 MachineError. classify/report/check-path are NOT gated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../../deep-review/src/preflight.ts';
import type { PreflightDeps } from '../../deep-review/src/preflight.ts';
import type { DeepReviewConfig } from '../../deep-review/src/config.ts';
// EXIT_PREFLIGHT is added by W1 to types.ts (§0 taxonomy, value 14); imported here so the exit-code
// assertion binds to the shared constant once W1 lands. The message/ok assertions below are the
// primary coverage and hold regardless.
import { EXIT_PREFLIGHT } from '../../deep-review/src/types.ts';

function cfg(over: Partial<DeepReviewConfig> = {}): DeepReviewConfig {
  return {
    enabled: true,
    modes: ['review-only', 'review-and-refactor'],
    budget: { seconds: 900 },
    guidesDir: '.agents/review-guides',
    noTouchGlobsRef: undefined,
    verifyAfterFix: undefined,
    reportsDir: 'reports/quality',
    ...over,
  };
}

// Guides-dir seam: present with a .md by default (so preflight passes on the "ok" path).
function guidesDeps(over: Partial<PreflightDeps> = {}): Partial<PreflightDeps> {
  return { exists: () => true, listDir: () => ['core-code-guidelines.md'], ...over };
}

const GATED = ['select-worktree', 'commit-slice', 'verify', 'handoff'] as const;

test('non-gated verbs (classify/report/check-path) pass through even with fix-mode disabled', () => {
  for (const verb of ['classify', 'report', 'check-path']) {
    const outcome = runPreflight(cfg({ enabled: false }), verb, '/guides', guidesDeps());
    assert.equal(outcome.ok, true, `${verb} must not be gated`);
  }
});

test('ok: enabled + review-and-refactor + a non-empty guides dir -> pass, for every gated verb', () => {
  for (const verb of GATED) {
    const outcome = runPreflight(cfg(), verb, '/abs/guides', guidesDeps());
    assert.equal(outcome.ok, true, `${verb} should pass a fully-configured preflight`);
  }
});

test('disabled: enabled !== true -> EXIT_PREFLIGHT, message names deep_review.enabled', () => {
  const outcome = runPreflight(cfg({ enabled: false }), 'commit-slice', '/abs/guides', guidesDeps());
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  assert.match(outcome.machineError.message, /disabled|enabled/);
  assert.equal(outcome.machineError.command, 'deep-review commit-slice');
});

test('mode not allowed: review-and-refactor missing from modes -> EXIT_PREFLIGHT', () => {
  const outcome = runPreflight(cfg({ modes: ['review-only'] }), 'verify', '/abs/guides', guidesDeps());
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  assert.match(outcome.machineError.message, /review-and-refactor/);
});

test('guides unconfigured: guidesDirAbs undefined -> EXIT_PREFLIGHT', () => {
  const outcome = runPreflight(cfg({ guidesDir: undefined }), 'handoff', undefined, guidesDeps());
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.machineError.message, /guides/);
});

test('guides dir missing on disk -> EXIT_PREFLIGHT', () => {
  const outcome = runPreflight(cfg(), 'select-worktree', '/abs/guides', guidesDeps({ exists: () => false }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.machineError.message, /guides/);
});

test('guides dir present but holds no .md -> EXIT_PREFLIGHT (availability check, not just presence)', () => {
  const outcome = runPreflight(
    cfg(),
    'commit-slice',
    '/abs/guides',
    guidesDeps({ listDir: () => ['README.txt', 'notes'] }),
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.machineError.message, /guides/);
});

test('check order: disabled is reported before the (also-failing) guides check', () => {
  // enabled:false AND no guides — the FIRST failure (disabled) is the reported one.
  const outcome = runPreflight(cfg({ enabled: false }), 'verify', undefined, guidesDeps({ exists: () => false }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.machineError.message, /disabled|enabled/);
});
