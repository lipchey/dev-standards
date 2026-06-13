// S14b Task 14b.2 `workflow cleanup` tests (TDD, contract = the test names).
//
// cleanup sweeps EVERY feature record in STATE.md, asks GitHub each PR's merge
// status, validates the record as UNTRUSTED input before any destructive op, and
// decides one of three outcomes. The most safety-critical command in the helper:
// validation-before-destruction and dry-run-zero-side-effects are the core
// invariants every test below pins. Mirrors the ship.test.ts fixture style:
// in-memory file Map + recorded gitCalls/ghCalls + a hand-built fake GhAdapter +
// a runGit stub that branches on args[0] + a scanPrBody stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup } from '../../workflow/src/cleanup.ts';
import type { CleanupDeps } from '../../workflow/src/cleanup.ts';
import type { FeatureRecord, WorkflowConfig } from '../../workflow/src/types.ts';
import type { GhPrView } from '../../workflow/src/gh.ts';
import { assertSafeFeatureBranch } from '../../workflow/src/gh.ts';
import { GitError } from '../../workflow/src/trailers.ts';
import { GhError } from '../../workflow/src/gh.ts';

const STATE_REL = path.join('.agents', 'handoffs', 'STATE.md');

// A stable worktree_parent shared by every fixture so a record's worktree path
// (built with `wt(slug)`) always matches the deps config used for rule-4
// confinement. realpath is identity in tests, so this need not exist on disk.
const WT_PARENT = '/tmp/cleanup-wts';
function wt(slug: string): string {
  return path.join(WT_PARENT, slug);
}

function config(root: string, overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
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
    ...overrides,
  };
}

