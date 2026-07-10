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
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import {
  selectWorktree,
  assertUnderParent,
  realWorktreeDeps,
} from '../../deep-review/src/worktree.ts';
import type { WorktreeDeps, SpawnResult } from '../../deep-review/src/worktree.ts';
import { SlugError } from '../../deep-review/src/feature-slug.ts';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';

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

// A spawn seam that DELEGATES to real git for the read-only validation steps
// (rev-parse, worktree list) but forces the mutating `git worktree add` to a
// non-zero exit, so a test can drive the §2.4 git-error surface deterministically
// without depending on a host-specific way to make `worktree add` fail. Mirrors
// spyOverReal's recording shape.
function spawnFailingAdd(): { spawn: WorktreeDeps['spawn']; gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  const spawn: WorktreeDeps['spawn'] = (file, args, options) => {
    if (file === 'git') gitCalls.push([...args]);
    if (file === 'git' && args.includes('add')) {
      return { status: 1, stdout: '', stderr: 'fatal: simulated' };
    }
    const r = spawnSync(file, [...args], { cwd: options.cwd, encoding: 'utf8', shell: false });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { spawn, gitCalls };
}

function deps(
  cwd: string,
  over: { spawn?: WorktreeDeps['spawn'] } = {},
): WorktreeDeps {
  return {
    cwd,
    existsSync: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    spawn: over.spawn ?? realSpawn,
  };
}

// The parent the engine always computes: `../worktrees` off the cwd, HEAD as base.
function fallbackWtPath(cwd: string, slug: string): string {
  return path.join(path.resolve(cwd, '../worktrees'), `deep-review-${slug}`);
}

// ── dedicated (always: ../worktrees off HEAD) ──────────────────────────────────

test('dedicated: no marker -> creates branch deep-review/<slug> + worktree from HEAD base', () => {
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

test('wrong-reuse (foreign repo): a DIFFERENT repo owns a worktree at wtPath ON branch deep-review/<slug> -> step (a) passes but step (b) REFUSES (EXIT_WRONG_STATE), nothing created in THIS repo, foreign worktree untouched', () => {
  // repoA is the primary repo; repoB is a foreign repo that owns a worktree sitting
  // at the EXACT path repoA's fallback selector computes, checked out on a branch
  // literally named `deep-review/foreign`. validateExistingWorktree step (a)
  // (`git -C <wtPath> rev-parse --abbrev-ref HEAD === deep-review/foreign`) PASSES,
  // so only step (b) (`git worktree list` over THIS repo) can refuse it.
  const { base: baseA, repo: repoA } = makeBase();
  const { base: baseB, repo: repoB } = makeBase();
  const wtPath = fallbackWtPath(repoA, 'foreign');
  // repoB owns a worktree at wtPath, on branch deep-review/foreign.
  git(repoB, ['worktree', 'add', '-b', 'deep-review/foreign', wtPath, 'HEAD']);

  const worktreesBefore = git(repoA, ['worktree', 'list', '--porcelain']);
  const result = selectWorktree('foreign', deps(repoA));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  // THIS repo created no branch and no worktree.
  assert.throws(() => git(repoA, ['rev-parse', '--verify', 'refs/heads/deep-review/foreign']));
  assert.equal(git(repoA, ['worktree', 'list', '--porcelain']), worktreesBefore, 'repoA worktree set unchanged');
  // The foreign worktree is untouched: still repoB's, still on deep-review/foreign.
  assert.equal(git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'deep-review/foreign');
  fs.rmSync(baseA, { recursive: true, force: true });
  fs.rmSync(baseB, { recursive: true, force: true });
});

// ── worktree-add git error (the §2.4 machine-error surface) ─────────────────────

test('worktree-add failure: a non-zero `git worktree add` -> EXIT_FAILURE + machine error step "worktree-add" carrying the git command + stderr_tail', () => {
  const { base, repo } = makeBase();
  const spy = spawnFailingAdd();

  const result = selectWorktree('addfail', deps(repo, { spawn: spy.spawn }));

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.ok(result.machineError, 'machine error present');
  assert.equal(result.machineError?.step, 'worktree-add');
  assert.match(result.machineError?.command ?? '', /worktree add\b/);
  assert.equal(result.machineError?.stderr_tail, 'fatal: simulated');
  // The add was attempted but no worktree dir landed (the add was forced to fail).
  assert.ok(
    spy.gitCalls.some((a) => a.includes('worktree') && a.includes('add')),
    'a worktree add was attempted',
  );
  assert.equal(fs.existsSync(fallbackWtPath(repo, 'addfail')), false, 'no worktree dir created');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── the `--` argv defense ───────────────────────────────────────────────────────

test('dedicated argv: the `git worktree add` argv inserts `--` immediately before the <path> <base> operands', () => {
  const { base, repo } = makeBase();
  const spy = spyOverReal();

  const result = selectWorktree('hotel', deps(repo, { spawn: spy.spawn }));

  assert.equal(result.exitCode, EXIT_OK);
  const wtPath = fallbackWtPath(repo, 'hotel');
  const addCall = spy.gitCalls.find((a) => a.includes('worktree') && a.includes('add'));
  assert.ok(addCall, 'a worktree add happened');
  // The `--` separator must sit immediately before the two positional operands so an
  // option-like base can never be misparsed as a git option.
  assert.deepEqual(addCall, ['worktree', 'add', '-b', 'deep-review/hotel', '--', wtPath, 'main']);
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

test('realWorktreeDeps wires cwd + real fs/spawn seams', () => {
  const d = realWorktreeDeps('/some/cwd');
  assert.equal(d.cwd, '/some/cwd');
  assert.equal(typeof d.existsSync, 'function');
  assert.equal(typeof d.realpath, 'function');
  assert.equal(typeof d.spawn, 'function');
});
