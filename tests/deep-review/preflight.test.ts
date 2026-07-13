// §5.0 preflight — the fix-mode availability gate for select-worktree / commit-slice / verify /
// handoff. Requires enabled === true, "review-and-refactor" in modes, and the guides dir holding
// EVERY canonical guide (the `*.md` names in agents/review-guide-templates/) — an availability check
// BY NAME, NOT "guides loaded" (the runtime never reads a guide). A fail returns EXIT_PREFLIGHT via a
// §2.4 MachineError. classify/report/check-path are NOT gated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPreflight } from '../../deep-review/src/preflight.ts';
import type { PreflightDeps } from '../../deep-review/src/preflight.ts';
import type { DeepReviewConfig } from '../../deep-review/src/config.ts';
import { EXIT_PREFLIGHT } from '../../deep-review/src/types.ts';

function cfg(over: Partial<DeepReviewConfig> = {}): DeepReviewConfig {
  return {
    enabled: true,
    modes: ['review-only', 'review-and-refactor'],
    budget: { seconds: 900 },
    guidesDir: '.agents/review-guides',
    noTouchGlobsRef: undefined,
    verifyAfterFix: undefined,
    verifyEntry: 'verify',
    reportsDir: 'reports/quality',
    ...over,
  };
}

// A fake canonical set + a guides_dir seam. Names are arbitrary (not the real guide names): the
// tests exercise the NAME-comparison logic, not the real set, so they stay decoupled from what
// agents/review-guide-templates/ actually holds. By default listDir returns the FULL canonical set
// (so preflight passes on the "ok" path).
const CANON = ['alpha.md', 'beta.md', 'gamma.md'] as const;

function guidesDeps(over: Partial<PreflightDeps> = {}): Partial<PreflightDeps> {
  return {
    listCanonicalGuides: () => [...CANON],
    listDir: () => [...CANON],
    ...over,
  };
}

const GATED = ['select-worktree', 'commit-slice', 'verify', 'handoff'] as const;

test('non-gated verbs (classify/report/check-path) pass through even with fix-mode disabled', () => {
  for (const verb of ['classify', 'report', 'check-path']) {
    const outcome = runPreflight(cfg({ enabled: false }), verb, '/guides', guidesDeps());
    assert.equal(outcome.ok, true, `${verb} must not be gated`);
  }
});

test('ok: enabled + review-and-refactor + the FULL canonical guide set -> pass, for every gated verb', () => {
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

test('guidesDir escaping the repo root (raw manifest value) -> EXIT_PREFLIGHT, same contract as the seeder', () => {
  for (const dir of ['/abs/guides', '..', '../outside', 'a/../../outside']) {
    const outcome = runPreflight(cfg({ guidesDir: dir }), 'handoff', '/resolved/guides', guidesDeps());
    assert.equal(outcome.ok, false, dir);
    if (outcome.ok) return;
    assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
    assert.match(outcome.machineError.message, /repo-relative/);
  }
});

test('in-root guidesDir spellings (dotted segment, ./ prefix, a/..) are NOT rejected by the lexical guard', () => {
  for (const dir of ['custom/../guides', './guides', 'a/..']) {
    const outcome = runPreflight(cfg({ guidesDir: dir }), 'handoff', '/resolved/guides', guidesDeps());
    assert.equal(outcome.ok, true, outcome.ok ? dir : `${dir}: ${outcome.machineError.message}`);
  }
});

test('guides dir holds only a SUBSET (1/N) -> EXIT_PREFLIGHT naming the missing guides + the seeder hint', () => {
  const outcome = runPreflight(
    cfg(),
    'select-worktree',
    '/abs/guides',
    guidesDeps({ listDir: () => ['alpha.md'] }),
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  // The two absent canonical names are reported (sorted), and the message points at the seeder.
  assert.match(outcome.machineError.message, /beta\.md/);
  assert.match(outcome.machineError.message, /gamma\.md/);
  assert.doesNotMatch(outcome.machineError.message, /alpha\.md/);
  assert.match(outcome.machineError.message, /seed-review-guides\.sh/);
});

test('guides dir empty/absent (listDir -> []) -> EXIT_PREFLIGHT', () => {
  const outcome = runPreflight(cfg(), 'commit-slice', '/abs/guides', guidesDeps({ listDir: () => [] }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  assert.match(outcome.machineError.message, /guides/);
});

test('templates dir unavailable (no canonical set) -> EXIT_PREFLIGHT (fail-closed on a broken checkout)', () => {
  const outcome = runPreflight(
    cfg(),
    'verify',
    '/abs/guides',
    guidesDeps({ listCanonicalGuides: () => [] }),
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  assert.match(outcome.machineError.message, /canonical guide templates unavailable/);
});

test('check order: disabled is reported before the (also-failing) guides check', () => {
  // enabled:false AND no guides — the FIRST failure (disabled) is the reported one.
  const outcome = runPreflight(cfg({ enabled: false }), 'verify', '/abs/guides', guidesDeps({ listDir: () => [] }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.machineError.message, /disabled|enabled/);
});

// Default deps (no seam override) resolve the REAL templates dir via import.meta.url. Pointing
// guidesDirAbs at that same dir means present ⊇ canonical, so it passes — proving the src+dist
// depth-2 resolution is correct without mocking. `../../` from tests/deep-review/ also lands at the
// repo root, so the templates dir is the same one preflight resolves.
const REAL_TEMPLATES_DIR = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));

test('default deps resolve the real templates dir: guidesDir = the templates dir itself passes', () => {
  assert.equal(readdirSync(REAL_TEMPLATES_DIR).some((n) => n.endsWith('.md')), true, 'fixture precondition: real templates exist');
  const outcome = runPreflight(cfg(), 'verify', REAL_TEMPLATES_DIR);
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.machineError.message);
});