function stateDoc(records: FeatureRecord[]): string {
  const lines = ['---', 'updated: "2026-06-12T10:00:00Z"', 'features:'];
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

// A merged PR view whose head ref matches the record branch (the happy path).
function mergedView(branch: string): GhPrView {
  return {
    number: 0,
    url: 'https://github.example/owner/repo/pull/0',
    state: 'MERGED',
    mergedAt: '2026-06-12T09:00:00Z',
    headRefName: branch,
    mergeable: 'MERGEABLE',
  };
}

function openView(branch: string): GhPrView {
  return {
    number: 0,
    url: 'https://github.example/owner/repo/pull/0',
    state: 'OPEN',
    mergedAt: null,
    headRefName: branch,
    mergeable: 'MERGEABLE',
  };
}

interface Overrides {
  records?: FeatureRecord[];
  config?: Partial<WorkflowConfig>;
  // PR view per PR number; defaults to a merged-matching view for that record.
  views?: Record<number, GhPrView>;
  // worktrees that are DIRTY (git status --porcelain returns non-empty).
  dirtyWorktrees?: Set<string>;
  // `git worktree list --porcelain` association: branch -> worktree path. When a
  // record is omitted here, its worktree is treated as not associated with the
  // branch (rule 4 fails). Defaults to "every record's worktree is associated".
  worktreeAssoc?: Record<string, string>; // branch -> abs worktree path
  // branches currently checked out in a live worktree (rule 3). Always includes
  // the cleanup repo's own HEAD branch.
  liveBranches?: Set<string>;
  // make check-ref-format fail for these branch names (rule 1, git side).
  badRefFormat?: Set<string>;
  scanHit?: string | null;
  cmuxArmed?: boolean;
  dryRun?: boolean;
  failGh?: number | null; // PR number whose viewPr throws a GhError
  failGitDestructive?: boolean; // make `git branch -D` throw a GitError
  // make `git branch -D <branch>` throw a GitError for these branch names only
  // (models ONE record's destructive op failing mid-sweep).
  failBranchDelete?: Set<string>;
  realpath?: (p: string) => string; // override realpath resolution (rule 4)
  // Models real git's on-disk presence for a recorded worktree path (rule 4): a
  // path returns false here once its worktree has been removed on disk. Defaults
  // to "every recorded worktree path still exists" so legacy fixtures keep their
  // present-but-out-of-parent / unassociated-but-present skip semantics.
  pathExists?: (p: string) => boolean;
}

function fixture(overrides: Overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-cleanup-'));
  const cfg = config(root, { worktree_parent: WT_PARENT, ...(overrides.config ?? {}) });
  const records = overrides.records ?? [{
    slug: 'dark-mode',
    branch: 'feature/dark-mode',
    worktree: wt('dark-mode'),
    pr: 42,
    review_state: 'awaiting_human_review',
  }];
  const statePath = path.join(root, STATE_REL);
  const files = new Map<string, string>();
  files.set(statePath, stateDoc(records));

  const gitCalls: string[][] = [];
  const ghCalls: number[] = [];
  const archiveWrites: Array<{ path: string; content: string }> = [];
  // Every writeFile call (any path) so a path-traversal escape is observable even
  // when the escaped path falls OUTSIDE `.agents/handoffs` (where archiveWrites
  // wouldn't record it).
  const allWrites: Array<{ path: string; content: string }> = [];
  const cmuxClosed: string[] = [];
  const logs: string[] = [];

  // Default worktree association: every record's worktree is the one git
  // associates with its branch (so rule 4 passes unless overridden).
  const assoc: Record<string, string> =
    overrides.worktreeAssoc ?? Object.fromEntries(records.filter((r) => r.worktree !== '').map((r) => [r.branch, r.worktree]));
  const liveBranches = overrides.liveBranches ?? new Set<string>(['main']); // repo HEAD

  function worktreeListPorcelain(): string {
    // The cleanup-running repo's own HEAD first, then each associated worktree.
    const blocks: string[] = [`worktree ${root}`, 'HEAD 0000000000000000000000000000000000000000', 'branch refs/heads/main', ''];
    for (const [branch, worktreePath] of Object.entries(assoc)) {
      blocks.push(`worktree ${worktreePath}`, 'HEAD 1111111111111111111111111111111111111111', `branch refs/heads/${branch}`, '');
    }
    // Any live branch not already associated above is checked out in some OTHER
    // live worktree (used to model "branch is live elsewhere than the record").
    for (const branch of liveBranches) {
      if (branch === 'main' || branch in assoc) continue;
      blocks.push(`worktree ${path.join(root, 'elsewhere', branch)}`, 'HEAD 2222222222222222222222222222222222222222', `branch refs/heads/${branch}`, '');
    }
    return blocks.join('\n');
  }

  const deps: CleanupDeps = {
    repoRoot: root,
    statePath,
    config: cfg,
    readFile: (file) => {
      const v = files.get(file);
      if (v !== undefined) return v;
      return fs.readFileSync(file, 'utf8');
    },
    writeFile: (file, text) => {
      files.set(file, text);
      allWrites.push({ path: file, content: text });
      if (file.includes(path.join('.agents', 'handoffs')) && file.endsWith('.md') && !file.endsWith('STATE.md')) {
        archiveWrites.push({ path: file, content: text });
      }
    },
    mkdir: () => {},
    now: () => '2026-06-12T12:00:00Z',
    runGit: (args, cwd) => {
      gitCalls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') return worktreeListPorcelain();
      if (args[0] === 'status' && args.includes('--porcelain')) {
        // cwd is the worktree being inspected.
        return overrides.dirtyWorktrees?.has(cwd) ? ' M file.ts\n' : '';
      }
      if (args[0] === 'check-ref-format') {
        const branch = args[args.length - 1] ?? '';
        if (overrides.badRefFormat?.has(branch)) {
          throw new GitError(`git ${args.join(' ')}`, 'bad ref', 'git check-ref-format failed (status 1): bad ref');
        }
        return '';
      }
      if (args[0] === 'branch' && args[1] === '-D') {
        const branch = args[args.length - 1] ?? '';
        if (overrides.failGitDestructive === true || overrides.failBranchDelete?.has(branch)) {
          throw new GitError(`git ${args.join(' ')}`, 'cannot delete', 'git branch -D failed (status 1): cannot delete');
        }
        return '';
      }
      return '';
    },
    removeWorktree: (wt) => {
      gitCalls.push(['__rm-worktree', wt]);
    },
    gh: {
      findPrByHead: () => null,
      viewPr: (pr: number): GhPrView => {
        ghCalls.push(pr);
        if (overrides.failGh === pr) {
          throw new GhError('gh pr view', 'no auth', 'gh pr view failed (status 1): no auth', 'pr-view');
        }
        const view = overrides.views?.[pr];
        if (view !== undefined) return view;
        // Default: merged + matching head ref for the record carrying this pr.
        const rec = records.find((r) => r.pr === pr);
        return rec === undefined ? openView('feature/unknown') : mergedView(rec.branch);
      },
      createPr: () => ({ url: '' }),
      editPrBody: () => {},
      watchChecks: () => [],
      deleteLocalBranchArgs: (branch: string, base = cfg.base_branch): string[] => {
        if (branch === base) throw new Error(`refuses to delete base branch ${JSON.stringify(branch)}`);
        assertSafeFeatureBranch(branch);
        return ['branch', '-D', '--', branch];
      },
      repoInfo: () => ({ owner: 'owner', name: 'repo' }),
      prReviewData: () => ({ reviews: [], threads: [], mergeable: null, truncated: { threads: false, comments: false } }),
    },
    closeCmuxSection: (section: string) => {
      if (overrides.cmuxArmed === true) {
        cmuxClosed.push(section);
        return { ok: true };
      }
      return { ok: false, error: 'cmux unavailable' };
    },
    cmuxArmed: overrides.cmuxArmed === true,
    scanPrBody: (content: string) => overrides.scanHit ?? (content.includes('SECRET') ? 'secret hit' : null),
    realpath: overrides.realpath ?? ((p: string) => p),
    // Default: every recorded worktree path still exists on disk (matches real
    // git for a record whose worktree has NOT yet been removed). Tests that model
    // a removed-on-disk worktree pass an explicit stub returning false for it.
    pathExists: overrides.pathExists ?? (() => true),
    log: (text: string) => logs.push(text),
  };

  return {
    root, statePath, files, deps, gitCalls, ghCalls, archiveWrites, allWrites, cmuxClosed, logs,
    opts: { dryRun: overrides.dryRun === true },
  };
}

function destructiveCalls(gitCalls: string[][]): string[][] {
  return gitCalls.filter((a) =>
    (a[0] === 'branch' && a[1] === '-D')
    || a[0] === '__rm-worktree'
    || (a[0] === 'worktree' && a[1] === 'prune'));
}

function remainingRecords(files: Map<string, string>, statePath: string): string[] {
  const text = files.get(statePath) ?? '';
  return [...text.matchAll(/branch: "([^"]+)"/g)].map((m) => m[1] ?? '');
}

test('merged-clean-full-cleanup-archives-and-drops-record', () => {
  const fx = fixture();
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    // archive written
    assert.equal(fx.archiveWrites.length, 1);
    assert.match(fx.archiveWrites[0]!.path, /2026-06-12-workflow-dark-mode\.md$/);
    // worktree removed, branch force-deleted, pruned
    assert.ok(fx.gitCalls.some((a) => a[0] === '__rm-worktree'), 'worktree removed');
    assert.ok(fx.gitCalls.some((a) => a[0] === 'branch' && a[1] === '-D' && a[3] === 'feature/dark-mode'), 'branch force-deleted');
    assert.ok(fx.gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'prune'), 'pruned');
    // record dropped
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('archive-is-metadata-only-bodies-forbidden', () => {
  const fx = fixture();
  try {
    cleanup(fx.opts, fx.deps);
    const content = fx.archiveWrites[0]!.content;
    assert.match(content, /dark-mode/);
    assert.match(content, /feature\/dark-mode/);
    assert.match(content, /42/);
    // HARD INVARIANT: no code fences, no raw bodies.
    assert.doesNotMatch(content, /```/);
    assert.doesNotMatch(content, /raw finding|comment body|diff body/i);
    // Every non-blank line is a heading or a metadata bullet (mirrors ship body).
    for (const line of content.split('\n').filter((l) => l.trim() !== '')) {
      assert.ok(line.startsWith('#') || line.startsWith('- '), `metadata line only: ${line}`);
    }
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('scanner-hit-skips-archive-logs-cleanup-proceeds', () => {
  const fx = fixture({ scanHit: 'archive secret hit' });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    // archive NOT written
    assert.equal(fx.archiveWrites.length, 0);
    // skip logged
    assert.ok(fx.logs.some((l) => /secret|scan/i.test(l)), 'scan skip logged');
    // but cleanup PROCEEDS: branch deleted, worktree removed, record dropped
    assert.ok(fx.gitCalls.some((a) => a[0] === 'branch' && a[1] === '-D'), 'branch still deleted');
    assert.ok(fx.gitCalls.some((a) => a[0] === '__rm-worktree'), 'worktree still removed');
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('merged-dirty-guard-sets-done-keeps-everything-reports', () => {
  const dirtyWt = wt('dark-mode');
  const fx = fixture({
    records: [{ slug: 'dark-mode', branch: 'feature/dark-mode', worktree: dirtyWt, pr: 42, review_state: 'awaiting_human_review' }],
    worktreeAssoc: { 'feature/dark-mode': dirtyWt },
    dirtyWorktrees: new Set([dirtyWt]),
  });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    // NOTHING destroyed
    assert.deepEqual(destructiveCalls(fx.gitCalls), []);
    assert.equal(fx.archiveWrites.length, 0);
    // record kept and set to done
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), ['feature/dark-mode']);
    assert.match(fx.files.get(fx.statePath) ?? '', /review_state: "done"/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('open-awaiting-ci-failed-untouched', () => {
  const fx = fixture({
    records: [
      { slug: 'a', branch: 'feature/a', worktree: wt('a'), pr: 1, review_state: 'awaiting_human_review' },
      { slug: 'b', branch: 'feature/b', worktree: wt('b'), pr: 2, review_state: 'ci_failed' },
    ],
    views: { 1: openView('feature/a'), 2: openView('feature/b') },
  });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(destructiveCalls(fx.gitCalls), []);
    assert.equal(fx.archiveWrites.length, 0);
    // both records kept, review_state unchanged (no `done`)
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), ['feature/a', 'feature/b']);
    assert.doesNotMatch(fx.files.get(fx.statePath) ?? '', /review_state: "done"/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('dry-run-no-side-effects', () => {
  const fx = fixture({ dryRun: true });
  const before = fx.files.get(fx.statePath);
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    // ZERO destructive git argv recorded
    assert.deepEqual(destructiveCalls(fx.gitCalls), []);
    // no archive write
    assert.equal(fx.archiveWrites.length, 0);
    // no cmux close
    assert.deepEqual(fx.cmuxClosed, []);
    // record array unchanged (STATE.md byte-identical)
    assert.equal(fx.files.get(fx.statePath), before);
    // it still REPORTS what would happen
    assert.match(result.message, /would|dry/i);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('closes-cmux-section-when-armed', () => {
  const fx = fixture({ cmuxArmed: true });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fx.cmuxClosed, ['dark-mode']);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }

  const off = fixture({ cmuxArmed: false });
  try {
    const result = cleanup(off.opts, off.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(off.cmuxClosed, []); // degrades silently
  } finally {
    fs.rmSync(off.root, { recursive: true, force: true });
  }
});

test('squash-merged-branch-deleted-under-remote-merged-guard', () => {
  // A squash-merge: PR state MERGED + mergedAt set even though the branch tip is
  // not an ancestor of base. The merge guard (state===MERGED && mergedAt) is the
  // ONLY gate that authorizes `git branch -D`.
  const fx = fixture({
    views: { 42: { ...mergedView('feature/dark-mode'), mergeable: 'UNKNOWN' } },
  });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    const del = fx.gitCalls.filter((a) => a[0] === 'branch' && a[1] === '-D');
    assert.equal(del.length, 1, 'branch -D fires exactly once, behind the merged guard');
    assert.deepEqual(del[0], ['branch', '-D', '--', 'feature/dark-mode']);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }

  // Counter-case: NOT merged -> no branch -D at all.
  const open = fixture({ views: { 42: openView('feature/dark-mode') } });
  try {
    cleanup(open.opts, open.deps);
    assert.deepEqual(open.gitCalls.filter((a) => a[0] === 'branch' && a[1] === '-D'), []);
  } finally {
    fs.rmSync(open.root, { recursive: true, force: true });
  }
});

test('mismatched-headref-skips-record-no-delete', () => {
  const fx = fixture({
    views: { 42: { ...mergedView('feature/SOMEONE-ELSE'), headRefName: 'feature/someone-else' } },
  });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(destructiveCalls(fx.gitCalls), []);
    // record kept (not dropped, not archived)
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), ['feature/dark-mode']);
    assert.equal(fx.archiveWrites.length, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unsafe-refname-record-skipped', () => {
  for (const branch of ['-feature/evil', 'feature/with:colon', 'feature/with space', 'main-not-feature']) {
    const unsafeWt = wt('x');
    const fx = fixture({
      records: [{ slug: 'x', branch, worktree: unsafeWt, pr: 42, review_state: 'awaiting_human_review' }],
      worktreeAssoc: { [branch]: unsafeWt },
      views: { 42: { ...mergedView(branch), headRefName: branch } },
    });
    try {
      const result = cleanup(fx.opts, fx.deps);
      assert.equal(result.exitCode, 0, `unsafe ${branch} is report-and-skip, not infra failure`);
      assert.deepEqual(destructiveCalls(fx.gitCalls), [], `no destructive op for unsafe branch ${branch}`);
      assert.deepEqual(remainingRecords(fx.files, fx.statePath), [branch], `unsafe record kept: ${branch}`);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('base-or-current-branch-never-deleted', () => {
  // Case A: a corrupt record claims the BASE branch (rule 3). The pure ref screen
  // accepts `feature/main`, but rule 3 refuses the configured base branch.
  const base = fixture({
    config: { base_branch: 'feature/main' },
    records: [{ slug: 'base', branch: 'feature/main', worktree: wt('base'), pr: 6, review_state: 'awaiting_human_review' }],
    worktreeAssoc: { 'feature/main': wt('base') },
    views: { 6: mergedView('feature/main') },
  });
  try {
    const result = cleanup(base.opts, base.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(base.gitCalls.filter((a) => a[0] === 'branch' && a[1] === '-D'), [], 'base branch never force-deleted');
    assert.deepEqual(remainingRecords(base.files, base.statePath), ['feature/main']);
  } finally {
    fs.rmSync(base.root, { recursive: true, force: true });
  }

  // Case B: the record claims a worktree, but git reports the branch checked out in
  // a DIFFERENT live worktree (corrupt/stale record). Rule 3 refuses to delete a
  // branch that is live somewhere other than the worktree the record owns.
  const live = fixture({
    records: [{ slug: 'live', branch: 'feature/live', worktree: wt('live'), pr: 7, review_state: 'awaiting_human_review' }],
    // git associates feature/live with NO worktree the record owns (empty assoc),
    // but the branch IS checked out elsewhere (liveBranches).
    worktreeAssoc: {},
    liveBranches: new Set(['main', 'feature/live']),
    views: { 7: mergedView('feature/live') },
  });
  try {
    const result = cleanup(live.opts, live.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(live.gitCalls.filter((a) => a[0] === 'branch' && a[1] === '-D'), [], 'live-elsewhere branch never force-deleted');
    assert.deepEqual(remainingRecords(live.files, live.statePath), ['feature/live']);
  } finally {
    fs.rmSync(live.root, { recursive: true, force: true });
  }
});

test('out-of-parent-worktree-skipped-no-removal', () => {
  // realpath resolves the worktree OUTSIDE worktree_parent -> rule 4 fails.
  const escapeWt = '/etc/evil-worktree';
  const fx = fixture({
    records: [{ slug: 'esc', branch: 'feature/esc', worktree: escapeWt, pr: 9, review_state: 'awaiting_human_review' }],
    worktreeAssoc: { 'feature/esc': escapeWt },
    views: { 9: mergedView('feature/esc') },
    realpath: (p) => p, // identity: /etc/evil-worktree stays outside worktree_parent
  });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(destructiveCalls(fx.gitCalls), []);
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), ['feature/esc']);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }

  // Unassociated worktree: realpath in-parent but git does NOT associate it.
  const unassocWt = wt('unassoc');
  const fx2 = fixture({
    records: [{ slug: 'u', branch: 'feature/u', worktree: unassocWt, pr: 10, review_state: 'awaiting_human_review' }],
    worktreeAssoc: {}, // not associated with any worktree per git
    views: { 10: mergedView('feature/u') },
  });
  try {
    cleanup(fx2.opts, fx2.deps);
    assert.deepEqual(destructiveCalls(fx2.gitCalls), []);
    assert.deepEqual(remainingRecords(fx2.files, fx2.statePath), ['feature/u']);
  } finally {
    fs.rmSync(fx2.root, { recursive: true, force: true });
  }
});

test('in-place-record-skips-worktree-removal-deletes-branch-drops-record', () => {
  const fx = fixture({
    records: [{ slug: 'inplace', branch: 'feature/inplace', worktree: '', pr: 11, review_state: 'awaiting_human_review' }],
    worktreeAssoc: {}, // no worktree associated; the feature was built in-place
    views: { 11: mergedView('feature/inplace') },
  });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    // NO worktree removal recorded
    assert.deepEqual(fx.gitCalls.filter((a) => a[0] === '__rm-worktree'), []);
    // branch deleted, record dropped
    assert.ok(fx.gitCalls.some((a) => a[0] === 'branch' && a[1] === '-D' && a[3] === 'feature/inplace'));
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('gh-failure-is-infra-error-exit-1-machine-readable', () => {
  const fx = fixture({ failGh: 42 });
  const before = fx.files.get(fx.statePath);
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error?.step, 'pr-view');
    // STATE.md untouched on an infra failure
    assert.equal(fx.files.get(fx.statePath), before);
    assert.deepEqual(destructiveCalls(fx.gitCalls), []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('git-destructive-failure-is-infra-error-exit-1', () => {
  const fx = fixture({ failGitDestructive: true });
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 1);
    assert.ok(result.error !== undefined, 'machine-readable git error surfaced');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('partial-failure-persists-progress-then-fails', () => {
  // Two merged-clean records. The FIRST cleans fully; the SECOND's `git branch -D`
  // THROWS mid-loop. The sweep must STOP, but STILL persist STATE.md reflecting the
  // FIRST record's drop (progress is not lost), then return the machine-readable
  // git error (exit 1). Without progress persistence, a re-run would re-process the
  // already-cleaned first record and re-throw on its gone branch/worktree.
  const records: FeatureRecord[] = [
    { slug: 'a', branch: 'feature/a', worktree: wt('a'), pr: 1, review_state: 'awaiting_human_review' },
    { slug: 'b', branch: 'feature/b', worktree: wt('b'), pr: 2, review_state: 'awaiting_human_review' },
  ];
  const fx = fixture({
    records,
    worktreeAssoc: { 'feature/a': wt('a'), 'feature/b': wt('b') },
    views: { 1: mergedView('feature/a'), 2: mergedView('feature/b') },
    failBranchDelete: new Set(['feature/b']),
  });
  try {
    const result = cleanup(fx.opts, fx.deps);
    // (b) command exits 1 with the machine-readable git error.
    assert.equal(result.exitCode, 1, 'partial failure surfaces as exit 1');
    assert.ok(result.error !== undefined, 'machine-readable git error surfaced');
    // (a) the FIRST record was dropped from STATE.md (progress persisted), the
    // SECOND record remains (its cleanup did not complete).
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), ['feature/b'], 'first record dropped, second kept');
    // the first record really was cleaned on disk: its worktree removed + branch
    // deleted before the second record threw.
    assert.ok(fx.gitCalls.some((c) => c[0] === '__rm-worktree' && c[1] === wt('a')), 'first worktree removed');
    assert.ok(
      fx.gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D' && c[3] === 'feature/a'),
      'first branch deleted',
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('rerun-after-partial-failure-recovers', () => {
  // After a partial failure (first record cleaned + dropped, second left), a re-run
  // operates on the persisted STATE.md (only the second record). This time nothing
  // throws and the sweep completes the remaining record without re-processing the
  // already-cleaned first one.
  //
  // CRITICAL real-git fidelity: run 1 removed feature/b's worktree on disk BEFORE
  // its `git branch -D` threw. So on the re-run, real `git worktree list` no longer
  // reports that worktree (drop it from worktreeAssoc) AND `pathExists(wt('b'))` is
  // false. Rule 4 must treat a genuinely-gone recorded worktree as already-removed
  // (validation PASSES) so the branch delete can be retried — otherwise the record
  // leaks forever. (A fixture that re-supplied the association would be vacuous: it
  // would assert git still tracks a worktree it had already removed, which real git
  // never does.)
  const records: FeatureRecord[] = [
    { slug: 'a', branch: 'feature/a', worktree: wt('a'), pr: 1, review_state: 'awaiting_human_review' },
    { slug: 'b', branch: 'feature/b', worktree: wt('b'), pr: 2, review_state: 'awaiting_human_review' },
  ];
  const first = fixture({
    records,
    worktreeAssoc: { 'feature/a': wt('a'), 'feature/b': wt('b') },
    views: { 1: mergedView('feature/a'), 2: mergedView('feature/b') },
    failBranchDelete: new Set(['feature/b']),
  });
  let persistedState: string;
  try {
    const r1 = cleanup(first.opts, first.deps);
    assert.equal(r1.exitCode, 1);
    persistedState = first.files.get(first.statePath) ?? '';
    assert.deepEqual(remainingRecords(first.files, first.statePath), ['feature/b']);
  } finally {
    fs.rmSync(first.root, { recursive: true, force: true });
  }

  // Re-run: STATE.md now carries ONLY feature/b; the destructive op no longer fails.
  // Real git no longer associates feature/b with any worktree (it was removed on
  // disk in run 1) and that path no longer exists on disk.
  const second = fixture({
    records: [{ slug: 'b', branch: 'feature/b', worktree: wt('b'), pr: 2, review_state: 'awaiting_human_review' }],
    worktreeAssoc: {}, // git no longer tracks the removed worktree
    pathExists: (p) => p !== wt('b'), // its path is gone on disk
    views: { 2: mergedView('feature/b') },
  });
  // Real-git fidelity: `git status` in a removed cwd ENOENTs. The fix must SKIP the
  // dirty/clean check for the gone worktree, so this stub must never be reached for
  // wt('b') — if it is, cleanup would abort (proving the fix when it does not).
  const secondInner = second.deps.runGit;
  second.deps.runGit = (args, cwd) => {
    if (args[0] === 'status' && args.includes('--porcelain') && cwd === wt('b')) {
      throw new GitError('git status --porcelain', 'ENOENT', 'git status failed (status 128): cwd missing');
    }
    return secondInner(args, cwd);
  };
  second.files.set(second.statePath, persistedState);
  try {
    const r2 = cleanup(second.opts, second.deps);
    assert.equal(r2.exitCode, 0, 're-run completes the remaining record');
    // feature/a is NOT re-processed (it is no longer in STATE.md): no second
    // attempt to remove its worktree or delete its branch.
    assert.ok(!second.gitCalls.some((c) => c[0] === '__rm-worktree' && c[1] === wt('a')), 'cleaned record not re-touched');
    assert.ok(
      !second.gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D' && c[3] === 'feature/a'),
      'cleaned branch not re-deleted',
    );
    // feature/b finishes: removeWorktree is still CALLED (it no-ops on the gone
    // path at the CLI edge), branch deleted, record dropped.
    assert.ok(
      second.gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D' && c[3] === 'feature/b'),
      'remaining branch deleted',
    );
    assert.deepEqual(remainingRecords(second.files, second.statePath), [], 'all records cleaned after re-run');
  } finally {
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});

test('worktree-removed-but-branch-delete-failed-then-recovers-on-rerun', () => {
  // The proven partial-failure scenario, end to end:
  //   Run 1: worktree removal SUCCEEDS but `git branch -D` THROWS (e.g. branch
  //          concurrently checked out / index lock / transient git error). The
  //          record is correctly NOT dropped (throw precedes the drop), so it stays
  //          in STATE.md with its original non-empty worktree field. Exit 1.
  //   Run 2: real git no longer reports that worktree (removed on disk in run 1)
  //          AND pathExists(worktree) is false; `git branch -D` now succeeds. The
  //          gone worktree must NOT trip rule 4 — the branch is deleted and the
  //          record dropped. Exit 0. (Before the fix this record leaked forever.)
  const record: FeatureRecord = {
    slug: 'leak', branch: 'feature/leak', worktree: wt('leak'), pr: 5, review_state: 'awaiting_human_review',
  };

  // ── Run 1: removeWorktree ok, branch -D throws. ──────────────────────────────
  let persistedState: string;
  const run1 = fixture({
    records: [record],
    worktreeAssoc: { 'feature/leak': wt('leak') }, // git tracks it before removal
    pathExists: () => true, // worktree still on disk at the start of run 1
    views: { 5: mergedView('feature/leak') },
    failBranchDelete: new Set(['feature/leak']),
  });
  try {
    const r1 = cleanup(run1.opts, run1.deps);
    assert.equal(r1.exitCode, 1, 'branch -D failure surfaces as exit 1');
    assert.ok(r1.error !== undefined, 'machine-readable git error surfaced');
    // The worktree WAS removed before the throw.
    assert.ok(run1.gitCalls.some((c) => c[0] === '__rm-worktree' && c[1] === wt('leak')), 'worktree removed in run 1');
    // The record is KEPT (throw precedes the drop) with its original worktree.
    assert.deepEqual(remainingRecords(run1.files, run1.statePath), ['feature/leak'], 'record kept, branch not dropped');
    persistedState = run1.files.get(run1.statePath) ?? '';
    assert.match(persistedState, /worktree: "[^"]+leak"/, 'record still carries its original worktree path');
  } finally {
    fs.rmSync(run1.root, { recursive: true, force: true });
  }

  // ── Run 2: association gone, path gone, branch -D now succeeds. ───────────────
  const run2 = fixture({
    records: [record],
    worktreeAssoc: {}, // git no longer tracks the removed worktree
    pathExists: (p) => p !== wt('leak'), // gone on disk
    views: { 5: mergedView('feature/leak') },
    // no failBranchDelete: the transient git error has cleared.
  });
  // Real-git fidelity: `git status` in the removed worktree cwd ENOENTs. The fix
  // must SKIP the dirty/clean check for the gone worktree; reaching this stub would
  // abort the re-run, so its absence proves the fix.
  const run2Inner = run2.deps.runGit;
  run2.deps.runGit = (args, cwd) => {
    if (args[0] === 'status' && args.includes('--porcelain') && cwd === wt('leak')) {
      throw new GitError('git status --porcelain', 'ENOENT', 'git status failed (status 128): cwd missing');
    }
    return run2Inner(args, cwd);
  };
  run2.files.set(run2.statePath, persistedState);
  try {
    const r2 = cleanup(run2.opts, run2.deps);
    assert.equal(r2.exitCode, 0, 're-run recovers: rule 4 treats the gone worktree as already-removed');
    // Branch finally deleted, record finally dropped — no permanent leak.
    assert.ok(
      run2.gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D' && c[3] === 'feature/leak'),
      'branch deleted on re-run',
    );
    assert.deepEqual(remainingRecords(run2.files, run2.statePath), [], 'record dropped on re-run');
  } finally {
    fs.rmSync(run2.root, { recursive: true, force: true });
  }
});

test('archive-bytes-scanned-equal-bytes-written-and-single-now', () => {
  // Item A: the bytes SCANNED by scanPrBody must be byte-identical to the bytes
  // WRITTEN to the archive, and the filename date must equal the content date even
  // across a clock tick. Drive now() to advance on every call: if decide() and
  // applyFullCleanup() each call now(), the scanned content / filename date would
  // drift from the written content. With a single now() per archived record they
  // cannot.
  let scanned: string | null = null;
  const fx = fixture();
  let tick = 0;
  // now() advances each call across a UTC-day boundary: first call 2026-06-12,
  // a later call would roll to 2026-06-13. Only ONE call per archived record is
  // allowed, so the date stays 2026-06-12 everywhere.
  fx.deps.now = () => {
    tick += 1;
    return tick <= 1 ? '2026-06-12T23:59:59Z' : `2026-06-1${3 + tick}T00:00:0${tick}Z`;
  };
  const inner = fx.deps.scanPrBody;
  fx.deps.scanPrBody = (content: string) => {
    scanned = content;
    return inner(content);
  };
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(fx.archiveWrites.length, 1);
    const written = fx.archiveWrites[0]!;
    // bytes scanned === bytes written (Item A core invariant).
    assert.equal(scanned, written.content, 'scanned bytes equal written bytes');
    // filename date === content date (one now() => no drift across the tick).
    assert.match(written.path, /2026-06-12-workflow-dark-mode\.md$/, 'filename date matches content date');
    assert.match(written.content, /- date: 2026-06-12\n/, 'content date is the single now()');
    assert.match(written.content, /- archived_at: 2026-06-12T23:59:59Z\n/, 'archived_at is the single now()');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// ── FIX 1 (P1): untrusted slug path-traversal in the cleanup archive ──────────
// Feature records are UNTRUSTED; readFeatureRecords does NOT re-sanitize the slug.
// archivePath() builds `.agents/handoffs/<date>-workflow-${slug}.md` from the RAW
// slug, so a hand-edited `slug: "../../../../README"` (with an otherwise valid
// merged/clean feature branch) used to WRITE the archive to a traversal path
// (overwriting e.g. /repo/README.md) BEFORE any delete. The slug must be validated
// in validateForDestruction (report-and-skip) and the resolved archive path must be
// confined under <repoRoot>/.agents/handoffs as defense in depth.

test('slug-path-traversal-record-skipped-no-write-no-delete', () => {
  const fx = fixture({
    records: [{
      slug: '../../../../README',
      branch: 'feature/evil',
      worktree: wt('evil'),
      pr: 42,
      review_state: 'awaiting_human_review',
    }],
    worktreeAssoc: { 'feature/evil': wt('evil') },
    views: { 42: mergedView('feature/evil') },
  });
  try {
    const result = cleanup(fx.opts, fx.deps);
    // Report-and-skip, not an infra failure.
    assert.equal(result.exitCode, 0);
    // NOTHING written anywhere outside `.agents/handoffs` (no archive at the
    // traversal path); in fact NO archive is written at all for a skipped record.
    assert.equal(fx.archiveWrites.length, 0, 'no archive written for a traversal slug');
    for (const w of fx.allWrites) {
      const inHandoffs = w.path.includes(path.join('.agents', 'handoffs'));
      const isState = w.path.endsWith('STATE.md');
      assert.ok(inHandoffs || isState, `unexpected write outside .agents/handoffs: ${w.path}`);
    }
    // NO destructive ops.
    assert.deepEqual(destructiveCalls(fx.gitCalls), []);
    // Record KEPT (not dropped).
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), ['feature/evil']);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('control-char-empty-and-too-long-slug-records-skipped', () => {
  const longSlug = 'a'.repeat(61);
  // Cases the slug validator (rule 0) is responsible for: every one of these PARSES
  // through the STATE.md subset codec but fails sanitizeFeatureSlug — whitespace,
  // empty, too long, leading dash, uppercase, path separator, `..`. (A literal
  // control char such as a tab/NUL/backslash never reaches the validator: the subset
  // parser rejects it during readStateDoc — defense in depth at the parse layer.)
  for (const slug of ['bad space', '', longSlug, '-leading-dash', 'Upper', 'with/slash', 'dot..dot']) {
    const fx = fixture({
      records: [{ slug, branch: 'feature/x', worktree: wt('x'), pr: 42, review_state: 'awaiting_human_review' }],
      worktreeAssoc: { 'feature/x': wt('x') },
      views: { 42: mergedView('feature/x') },
    });
    try {
      const result = cleanup(fx.opts, fx.deps);
      assert.equal(result.exitCode, 0, `invalid slug ${JSON.stringify(slug)} is report-and-skip`);
      assert.equal(fx.archiveWrites.length, 0, `no archive for invalid slug ${JSON.stringify(slug)}`);
      assert.deepEqual(destructiveCalls(fx.gitCalls), [], `no destructive op for invalid slug ${JSON.stringify(slug)}`);
      assert.deepEqual(remainingRecords(fx.files, fx.statePath), ['feature/x'], `record kept for invalid slug ${JSON.stringify(slug)}`);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('normal-slug-still-archives-under-handoffs', () => {
  // Regression guard for the FIX 1 validator: a normal slug is unaffected and the
  // archive still lands under `.agents/handoffs`.
  const fx = fixture();
  try {
    const result = cleanup(fx.opts, fx.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(fx.archiveWrites.length, 1);
    assert.ok(
      fx.archiveWrites[0]!.path.includes(path.join('.agents', 'handoffs')),
      'normal slug archives under .agents/handoffs',
    );
    assert.match(fx.archiveWrites[0]!.path, /2026-06-12-workflow-dark-mode\.md$/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// ── FIX 2 (P2): partial-failure rerun must not run `git status` in a removed cwd ─
// decide() calls isWorktreeClean -> runGit(['status','--porcelain'], record.worktree)
// with cwd=the worktree. On the already-removed rerun case (pathExists(worktree)
// === false, which rule 4 now passes), the REAL runner spawns git against a missing
// cwd -> ENOENT -> GitError -> cleanup ABORTS before the tolerant removeWorktree
// no-op. The dirty/clean check must be SKIPPED when the recorded worktree is gone.

test('rerun-removed-worktree-does-not-run-git-status-and-completes', () => {
  const statusCwds: string[] = [];
  const fx = fixture({
    records: [{ slug: 'gone', branch: 'feature/gone', worktree: wt('gone'), pr: 5, review_state: 'awaiting_human_review' }],
    worktreeAssoc: {}, // git no longer tracks the removed worktree
    pathExists: (p) => p !== wt('gone'), // its path is gone on disk
    views: { 5: mergedView('feature/gone') },
  });
  // Make `git status` THROW if it is ever invoked against the gone worktree cwd —
  // exactly what the REAL runner does (spawnSync ENOENT on a missing cwd). The fix
  // must never reach this call.
  const innerRunGit = fx.deps.runGit;
  fx.deps.runGit = (args, cwd) => {
    if (args[0] === 'status' && args.includes('--porcelain')) {
      statusCwds.push(cwd);
      if (cwd === wt('gone')) {
        throw new GitError('git status --porcelain', 'ENOENT', 'git status failed (status 128): cwd missing');
      }
    }
    return innerRunGit(args, cwd);
  };
  try {
    const result = cleanup(fx.opts, fx.deps);
    // Cleanup completes: exit 0, branch deleted, record dropped.
    assert.equal(result.exitCode, 0, 'rerun completes without aborting on git status in a missing cwd');
    assert.ok(
      !statusCwds.includes(wt('gone')),
      'git status was NOT invoked for the removed worktree cwd',
    );
    assert.ok(
      fx.gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D' && c[3] === 'feature/gone'),
      'branch deleted',
    );
    assert.deepEqual(remainingRecords(fx.files, fx.statePath), [], 'record dropped');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
