// E5 — the worktree selector. Two landing modes:
//   reuse-workflow: an active workflow session owns landing (its planning marker
//     is at the worktree root) -> the engine reuses that worktree, never creating
//     a branch/worktree of its own. The slug is IGNORED in this branch.
//   dedicated: no marker -> the engine creates an engine-local
//     `git worktree add -b deep-review/<slug> <wtPath> <base>`, with a confinement
//     guard and a collision/idempotency gate (the S21 residue fix) that REFUSES to
//     reuse or overwrite a directory that is not THIS repo's worktree on exactly
//     `deep-review/<slug>`.
//
// These tests drive a REAL ephemeral git repo (real worktrees, real branches), as
// the plan requires: every irreversible boundary is proven by enforcement, never
// assumed. The pure confinement guard is unit-tested directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT_OK, EXIT_USAGE, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import {
  selectWorktree,
  isWorkflowWorktree,
  assertUnderParent,
  realWorktreeDeps,
} from '../../deep-review/src/worktree.ts';
import type { WorktreeDeps, SpawnResult } from '../../deep-review/src/worktree.ts';
import { SlugError } from '../../workflow/src/new-feature.ts';
import type { ManifestWorkflow } from '../../runner/src/types.ts';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';

const PLANNING = 'workflow-session-planning.md';

// ── Real-git fixture (mirrors tests/deep-review/slice.test.ts) ────────────────

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

// A base temp dir holding a real git repo (on a NAMED branch `main`) so the
// fallback base-branch read resolves, and so `../worktrees` is a clean sibling
// the engine can create worktrees under. The whole tree is removed on cleanup.
function makeBase(): { base: string; repo: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-wt-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Worktree Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(repo, ['branch', '-m', 'main']);
  return { base, repo };
}

