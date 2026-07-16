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

const EXPECTED_TEMPLATE_GUIDE_COUNT = 9;
const OVERLAY_BODY = 'OVERLAY CHECKLIST BODY\n';
const CORPUS_NAMES = [
  'profile-architecture-and-boundaries.md',
  'profile-correctness-and-lifecycle.md',
  'profile-module-depth.md',
  'profile-naming-and-constants.md',
  'profile-refactoring-and-smells.md',
  'profile-security.md',
  'profile-tests-quality.md',
  'profile-types-and-contracts.md',
  'review-contract.md',
];

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
    requiredReads: [],
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

const GATED_VERBS = ['select-worktree', 'commit-slice', 'self-review', 'verify', 'handoff'] as const;

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

test('all gated verbs load the nine real package templates without a consumer guides directory', () => {
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
    /* TRACEABILITY.md sorts first but is loader-excluded — a same-named overlay
       would load as overlay-only and break the additive-merge expectation. */
    const templateName = fs
      .readdirSync(REVIEW_GUIDE_TEMPLATES_DIR)
      .filter((fileName) => fileName.endsWith('.md') && fileName !== 'TRACEABILITY.md')
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

test('all gated verbs fail disabled mode before guide loading', () => {
  for (const verb of GATED_VERBS) {
    const outcome = runPreflight(config({ enabled: false }), verb, '/missing-overlay');
    assert.equal(outcome.ok, false, verb);
    if (outcome.ok) continue;
    assert.equal(outcome.exitCode, EXIT_PREFLIGHT, verb);
    assert.match(outcome.machineError.message, /disabled|enabled/, verb);
  }
});

test('all gated verbs fail when review-and-refactor mode is disallowed', () => {
  for (const verb of GATED_VERBS) {
    const outcome = runPreflight(config({ modes: ['review-only'] }), verb, '/missing-overlay');
    assert.equal(outcome.ok, false, verb);
    if (outcome.ok) continue;
    assert.equal(outcome.exitCode, EXIT_PREFLIGHT, verb);
    assert.match(outcome.machineError.message, /review-and-refactor/, verb);
  }
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

test('runPreflight surfaces the loader reason for a listed-but-unreadable overlay', () => {
  /* preflight.ts must FORWARD guideLoad.reason, not fall back to the generic
     "canonical guide templates unavailable" message — otherwise a reviewer
     debugging an unreadable repo overlay is misdirected to the package dir.
     Pins the shared fail-closed point through runPreflight, not loadReviewGuides
     directly (a revert of the reason-forwarding leaves the earlier direct-load
     test green). */
  const overlayReason = 'repo overlay "profile-security.md" is listed but unreadable: EACCES';
  const deps: Partial<PreflightDeps> = {
    loadGuides: () => ({ ok: false, templatesDir: '/templates', reason: overlayReason }),
  };
  const outcome = runPreflight(config(), 'verify', '/overlay', deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
  assert.equal(outcome.machineError.message.includes(overlayReason), true, outcome.machineError.message);
});

test('all gated verbs fail closed when canonical guides are missing', () => {
  for (const verb of GATED_VERBS) {
    const outcome = runPreflight(config(), verb, '/missing-overlay', {
      loadGuides: () => ({ ok: false, templatesDir: '/broken/package/agents/review-guide-templates' }),
    });
    assert.equal(outcome.ok, false, verb);
    if (outcome.ok) continue;
    assert.equal(outcome.exitCode, EXIT_PREFLIGHT, verb);
    assert.match(outcome.machineError.message, /canonical guide templates unavailable/, verb);
  }
});

test('guide load fails when a canonical template is missing or has a blank body', () => {
  const names = CORPUS_NAMES;
  const withoutOne = loadReviewGuides('/no-overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: () => names.slice(1),
    readFile: () => 'body',
  });
  assert.equal(withoutOne.ok, false);

  const withBlankBody = loadReviewGuides('/no-overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: () => [...names],
    readFile: (filePath) => (filePath.endsWith('review-contract.md') ? '  \n' : 'body'),
  });
  assert.equal(withBlankBody.ok, false);

  const complete = loadReviewGuides('/no-overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: () => [...names],
    readFile: () => 'body',
  });
  assert.equal(complete.ok, true);

  /* The registry is excluded BEFORE the blank-body check: a TRACEABILITY.md listed
     in the TEMPLATES dir never becomes a loaded guide and cannot fail the corpus as
     blank. The lister must be directory-aware — the loader reuses it for the overlay
     dir, and an overlay hit here would sneak the name back in as a repo-overlay. */
  const withRegistry = loadReviewGuides('/no-overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: (directory) =>
      directory === '/templates' ? [...names, 'TRACEABILITY.md'] : [],
    readFile: (filePath) => (filePath.endsWith('TRACEABILITY.md') ? '' : 'body'),
  });
  assert.equal(withRegistry.ok, true);
  if (!withRegistry.ok) return;
  assert.equal(
    withRegistry.guides.some((guide) => guide.name === 'TRACEABILITY.md'),
    false,
  );
});

test('a consumer overlay named TRACEABILITY.md is reserved and never merges', () => {
  withRoot((root) => {
    const overlayDirectory = path.join(root, '.claude', 'review-guides');
    fs.mkdirSync(overlayDirectory, { recursive: true });
    fs.writeFileSync(path.join(overlayDirectory, 'TRACEABILITY.md'), OVERLAY_BODY);
    fs.writeFileSync(path.join(overlayDirectory, 'repo-extra.md'), OVERLAY_BODY);

    const outcome = runPreflight(config(), 'verify', overlayDirectory);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.machineError.message);
    if (!outcome.ok) return;
    assert.equal(
      outcome.guides.some((guide) => guide.name === 'TRACEABILITY.md'),
      false,
      'the reserved registry name must never become a worker-facing guide',
    );
    assert.equal(outcome.guides.length, EXPECTED_TEMPLATE_GUIDE_COUNT + 1);
  });
});

test('an overlay enumeration error other than ENOENT fails the guide load closed', () => {
  const enotdir = loadReviewGuides('/overlay-is-a-file', {
    templatesDir: '/templates',
    listMarkdownFiles: (directory) => {
      if (directory === '/templates') return [...CORPUS_NAMES];
      const error = new Error('ENOTDIR: not a directory') as NodeJS.ErrnoException;
      error.code = 'ENOTDIR';
      throw error;
    },
    readFile: () => 'body',
  });
  assert.equal(enotdir.ok, false);

  const enoent = loadReviewGuides('/no-overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: (directory) => {
      if (directory === '/templates') return [...CORPUS_NAMES];
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
    readFile: () => 'body',
  });
  assert.equal(enoent.ok, true);
});

test('a LISTED overlay whose read fails makes the guide load fail closed (shared preflight+gate point)', () => {
  /* After the anchor rescope a non-anchor overlay is no longer a main-required read, so
     the only thing keeping an unreadable one from silently vanishing is this load failing
     closed — and preflight (which loads the same way) inherits it. */
  const outcome = loadReviewGuides('/overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: (directory) => (directory === '/templates' ? [...CORPUS_NAMES] : ['profile-security.md']),
    readFile: (filePath) => {
      if (filePath.startsWith('/overlay')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return 'body';
    },
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason ?? '', /listed but unreadable/);
});
