/* Preflight must use the real package templates while treating repo guides as optional overlays. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
      const outcome = runPreflight(config(), verb, root);
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

    const outcome = runPreflight(config(), 'verify', root);
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

    const outcome = runPreflight(config(), 'commit-slice', root);
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

test('guides_dir spellings that escape the repo fail the shared confinement guard', () => {
  /* Lexical escapes are caught before realpath(cwd), so a fake cwd is fine — the point is
     the SAME message the Stop-gate produces (assertGuidesDirConfined), not the old
     preflight-only "repo-relative" wording. */
  for (const directory of ['/abs/guides', '..', '../outside', 'a/../../outside']) {
    const outcome = runPreflight(config({ guidesDir: directory }), 'handoff', '/resolved');
    assert.equal(outcome.ok, false, directory);
    if (outcome.ok) return;
    assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
    assert.match(outcome.machineError.message, /resolves outside the repo root/);
  }
});

test('in-root guides_dir spellings pass the confinement guard', () => {
  withRoot((root) => {
    for (const directory of ['custom/../guides', './guides', 'a/..']) {
      const outcome = runPreflight(config({ guidesDir: directory }), 'handoff', root);
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
     blank. (The overlay dir has its own separate loader, loadOverlaySources, which
     excludes the same name; the template listMarkdownFiles seam here is templates-only.) */
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

    const outcome = runPreflight(config(), 'verify', root);
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

test('a non-ENOENT overlay load error fails the guide load closed; an absent overlay passes', () => {
  const base = {
    templatesDir: '/templates',
    listMarkdownFiles: (directory: string) => (directory === '/templates' ? [...CORPUS_NAMES] : []),
    readFile: () => 'body',
  };
  const enotdir = loadReviewGuides('/overlay-is-a-file', {
    ...base,
    loadOverlaySources: () => {
      throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
    },
  });
  assert.equal(enotdir.ok, false);

  const absent = loadReviewGuides('/no-overlay', { ...base, loadOverlaySources: () => undefined });
  assert.equal(absent.ok, true);
});

test('an overlay whose load throws makes the guide load fail closed (shared preflight+gate point)', () => {
  /* After the anchor rescope a non-anchor overlay is no longer a main-required read, so
     the only thing keeping an unreadable one from silently vanishing is this load failing
     closed — and preflight (which loads the same way) inherits it. */
  const outcome = loadReviewGuides('/overlay', {
    templatesDir: '/templates',
    listMarkdownFiles: (directory) => (directory === '/templates' ? [...CORPUS_NAMES] : []),
    readFile: () => 'body',
    loadOverlaySources: () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason ?? '', /unavailable: EACCES/);
});

test('an overlay .md stored as a symlink is rejected fail-closed, never silently dropped', () => {
  /* Pre-hardening the `entry.isFile()` filter dropped a symlinked leaf silently, so the rule
     vanished from the corpus AND the read gate. A leaf symlink is now rejected regardless of
     its target (even in-repo) — the no-follow open refuses to follow it. */
  withRoot((root) => {
    const overlayDirectory = path.join(root, '.claude', 'review-guides');
    fs.mkdirSync(overlayDirectory, { recursive: true });
    const target = path.join(root, 'real-guide.md');
    fs.writeFileSync(target, OVERLAY_BODY);
    fs.symlinkSync(target, path.join(overlayDirectory, 'linked.md'));
    assert.equal(loadReviewGuides(overlayDirectory).ok, false);
  });
});

test('an overlay entry named *.md that is a symlink to a directory is rejected', () => {
  withRoot((root) => {
    const overlayDirectory = path.join(root, '.claude', 'review-guides');
    fs.mkdirSync(overlayDirectory, { recursive: true });
    const dirTarget = path.join(root, 'a-dir');
    fs.mkdirSync(dirTarget);
    fs.symlinkSync(dirTarget, path.join(overlayDirectory, 'linkdir.md'));
    assert.equal(loadReviewGuides(overlayDirectory).ok, false);
  });
});

test('an overlay entry named *.md that is a real directory is rejected (non-regular)', () => {
  withRoot((root) => {
    const overlayDirectory = path.join(root, '.claude', 'review-guides');
    fs.mkdirSync(path.join(overlayDirectory, 'notaguide.md'), { recursive: true });
    assert.equal(loadReviewGuides(overlayDirectory).ok, false);
  });
});

test('a *.md FIFO overlay entry fails closed WITHOUT hanging (O_NONBLOCK anti-hang)', (t) => {
  /* Without O_NONBLOCK, openSync(O_RDONLY) on a writer-less FIFO blocks forever — this test
     would time out (RED) rather than fail-close. With it, fstat rejects the non-regular entry. */
  if (process.platform === 'win32') return t.skip('mkfifo is POSIX-only');
  withRoot((root) => {
    const overlayDirectory = path.join(root, '.claude', 'review-guides');
    fs.mkdirSync(overlayDirectory, { recursive: true });
    try {
      execFileSync('mkfifo', [path.join(overlayDirectory, 'pipe.md')]);
    } catch {
      t.skip('mkfifo unavailable');
      return;
    }
    assert.equal(loadReviewGuides(overlayDirectory).ok, false);
  });
});

test('a guides_dir that IS a symlink (even to an in-repo dir) is rejected fail-closed', () => {
  /* An in-repo symlinked guides_dir would make the anchor overlay unprovable: requiredReadSet
     records the lexical tail while computeMissing realpaths the reviewer's Read to the target,
     so the Stop-gate could never be satisfied. The confinement refuses any symlink component. */
  withRoot((root) => {
    const realGuides = path.join(root, 'actual-guides');
    fs.mkdirSync(realGuides, { recursive: true });
    fs.writeFileSync(path.join(realGuides, 'repo-specific.md'), OVERLAY_BODY);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.symlinkSync(realGuides, path.join(root, '.claude', 'review-guides'));
    const outcome = runPreflight(config(), 'verify', root);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.exitCode, EXIT_PREFLIGHT);
    assert.match(outcome.machineError.message, /must be a real directory, not a symlink/);
  });
});

test('a DANGLING guides_dir leaf symlink fails closed (not read as an absent overlay)', () => {
  withRoot((root) => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, '.claude', 'review-guides'));
    const outcome = runPreflight(config(), 'verify', root);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.machineError.message, /must be a real directory, not a symlink/);
  });
});

test('a DANGLING ANCESTOR symlink in the guides_dir path fails closed (was silently absent)', () => {
  /* .claude → missing, guides_dir=.claude/review-guides. The whole path ENOENTs, so the
     pre-hardening loader read it as an absent optional overlay (a fail-open); the component
     walk catches the symlinked ancestor before it can vanish. */
  withRoot((root) => {
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, '.claude'));
    const outcome = runPreflight(config(), 'verify', root);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.machineError.message, /must be a real directory, not a symlink/);
  });
});

test('a reserved TRACEABILITY.md overlay symlink is skipped as reserved, never a fail-closed error', () => {
  /* Reserved-name exclusion runs BEFORE the type check, so a broken/symlinked TRACEABILITY is
     ignored (not merged, not a hard failure); a normal overlay beside it still loads. */
  withRoot((root) => {
    const overlayDirectory = path.join(root, '.claude', 'review-guides');
    fs.mkdirSync(overlayDirectory, { recursive: true });
    fs.writeFileSync(path.join(overlayDirectory, 'repo-extra.md'), OVERLAY_BODY);
    fs.symlinkSync(path.join(root, 'whatever'), path.join(overlayDirectory, 'TRACEABILITY.md'));
    const outcome = runPreflight(config(), 'verify', root);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.machineError.message);
    if (!outcome.ok) return;
    assert.equal(outcome.guides.some((guide) => guide.name === 'TRACEABILITY.md'), false);
    assert.equal(outcome.guides.some((guide) => guide.name === 'repo-extra.md'), true);
  });
});
