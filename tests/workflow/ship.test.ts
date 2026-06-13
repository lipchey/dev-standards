import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ship } from '../../workflow/src/ship.ts';
import type { ShipDeps } from '../../workflow/src/ship.ts';
import { serializeFrontMatter } from '../../workflow/src/front-matter.ts';
import type { FeatureRecord, FrontMatter, WorkflowConfig } from '../../workflow/src/types.ts';
import { GitError } from '../../workflow/src/trailers.ts';
import { GhError } from '../../workflow/src/gh.ts';

function config(root: string): WorkflowConfig {
  return {
    schema: 1,
    enabled: true,
    base_branch: 'main',
    worktree_parent: path.join(root, 'worktrees'),
    cmux_mode: 'manual',
    loopback_mode: 'manual',
    reviewer_independence: 'different-runtime',
    required_review_guides: [],
    commit_exclude: ['reports/**'],
    archive: true,
    timeouts: { default_wait_seconds: 1800, default_work_seconds: 1800 },
    budget: { workflow_total_seconds: 5400 },
    agents: { claude: ['claude'], codex: ['codex'] },
    ship: { ci_wait_seconds: 1800, notify: true },
    notify: { webhook_env: 'WORKFLOW_NOTIFY_WEBHOOK' },
  };
}

function frontMatter(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'dark-mode',
    branch: 'feature/dark-mode',
    worktree: '/repo',
    base: 'main',
    base_sha: 'abc123',
    cmux_section: 'dark-mode',
    state: 'implementation-reviewed',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: '',
    updated: '2026-06-12T10:00:00Z',
    phases: {},
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

function stateDoc(records: FeatureRecord[]): string {
  const lines = ['---', 'features:'];
  for (const record of records) {
    lines.push(
      `  - slug: "${record.slug}"`,
      `    branch: "${record.branch}"`,
      `    worktree: "${record.worktree}"`,
      `    pr: ${record.pr}`,
      `    review_state: "${record.review_state}"`,
    );
  }
  lines.push('---', '', '# Handoff State', '');
  return lines.join('\n');
}

function fixture(overrides: {
  planning?: FrontMatter | null;
  records?: FeatureRecord[];
  dirty?: string;
  currentBranch?: string;
  existingPr?: { number: number; url: string; state?: string } | null;
  checks?: Array<{ name?: string; state?: string; bucket?: string; conclusion?: string }>;
  notifyOk?: boolean;
  scanHit?: string | null;
  failGh?: boolean;
  failTransitionCommit?: boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-ship-'));
  const planningFile = path.join(root, 'workflow-session-planning.md');
  const statePath = path.join(root, '.agents', 'handoffs', 'STATE.md');
  const files = new Map<string, string>();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const planning = overrides.planning === undefined ? frontMatter({ worktree: root }) : overrides.planning;
  if (planning !== null) files.set(planningFile, `${serializeFrontMatter(planning)}\n# Plan\n`);
  files.set(statePath, stateDoc(overrides.records ?? [{
    slug: 'dark-mode',
    branch: 'feature/dark-mode',
    worktree: root,
    pr: 0,
    review_state: 'building',
  }]));
  const gitCalls: string[][] = [];
  const ghCalls: string[] = [];
  const notifications: Array<{ event: string; pr: number; message: string }> = [];
  const writtenBodies: string[] = [];
  const deps: ShipDeps = {
    repoRoot: root,
    statePath,
    config: config(root),
    readFile: (file) => files.get(file) ?? fs.readFileSync(file, 'utf8'),
    writeFile: (file, text) => {
      files.set(file, text);
      if (file.includes('pr-body')) writtenBodies.push(text);
    },
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    now: () => '2026-06-12T12:00:00Z',
    runGit: (args) => {
      gitCalls.push(args);
      if (args[0] === 'status') return overrides.dirty ?? '';
      if (args[0] === 'branch' && args[1] === '--show-current') return `${overrides.currentBranch ?? 'feature/dark-mode'}\n`;
      if (args[0] === 'commit' && overrides.failTransitionCommit === true && !args.includes('--no-verify')) {
        throw new GitError(`git ${args.join(' ')}`, 'hook rejected', 'git commit failed (status 1): hook rejected');
      }
      return '';
    },
    gh: {
      findPrByHead: () => {
        ghCalls.push('find');
        if (overrides.failGh === true) throw new GhError('gh pr list', 'no auth', 'gh pr list failed (status 1): no auth', 'pr-list');
        return overrides.existingPr ?? null;
      },
      createPr: () => {
        ghCalls.push('create');
        return { url: 'https://github.example/owner/repo/pull/42' };
      },
      viewPr: () => ({ number: 42, url: 'https://github.example/owner/repo/pull/42' }),
      editPrBody: () => {
        ghCalls.push('edit');
      },
      watchChecks: () => overrides.checks ?? [{ name: 'verify', conclusion: 'success' }],
      deleteLocalBranchArgs: (branch) => ['branch', '-D', '--', branch],
      repoInfo: () => ({ owner: 'owner', name: 'repo' }),
      prReviewData: () => ({ reviews: [], threads: [], mergeable: null, truncated: { threads: false, comments: false } }),
    },
    notify: (payload) => {
      notifications.push({ event: payload.event, pr: payload.pr, message: payload.message });
      return { ok: overrides.notifyOk ?? true };
    },
    scanPrBody: (body) => overrides.scanHit ?? (body.includes('SECRET') ? 'secret hit' : null),
  };
  if (planning !== null) deps.planningFile = planningFile;
  return { root, planningFile, statePath, files, deps, gitCalls, ghCalls, notifications, writtenBodies };
}

test('asserts-state-or-session-mode', () => {
  const wrong = fixture({ planning: frontMatter({ state: 'implemented' }) });
  try {
    const result = ship({}, wrong.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /implementation-reviewed|shipped/);
    assert.deepEqual(wrong.gitCalls.filter((args) => args[0] === 'push'), []);
  } finally {
    fs.rmSync(wrong.root, { recursive: true, force: true });
  }

  const session = fixture({ planning: null });
  try {
    const result = ship({}, session.deps);
    assert.equal(result.exitCode, 0);
    assert.ok(session.gitCalls.some((args) => args[0] === 'push'), 'session mode ships without a planning file');
  } finally {
    fs.rmSync(session.root, { recursive: true, force: true });
  }
});

test('refuses-dirty-tree-lists-paths', () => {
  const fx = fixture({ dirty: ' M src/app.ts\0?? secret.txt\0' });
  try {
    const result = ship({}, fx.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /src\/app\.ts/);
    assert.match(result.message, /secret\.txt/);
    assert.deepEqual(fx.gitCalls.filter((args) => args[0] === 'push'), []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('pushes-branch-and-creates-pr-once-idempotent-on-rerun', () => {
  const create = fixture({ existingPr: null });
  try {
    assert.equal(ship({}, create.deps).exitCode, 0);
    assert.ok(create.gitCalls.some((args) => args.join(' ') === 'push -u origin feature/dark-mode'));
    assert.deepEqual(create.ghCalls.filter((call) => call === 'create'), ['create']);
  } finally {
    fs.rmSync(create.root, { recursive: true, force: true });
  }

  const rerun = fixture({ existingPr: { number: 42, url: 'https://github.example/owner/repo/pull/42' } });
  try {
    assert.equal(ship({}, rerun.deps).exitCode, 0);
    assert.deepEqual(rerun.ghCalls.filter((call) => call === 'create'), []);
  } finally {
    fs.rmSync(rerun.root, { recursive: true, force: true });
  }
});

test('generated-body-vs-body-file-override-and-metadata-only-body', () => {
  const generated = fixture();
  try {
    assert.equal(ship({}, generated.deps).exitCode, 0);
    const body = generated.writtenBodies.at(-1) ?? '';
    assert.match(body, /Feature: dark-mode/);
    assert.doesNotMatch(body, /```|raw finding|comment body/i);
    for (const line of body.split('\n').filter((l) => l.trim() !== '')) {
      assert.ok(line.startsWith('#') || line.startsWith('- '), `metadata line only: ${line}`);
    }
  } finally {
    fs.rmSync(generated.root, { recursive: true, force: true });
  }

  const override = fixture();
  try {
    const bodyFile = path.join(override.root, 'custom-body.md');
    override.files.set(bodyFile, '# Custom\n');
    assert.equal(ship({ bodyFile }, override.deps).exitCode, 0);
    assert.equal(override.writtenBodies.at(-1), '# Custom\n');
  } finally {
    fs.rmSync(override.root, { recursive: true, force: true });
  }
});

test('workflow-mode-transition-commit-carries-shipped-trailer', () => {
  const fx = fixture();
  try {
    assert.equal(ship({}, fx.deps).exitCode, 0);
    const planning = fx.files.get(fx.planningFile) ?? '';
    assert.match(planning, /state: "shipped"/);
    const commit = fx.gitCalls.find((args) => args[0] === 'commit' && !args.includes('--no-verify'));
    assert.ok(commit?.some((part) => /Workflow-Phase: shipped/.test(part)), 'transition commit carries shipped trailer');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('ci-green-red-none-and-notify-semantics', () => {
  const green = fixture();
  try {
    assert.equal(ship({}, green.deps).exitCode, 0);
    assert.match(green.files.get(green.statePath) ?? '', /review_state: "awaiting_human_review"/);
    assert.equal(green.notifications.at(-1)?.event, 'ready_for_review');
  } finally {
    fs.rmSync(green.root, { recursive: true, force: true });
  }

  const red = fixture({ checks: [{ name: 'verify', conclusion: 'failure' }] });
  try {
    const result = ship({}, red.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error?.step, 'ci-wait');
    assert.match(red.files.get(red.statePath) ?? '', /review_state: "ci_failed"/);
    assert.equal(red.notifications.at(-1)?.event, 'ci_failed');
  } finally {
    fs.rmSync(red.root, { recursive: true, force: true });
  }

  const none = fixture({ checks: [] });
  try {
    assert.equal(ship({ noCiWait: true }, none.deps).exitCode, 0);
    assert.match(ship({ noCiWait: true }, none.deps).message, /no CI/i);
  } finally {
    fs.rmSync(none.root, { recursive: true, force: true });
  }
});

test('notify-failure-never-blocks-ship', () => {
  const fx = fixture({ notifyOk: false });
  try {
    const result = ship({}, fx.deps);
    assert.equal(result.exitCode, 0);
    assert.match(result.message, /notify failed/i);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('gh-failure-leaves-state-unchanged-exit-1', () => {
  const fx = fixture({ failGh: true });
  const before = fx.files.get(fx.statePath);
  try {
    const result = ship({}, fx.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error?.step, 'pr-list');
    assert.equal(fx.files.get(fx.statePath), before);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('hook-rejection-of-transition-commit-sets-ship-failed', () => {
  const fx = fixture({ failTransitionCommit: true });
  try {
    const result = ship({}, fx.deps);
    assert.equal(result.exitCode, 1);
    assert.match(fx.files.get(fx.planningFile) ?? '', /state: "ship-failed"/);
    assert.ok(fx.gitCalls.some((args) => args[0] === 'commit' && args.includes('--no-verify')));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('reship-from-shipped-is-maintenance-not-transition', () => {
  const fx = fixture({ planning: frontMatter({ state: 'shipped' }) });
  try {
    assert.equal(ship({}, fx.deps).exitCode, 0);
    assert.deepEqual(fx.gitCalls.filter((args) => args[0] === 'commit'), []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('generated-body-passes-secret-scan-hit-aborts', () => {
  const fx = fixture({ scanHit: 'secret scanner hit' });
  try {
    const result = ship({}, fx.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /secret scanner hit/);
    assert.deepEqual(fx.ghCalls.filter((call) => call === 'create'), []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('reship-from-processing-review-notifies-work-finished', () => {
  const fx = fixture({
    records: [{ slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 42, review_state: 'processing_review' }],
    existingPr: { number: 42, url: 'https://github.example/owner/repo/pull/42' },
  });
  try {
    assert.equal(ship({}, fx.deps).exitCode, 0);
    assert.equal(fx.notifications.at(-1)?.event, 'work_finished');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
