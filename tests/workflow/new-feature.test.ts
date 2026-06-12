import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { featureStart, newFeature } from '../../workflow/src/new-feature.ts';
import type { NewFeatureDeps } from '../../workflow/src/new-feature.ts';
import { readFeatureRecords } from '../../workflow/src/feature-record.ts';
import { parseSubset } from '../../workflow/src/front-matter.ts';
import { runGit } from '../../workflow/src/trailers.ts';
import type { WorkflowConfig } from '../../workflow/src/types.ts';

function config(root: string, guides: string[] = ['docs/review.md']): WorkflowConfig {
  return {
    schema: 1,
    enabled: true,
    base_branch: 'main',
    worktree_parent: path.join(root, 'worktrees'),
    cmux_mode: 'manual',
    loopback_mode: 'manual',
    reviewer_independence: 'different-runtime',
    required_review_guides: guides,
    commit_exclude: ['reports/**', '*.log', '.DS_Store'],
    archive: true,
    timeouts: { default_wait_seconds: 1800, default_work_seconds: 1800 },
    budget: { workflow_total_seconds: 5400 },
    agents: { claude: ['claude'], codex: ['codex'] },
    ship: { ci_wait_seconds: 1800, notify: true },
    notify: { webhook_env: 'WORKFLOW_NOTIFY_WEBHOOK' },
  };
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-new-feature-'));
  runGit(['init', '-q', '-b', 'main'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Workflow Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  runGit(['add', '--', 'README.md'], dir);
  runGit(['commit', '-q', '-m', 'seed'], dir);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/review.md'), '# Review\n');
  fs.mkdirSync(path.join(dir, '.agents', 'handoffs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'handoffs', 'STATE.md'), '---\n---\n\n# Handoff State\n');
  return dir;
}

function deps(root: string, overrides: Partial<NewFeatureDeps> = {}): NewFeatureDeps {
  return {
    repoRoot: root,
    statePath: path.join(root, '.agents', 'handoffs', 'STATE.md'),
    config: config(root),
    runGit,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    ...overrides,
  };
}

function stateFrontMatter(root: string): string {
  const text = fs.readFileSync(path.join(root, '.agents', 'handoffs', 'STATE.md'), 'utf8');
  const close = text.split('\n').findIndex((line, index) => index > 0 && line === '---');
  return `${text.split('\n').slice(0, close + 1).join('\n')}\n`;
}

function installFailingPreCommitHook(root: string): void {
  const hooksDir = path.join(root, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by fixture pre-commit hook" 1>&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
}

test('feature-start-record-only-no-planning-file', () => {
  const root = initRepo();
  try {
    const result = featureStart({ slug: 'small-fix' }, deps(root));
    assert.equal(result.branch, 'feature/small-fix');
    assert.equal(result.worktree, '');
    assert.equal(fs.existsSync(path.join(root, 'workflow-session-planning.md')), false);
    assert.deepEqual(readFeatureRecords(parseSubset(stateFrontMatter(root))), [
      { slug: 'small-fix', branch: 'feature/small-fix', worktree: '', pr: 0, review_state: 'building' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('feature-start-optional-worktree', () => {
  const root = initRepo();
  try {
    const result = featureStart({ slug: 'worktree-fix', worktree: true }, deps(root));
    assert.equal(result.branch, 'feature/worktree-fix');
    assert.ok(result.worktree.endsWith(path.join('worktrees', 'worktree-fix')));
    assert.ok(fs.existsSync(result.worktree), 'the feature worktree exists');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('new-feature-creates-worktree-branch-planning-file-record', () => {
  const root = initRepo();
  try {
    const result = newFeature('big-feature', deps(root));
    assert.ok(result.planningFile !== undefined && fs.existsSync(result.planningFile));
    assert.match(fs.readFileSync(result.planningFile, 'utf8'), /state: "created"/);
    assert.deepEqual(readFeatureRecords(parseSubset(stateFrontMatter(root))), [
      {
        slug: 'big-feature',
        branch: 'feature/big-feature',
        worktree: path.join(root, 'worktrees', 'big-feature'),
        pr: 0,
        review_state: 'building',
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('new-feature-rolls-back-worktree-branch-and-record-when-planning-commit-fails', () => {
  const root = initRepo();
  try {
    installFailingPreCommitHook(root);
    const worktree = path.join(root, 'worktrees', 'hook-fail');

    assert.throws(() => newFeature('hook-fail', deps(root)), /rejected by fixture pre-commit hook/);

    assert.equal(fs.existsSync(worktree), false, 'the created worktree is removed');
    assert.throws(
      () => runGit(['rev-parse', '--verify', 'feature/hook-fail'], root),
      /rev-parse/,
      'the created branch is removed',
    );
    assert.deepEqual(readFeatureRecords(parseSubset(stateFrontMatter(root))), [], 'no orphan feature record remains');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collision-aborts-before-git-side-effects', () => {
  const root = initRepo();
  try {
    fs.writeFileSync(
      path.join(root, '.agents', 'handoffs', 'STATE.md'),
      '---\nfeatures:\n  - slug: "taken"\n    branch: "feature/taken"\n    worktree: ""\n    pr: 0\n    review_state: "building"\n---\n\n# Handoff State\n',
    );
    const calls: string[][] = [];
    assert.throws(
      () => featureStart({ slug: 'taken' }, deps(root, {
        runGit: (args, cwd) => {
          calls.push(args);
          return runGit(args, cwd);
        },
      })),
      /feature record already exists/,
    );
    assert.deepEqual(calls, [], 'record collision is detected before git argv side effects');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('guide-missing-blocks-before-git-side-effects', () => {
  const root = initRepo();
  try {
    const calls: string[][] = [];
    assert.throws(
      () => featureStart({ slug: 'needs-guide' }, deps(root, {
        config: config(root, ['docs/missing.md']),
        runGit: (args, cwd) => {
          calls.push(args);
          return runGit(args, cwd);
        },
      })),
      /missing required review guide/,
    );
    assert.deepEqual(calls, [], 'guide refusal happens before git argv side effects');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hostile-slug-never-reaches-git-argv', () => {
  const root = initRepo();
  try {
    const calls: string[][] = [];
    assert.throws(
      () => featureStart({ slug: '../../etc' }, deps(root, {
        runGit: (args, cwd) => {
          calls.push(args);
          return runGit(args, cwd);
        },
      })),
      /invalid feature slug/,
    );
    assert.deepEqual(calls, [], 'rejected hostile values stay data only');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