// A spawn seam that DELEGATES to real git while recording every git argv, so a
// test can assert that NO second `worktree add` happened on a reuse/idempotent
// path (and that an add DID happen on a fresh dedicated path).
function spyOverReal(): { spawn: WorktreeDeps['spawn']; gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  const spawn: WorktreeDeps['spawn'] = (file, args, options) => {
    if (file === 'git') gitCalls.push([...args]);
    const r = spawnSync(file, [...args], { cwd: options.cwd, encoding: 'utf8', shell: false });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { spawn, gitCalls };
}

const realSpawn: WorktreeDeps['spawn'] = (file, args, options): SpawnResult => {
  const r = spawnSync(file, [...args], { cwd: options.cwd, encoding: 'utf8', shell: false });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function deps(
  cwd: string,
  over: { workflow?: ManifestWorkflow; spawn?: WorktreeDeps['spawn'] } = {},
): WorktreeDeps {
  return {
    cwd,
    workflow: over.workflow,
    existsSync: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    spawn: over.spawn ?? realSpawn,
  };
}

// A full, schema-shaped enabled workflow block; only base_branch/worktree_parent
// are read by the engine, the rest are filler to satisfy the discriminated union.
function enabledWorkflow(worktree_parent: string, base_branch: string): ManifestWorkflow {
  return {
    schema: 1,
    enabled: true,
    base_branch,
    worktree_parent,
    cmux_mode: 'manual',
    loopback_mode: 'manual',
    reviewer_independence: 'different-runtime',
    required_review_guides: [],
    commit_exclude: [],
    archive: false,
    timeouts: { default_wait_seconds: 0, default_work_seconds: 0 },
    budget: { workflow_total_seconds: 0 },
    agents: { claude: [], codex: [] },
    ship: { ci_wait_seconds: 0, notify: false },
    notify: { webhook_env: '' },
  };
}

// The fallback parent the engine computes when workflow is absent/disabled.
function fallbackWtPath(cwd: string, slug: string): string {
  return path.join(path.resolve(cwd, '../worktrees'), `deep-review-${slug}`);
}

// ── reuse-workflow ─────────────────────────────────────────────────────────────

test('reuse: a planning marker at the worktree root -> mode "reuse-workflow", worktree=cwd, NO worktree add, slug IGNORED', () => {
  const { base, repo } = makeBase();
  fs.writeFileSync(path.join(repo, PLANNING), '# session\n');
  const spy = spyOverReal();

  // An UNSAFE slug proves the slug is ignored: reuse short-circuits BEFORE sanitize.
  const result = selectWorktree('../evil', deps(repo, { spawn: spy.spawn }));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.mode, 'reuse-workflow');
  assert.equal(result.worktree, repo);
  assert.equal(result.branch, undefined, 'no branch in reuse mode');
  assert.deepEqual(spy.gitCalls, [], 'no git spawn at all in reuse mode');
  fs.rmSync(base, { recursive: true, force: true });
});

test('isWorkflowWorktree reflects the planning marker presence', () => {
  const { base, repo } = makeBase();
  assert.equal(isWorkflowWorktree(repo, { existsSync: (p) => fs.existsSync(p) }), false);
  fs.writeFileSync(path.join(repo, PLANNING), '# s\n');
  assert.equal(isWorkflowWorktree(repo, { existsSync: (p) => fs.existsSync(p) }), true);
  fs.rmSync(base, { recursive: true, force: true });
});

// ── dedicated (fallback HEAD + workflow-enabled) ───────────────────────────────

test('dedicated (fallback HEAD): no marker, workflow absent -> creates branch deep-review/<slug> + worktree from HEAD base', () => {
  const { base, repo } = makeBase();
  const spy = spyOverReal();

  const result = selectWorktree('alpha', deps(repo, { spawn: spy.spawn }));

  const expected = fallbackWtPath(repo, 'alpha');
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.mode, 'dedicated');
  assert.equal(result.branch, 'deep-review/alpha');
  assert.equal(result.worktree, expected);
  assert.equal(fs.existsSync(expected), true, 'worktree dir created');
  assert.equal(git(expected, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'deep-review/alpha');
  assert.ok(
    spy.gitCalls.some((a) => a.includes('worktree') && a.includes('add')),
    'a worktree add happened',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

test('dedicated (workflow enabled): uses worktree_parent + base_branch from the config block', () => {
  const { base, repo } = makeBase();
  const parent = path.resolve(repo, '../wts');
  const result = selectWorktree('bravo', deps(repo, { workflow: enabledWorkflow('../wts', 'main') }));

  const expected = path.join(parent, 'deep-review-bravo');
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.mode, 'dedicated');
  assert.equal(result.branch, 'deep-review/bravo');
  assert.equal(result.worktree, expected);
  assert.equal(git(expected, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'deep-review/bravo');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── slug safety ────────────────────────────────────────────────────────────────

test('slug safety (function): an unsafe slug (no marker) throws SlugError before any worktree work', () => {
  const { base, repo } = makeBase();
  for (const bad of ['../evil', 'Foo', 'a/b']) {
    assert.throws(() => selectWorktree(bad, deps(repo)), SlugError, bad);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('slug safety (CLI edge): select-worktree --slug ../evil -> EXIT_USAGE (no machine error escapes)', () => {
  const REPO_QUALITY = fileURLToPath(new URL('../../quality.json', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-wt-cli-'));
  fs.copyFileSync(REPO_QUALITY, path.join(dir, 'quality.json'));
  const out: string[] = [];
  const errs: string[] = [];
  const cli: CliDeps = {
    stdout: (t) => out.push(t),
    stderr: (t) => errs.push(t),
    cwd: () => dir,
    warn: () => {},
  };
  assert.equal(runCli(['select-worktree', '--slug', '../evil'], cli), EXIT_USAGE);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── base/context ───────────────────────────────────────────────────────────────

test('base/context: cwd is not a git repo -> EXIT_WRONG_STATE, no partial worktree', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-nogit-')));
  const result = selectWorktree('gamma', deps(dir));
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(fs.existsSync(fallbackWtPath(dir, 'gamma')), false, 'no worktree created');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('base/context: detached HEAD (no resolvable base) -> EXIT_WRONG_STATE, no partial worktree', () => {
  const { base, repo } = makeBase();
  git(repo, ['checkout', '--detach']);
  const result = selectWorktree('delta', deps(repo));
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(fs.existsSync(fallbackWtPath(repo, 'delta')), false, 'no worktree created');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── idempotent re-entry ────────────────────────────────────────────────────────

test('idempotent: re-running for an existing deep-review/<slug> worktree of THIS repo -> reuse, NO second worktree add', () => {
  const { base, repo } = makeBase();
  const first = selectWorktree('epsilon', deps(repo));
  assert.equal(first.exitCode, EXIT_OK);
  const wtPath = fallbackWtPath(repo, 'epsilon');

  const spy = spyOverReal();
  const second = selectWorktree('epsilon', deps(repo, { spawn: spy.spawn }));

  assert.equal(second.exitCode, EXIT_OK);
  assert.equal(second.mode, 'dedicated');
  assert.equal(second.worktree, wtPath);
  assert.equal(second.branch, 'deep-review/epsilon');
  assert.ok(
    !spy.gitCalls.some((a) => a.includes('worktree') && a.includes('add')),
    'no duplicate worktree add on re-entry',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

// ── wrong-reuse refused (incl. the S21 collision) ──────────────────────────────

test('wrong-reuse: a plain dir (not a worktree) at wtPath -> EXIT_WRONG_STATE, no mutation', () => {
  const { base, repo } = makeBase();
  const wtPath = fallbackWtPath(repo, 'zeta');
  fs.mkdirSync(wtPath, { recursive: true });
  fs.writeFileSync(path.join(wtPath, 'stray.txt'), 'hi\n');

  const result = selectWorktree('zeta', deps(repo));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(fs.existsSync(path.join(wtPath, '.git')), false, 'never turned into a worktree');
  assert.equal(fs.readFileSync(path.join(wtPath, 'stray.txt'), 'utf8'), 'hi\n', 'plain dir untouched');
  fs.rmSync(base, { recursive: true, force: true });
});

test('wrong-reuse (S21 collision): an existing worktree on feature/deep-review-<slug> at the same dir -> EXIT_WRONG_STATE, original untouched', () => {
  const { base, repo } = makeBase();
  const wtPath = fallbackWtPath(repo, 'foo');
  // Simulate the S21 collision: a workflow feature whose slug is `deep-review-foo`
  // yields a worktree at <parent>/deep-review-foo on branch feature/deep-review-foo
  // — the SAME directory selectWorktree('foo') computes.
  git(repo, ['worktree', 'add', '-b', 'feature/deep-review-foo', wtPath, 'main']);

  const result = selectWorktree('foo', deps(repo));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  // The colliding worktree is untouched: still on feature/deep-review-foo.
  assert.equal(git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/deep-review-foo');
  // The engine's branch was never created.
  assert.throws(() => git(repo, ['rev-parse', '--verify', 'refs/heads/deep-review/foo']));
  fs.rmSync(base, { recursive: true, force: true });
});

// ── confinement (unit test of the inline guard) ────────────────────────────────

test('confinement: assertUnderParent refuses an escape and allows a child', () => {
  assert.throws(() => assertUnderParent('/tmp/parent/../escape', '/tmp/parent'), /escapes/);
  assert.throws(() => assertUnderParent('/tmp/other', '/tmp/parent'), /escapes/);
  assert.doesNotThrow(() => assertUnderParent('/tmp/parent/deep-review-x', '/tmp/parent'));
  assert.doesNotThrow(() => assertUnderParent('/tmp/parent', '/tmp/parent'));
});

// ── realWorktreeDeps factory wiring ────────────────────────────────────────────

test('realWorktreeDeps projects the config workflow block + real fs/spawn seams', () => {
  const wf = enabledWorkflow('../wts', 'main');
  const d = realWorktreeDeps('/some/cwd', {
    deepReview: undefined,
    reportsDir: 'reports/quality',
    workflow: wf,
  });
  assert.equal(d.cwd, '/some/cwd');
  assert.equal(d.workflow, wf);
  assert.equal(typeof d.existsSync, 'function');
  assert.equal(typeof d.realpath, 'function');
  assert.equal(typeof d.spawn, 'function');
});
