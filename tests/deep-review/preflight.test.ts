/* Preflight must use the real package templates while treating repo guides as optional overlays. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPreflight } from '../../deep-review/src/preflight.ts';
import { loadReviewGuides } from '../../deep-review/src/guides.ts';
import type { PreflightDeps } from '../../deep-review/src/preflight.ts';
import type { DeepReviewConfig } from '../../deep-review/src/config.ts';
import { REVIEW_GUIDE_TEMPLATES_DIR } from '../../deep-review/src/guides.ts';
import { EXIT_PREFLIGHT } from '../../deep-review/src/types.ts';

const EXPECTED_TEMPLATE_GUIDE_COUNT = 7;
const OVERLAY_BODY = 'OVERLAY CHECKLIST BODY\n';

function config(overrides: Partial<DeepReviewConfig> = {}): DeepReviewConfig {
  return {
    enabled: true,
    modes: ['review-only', 'review-and-refactor'],
    budget: { seconds: 900 },
    guidesDir: '.claude/review-guides',
    noTouchGlobsRef: undefined,
    verifyAfterFix: undefined,
    verifyEntry: 'verify',
    reportsDir: 'reports/quality',
    ...overrides,
  };
}

function withRoot(callback: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-guides-'));
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const GATED_VERBS = ['select-worktree', 'commit-slice', 'verify', 'handoff'] as const;

test('non-gated verbs pass without loading guides', () => {
  const throwingDeps: Partial<PreflightDeps> = {
    loadGuides: () => {
      throw new Error('must not load');
    },
  };
  for (const verb of ['classify', 'report', 'check-path']) {
    const outcome = runPreflight(config({ enabled: false }), verb, '/missing-overlay', throwingDeps);
    assert.equal(outcome.ok, true, `${verb} must not be gated`);
  }
});

test('all gated verbs load the seven real package templates without a consumer guides directory', () => {
  withRoot((root) => {
    const missingOverlay = path.join(root, '.claude', 'review-guides');
    assert.equal(fs.existsSync(missingOverlay), false);
    for (const verb of GATED_VERBS) {
      const outcome = runPreflight(config(), verb, missingOverlay);
      assert.equal(outcome.ok, true, outcome.ok ? verb : outcome.machineError.message);
      if (!outcome.ok) continue;
      assert.equal(outcome.guides.length, EXPECTED_TEMPLATE_GUIDE_COUNT);
      assert.equal(
        outcome.guides.every(
          (guide) =>
            guide.sources.length === 1 &&
            guide.sources[0]?.kind === 'package-template' &&
            guide.sources[0].body.length > 0,
        ),
        true,
      );
    }
  });
});

test('a same-named overlay body is loaded additively alongside its package template', () => {
  withRoot((root) => {
    const overlayDirectory = path.join(root, '.claude', 'review-guides');
    fs.mkdirSync(overlayDirectory, { recursive: true });
    const templateName = fs
      .readdirSync(REVIEW_GUIDE_TEMPLATES_DIR)
      .filter((fileName) => fileName.endsWith('.md'))
      .sort()[0];
    assert.notEqual(templateName, undefined);
    if (templateName === undefined) return;
    fs.writeFileSync(path.join(overlayDirectory, templateName), OVERLAY_BODY);

    const outcome = runPreflight(config(), 'verify', overlayDirectory);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.machineError.message);
    if (!outcome.ok) return;
    const mergedGuide = outcome.guides.find((guide) => guide.name === templateName);
    assert.notEqual(mergedGuide, undefined);
    if (mergedGuide === undefined) return;
    const templateBody = fs.readFileSync(path.join(REVIEW_GUIDE_TEMPLATES_DIR, templateName), 'utf8');
    assert.deepEqual(
      mergedGuide.sources.map((source) => source.kind),
      ['package-template', 'repo-overlay'],
    );
    assert.equal(mergedGuide.sources[0]?.body, templateBody);
    assert.equal(mergedGuide.sources[1]?.body, OVERLAY_BODY);
    assert.equal(mergedGuide.body.includes(templateBody), true);
    assert.equal(mergedGuide.body.includes(OVERLAY_BODY), true);
  });
});

test('an overlay-only markdown file is included without replacing package guides', () => {
  withRoot((root) => {
    const overlayDirectory = path.join(root, '.claude', 'review-guides');
    fs.mkdirSync(overlayDirectory, { recursive: true });
    fs.writeFileSync(path.join(overlayDirectory, 'repo-specific.md'), OVERLAY_BODY);

    const outcome = runPreflight(config(), 'commit-slice', overlayDirectory);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.machineError.message);
    if (!outcome.ok) return;
    assert.equal(outcome.guides.length, EXPECTED_TEMPLATE_GUIDE_COUNT + 1);
    assert.deepEqual(outcome.guides.find((guide) => guide.name === 'repo-specific.md')?.sources, [
      {
        kind: 'repo-overlay',
        path: path.join(overlayDirectory, 'repo-specific.md'),
        body: OVERLAY_BODY,
      },
    ]);
  });
});

test('disabled fix mode fails before guide loading', () => {
  const outcome = runPreflight(config({ enabled: false }), 'commit-slice', '/missing-overlay');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  assert.match(outcome.machineError.message, /disabled|enabled/);
});

test('missing review-and-refactor mode fails preflight', () => {
  const outcome = runPreflight(config({ modes: ['review-only'] }), 'verify', '/missing-overlay');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  assert.match(outcome.machineError.message, /review-and-refactor/);
});

test('overlay paths that escape the repo fail the lexical guard', () => {
  for (const directory of ['/abs/guides', '..', '../outside', 'a/../../outside']) {
    const outcome = runPreflight(config({ guidesDir: directory }), 'handoff', '/resolved/guides');
    assert.equal(outcome.ok, false, directory);
    if (outcome.ok) return;
    assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
    assert.match(outcome.machineError.message, /repo-relative/);
  }
});

test('in-root overlay path spellings pass the lexical guard', () => {
  withRoot((root) => {
    for (const directory of ['custom/../guides', './guides', 'a/..']) {
      const outcome = runPreflight(config({ guidesDir: directory }), 'handoff', path.join(root, 'guides'));
      assert.equal(outcome.ok, true, outcome.ok ? directory : `${directory}: ${outcome.machineError.message}`);
    }
  });
});

test('an unavailable package template directory fails closed', () => {
  const outcome = runPreflight(config(), 'verify', '/missing-overlay', {
    loadGuides: () => ({ ok: false, templatesDir: '/broken/package/agents/review-guide-templates' }),
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  assert.match(outcome.machineError.message, /canonical guide templates unavailable/);
});

test('guide load fails when a canonical template is missing or has a blank body', () => {
  const names = [
    'architecture-deepening.md',
    'clean-architecture.md',
    'core-code-guidelines.md',
    'language-review-sources.md',
    'refactoring-checklist.md',
    'review-output-format.md',
    'security-review.md',
  ];
  const withoutOne = loadReviewGuides('/no-overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: () => names.slice(1),
    readFile: () => 'body',
  });
  assert.equal(withoutOne.ok, false);

  const withBlankBody = loadReviewGuides('/no-overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: () => [...names],
    readFile: (filePath) => (filePath.endsWith('core-code-guidelines.md') ? '  \n' : 'body'),
  });
  assert.equal(withBlankBody.ok, false);

  const complete = loadReviewGuides('/no-overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: () => [...names],
    readFile: () => 'body',
  });
  assert.equal(complete.ok, true);
});
