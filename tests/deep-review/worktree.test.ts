// E5 + §5.2 — the worktree selector. The engine creates an engine-local
//   `git worktree add -b deep-review/<slug> -- <wtPath> <base-SHA>` FROM THE CAPTURED BASE SHA,
//   asserts the new HEAD == that SHA, wires consumer tooling, and writes the run descriptor LAST.
//   A confinement guard and a collision/idempotency gate REFUSE to reuse or overwrite a directory
//   that is not THIS repo's worktree on exactly `deep-review/<slug>` with a valid descriptor.
//
// These tests drive a REAL ephemeral git repo (real worktrees, branches, descriptors). Tooling +
// descriptor round-trip are exercised at the selectWorktree / verifyDescriptor level (no cli.ts
// import — the cli edge is validated in cli.test.ts, and importing it here would couple these to
// the Wave-2 slice/verify/handoff modules).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import {
  selectWorktree,
  assertUnderParent,
  realWorktreeDeps,
  setupWorktreeTooling,
  ToolingError,
} from '../../deep-review/src/worktree.ts';
import type { WorktreeDeps, SpawnResult } from '../../deep-review/src/worktree.ts';
import { SlugError } from '../../deep-review/src/feature-slug.ts';
import { verifyDescriptor, readDescriptor } from '../../deep-review/src/descriptor.ts';
import { createDeadline } from '../../deep-review/src/deadline.ts';

// ── Real-git fixture ──────────────────────────────────────────────────────────

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

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

const realSpawn: WorktreeDeps['spawn'] = (file, args, options): SpawnResult => {
  const r = spawnSync(file, [...args], { cwd: options.cwd, encoding: 'utf8', shell: false });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// A spawn seam that DELEGATES to real git while recording every git argv, so a test can assert
// that NO second `worktree add` happened on a reuse path (and that one DID on a fresh path).
function spyOverReal(): { spawn: WorktreeDeps['spawn']; gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  const spawn: WorktreeDeps['spawn'] = (file, args, options) => {
    if (file === 'git') gitCalls.push([...args]);
    const r = spawnSync(file, [...args], { cwd: options.cwd, encoding: 'utf8', shell: false });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { spawn, gitCalls };
}

// A spawn seam that DELEGATES to real git for reads but forces the mutating `git worktree add` to
// a non-zero exit, so a test can drive the §2.4 git-error surface deterministically.
function spawnFailingAdd(): { spawn: WorktreeDeps['spawn']; gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  const spawn: WorktreeDeps['spawn'] = (file, args, options) => {
    if (file === 'git') gitCalls.push([...args]);
    if (file === 'git' && args.includes('worktree') && args.includes('add')) {
      return { status: 1, stdout: '', stderr: 'fatal: simulated' };
    }
    const r = spawnSync(file, [...args], { cwd: options.cwd, encoding: 'utf8', shell: false });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { spawn, gitCalls };
}

function deps(cwd: string, over: Partial<WorktreeDeps> = {}): WorktreeDeps {
  return {
    cwd,
    existsSync: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    spawn: realSpawn,
    ...over,
  };
}

function fallbackWtPath(cwd: string, slug: string): string {
  return path.join(path.resolve(cwd, '../worktrees'), `deep-review-${slug}`);
}

// ── dedicated creation + descriptor round-trip ──────────────────────────────────

test('dedicated: creates branch deep-review/<slug> + worktree, then writes a valid run descriptor', () => {
  const { base, repo } = makeBase();
  const baseSha = git(repo, ['rev-parse', 'HEAD']).trim();
  const spy = spyOverReal();

  const result = selectWorktree('alpha', deps(repo, { spawn: spy.spawn }));

  const expected = fallbackWtPath(repo, 'alpha');
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.mode, 'dedicated');
  assert.equal(result.branch, 'deep-review/alpha');
  assert.equal(result.worktree, expected);
  assert.equal(fs.existsSync(expected), true, 'worktree dir created');
  assert.equal(git(expected, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'deep-review/alpha');
  assert.ok(spy.gitCalls.some((a) => a.includes('worktree') && a.includes('add')), 'a worktree add happened');

  // The descriptor is present + valid, and its git-side identity gate passes.
  const verdict = verifyDescriptor(expected);
  assert.equal(verdict.ok, true, `descriptor should verify: ${verdict.ok ? '' : verdict.reason}`);
  const descriptor = readDescriptor(expected);
  assert.ok(descriptor, 'descriptor readable');
  assert.equal(descriptor?.schema, 1);
  assert.equal(descriptor?.branch_ref, 'refs/heads/deep-review/alpha');
  assert.equal(descriptor?.base_ref, 'refs/heads/main');
  assert.equal(descriptor?.base_sha, baseSha);
  assert.equal(descriptor?.initial_head_sha, baseSha, 'initial HEAD == captured base SHA');
  assert.equal(descriptor?.canonical_root, fs.realpathSync(expected));
  fs.rmSync(base, { recursive: true, force: true });
});

test('add operand is the captured base SHA (not the mutable branch name), with `--` before the operands', () => {
  const { base, repo } = makeBase();
  const baseSha = git(repo, ['rev-parse', 'HEAD']).trim();
  const spy = spyOverReal();

  const result = selectWorktree('hotel', deps(repo, { spawn: spy.spawn }));

  assert.equal(result.exitCode, EXIT_OK);
  const wtPath = fallbackWtPath(repo, 'hotel');
  const addCall = spy.gitCalls.find((a) => a.includes('worktree') && a.includes('add'));
  assert.deepEqual(addCall, ['worktree', 'add', '-b', 'deep-review/hotel', '--', wtPath, baseSha]);
  fs.rmSync(base, { recursive: true, force: true });
});

// ── slug safety ────────────────────────────────────────────────────────────────

test('slug safety: an unsafe slug throws SlugError before any worktree work', () => {
  const { base, repo } = makeBase();
  for (const bad of ['../evil', 'Foo', 'a/b']) {
    assert.throws(() => selectWorktree(bad, deps(repo)), SlugError, bad);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

// ── base/context ─────────────────────────────────────────────────────────────

test('base/context: cwd is not a git repo -> EXIT_WRONG_STATE, no partial worktree', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-nogit-')));
  const result = selectWorktree('gamma', deps(dir));
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(fs.existsSync(fallbackWtPath(dir, 'gamma')), false, 'no worktree created');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('base/context: detached HEAD (no symbolic base) -> EXIT_WRONG_STATE, no partial worktree', () => {
  const { base, repo } = makeBase();
  git(repo, ['checkout', '--detach']);
  const result = selectWorktree('delta', deps(repo));
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(fs.existsSync(fallbackWtPath(repo, 'delta')), false, 'no worktree created');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── idempotent re-entry (descriptor present) ─────────────────────────────────

test('idempotent: re-running for an existing deep-review/<slug> worktree WITH a descriptor -> reuse, NO second add', () => {
  const { base, repo } = makeBase();
  const first = selectWorktree('epsilon', deps(repo));
  assert.equal(first.exitCode, EXIT_OK);
  const wtPath = fallbackWtPath(repo, 'epsilon');

  const spy = spyOverReal();
  const second = selectWorktree('epsilon', deps(repo, { spawn: spy.spawn }));

  assert.equal(second.exitCode, EXIT_OK);
  assert.equal(second.mode, 'dedicated');
  assert.equal(second.worktree, wtPath);
  assert.ok(
    !spy.gitCalls.some((a) => a.includes('worktree') && a.includes('add')),
    'no duplicate worktree add on re-entry',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

// ── reuse REFUSED without a descriptor (the §5.2 gate) ─────────────────────────

test('reuse refused: a worktree on our branch but WITHOUT a run descriptor (pre-v0.4.0 / aborted) -> EXIT_WRONG_STATE with a remove instruction, NO silent reuse', () => {
  const { base, repo } = makeBase();
  const wtPath = fallbackWtPath(repo, 'nodesc');
  // A raw worktree on exactly our branch, but created OUTSIDE the engine -> no descriptor file.
  git(repo, ['worktree', 'add', '-b', 'deep-review/nodesc', wtPath, 'main']);
  assert.equal(verifyDescriptor(wtPath).ok, false, 'precondition: no descriptor');

  const result = selectWorktree('nodesc', deps(repo));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.ok(result.machineError, 'a machine error explains the refusal');
  assert.match(result.machineError?.message ?? '', /descriptor|remove/i);
  fs.rmSync(base, { recursive: true, force: true });
});

// ── verifyDescriptor identity gate (the W4-consumed contract) ──────────────────

// The absolute git-dir of a worktree, where its descriptor lives.
function worktreeGitDir(wtPath: string): string {
  return git(wtPath, ['rev-parse', '--absolute-git-dir']).trim();
}

test('verifyDescriptor: a CORRUPTED descriptor file -> ok:false (never a silent pass)', () => {
  const { base, repo } = makeBase();
  const wtPath = fallbackWtPath(repo, 'corrupt');
  assert.equal(selectWorktree('corrupt', deps(repo)).exitCode, EXIT_OK);
  fs.writeFileSync(path.join(worktreeGitDir(wtPath), 'deep-review-run.json'), '{ not json');

  const verdict = verifyDescriptor(wtPath);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.match(verdict.reason, /JSON|descriptor/i);
  fs.rmSync(base, { recursive: true, force: true });
});

test('verifyDescriptor: a descriptor whose branch_ref no longer matches HEAD -> ok:false ("branch mismatch")', () => {
  const { base, repo } = makeBase();
  const wtPath = fallbackWtPath(repo, 'branchtamper');
  assert.equal(selectWorktree('branchtamper', deps(repo)).exitCode, EXIT_OK);
  // Tamper the stored branch_ref so the current HEAD (deep-review/branchtamper) no longer matches.
  const descPath = path.join(worktreeGitDir(wtPath), 'deep-review-run.json');
  const descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8')) as Record<string, unknown>;
  descriptor['branch_ref'] = 'refs/heads/some-other-branch';
  fs.writeFileSync(descPath, JSON.stringify(descriptor));

  const verdict = verifyDescriptor(wtPath);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.match(verdict.reason, /branch/i);
  fs.rmSync(base, { recursive: true, force: true });
});

// ── wrong-reuse refused (S21 collision, plain dir) ─────────────────────────────

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
  git(repo, ['worktree', 'add', '-b', 'feature/deep-review-foo', wtPath, 'main']);

  const result = selectWorktree('foo', deps(repo));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/deep-review-foo');
  assert.throws(() => git(repo, ['rev-parse', '--verify', 'refs/heads/deep-review/foo']));
  fs.rmSync(base, { recursive: true, force: true });
});

// ── worktree-add git error (the §2.4 machine-error surface) ─────────────────────

test('worktree-add failure: a non-zero `git worktree add` -> EXIT_FAILURE + machine error step "worktree-add"', () => {
  const { base, repo } = makeBase();
  const spy = spawnFailingAdd();

  const result = selectWorktree('addfail', deps(repo, { spawn: spy.spawn }));

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.machineError?.step, 'worktree-add');
  assert.match(result.machineError?.command ?? '', /worktree add\b/);
  assert.equal(result.machineError?.stderr_tail, 'fatal: simulated');
  assert.equal(fs.existsSync(fallbackWtPath(repo, 'addfail')), false, 'no worktree dir created');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── rollback after a post-add failure ──────────────────────────────────────────

test('rollback: a failure AFTER worktree add (descriptor write throws) removes the created branch + worktree', () => {
  const { base, repo } = makeBase();
  const result = selectWorktree(
    'rollme',
    deps(repo, {
      writeDescriptorFn: () => {
        throw new Error('simulated descriptor write failure');
      },
    }),
  );

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(fs.existsSync(fallbackWtPath(repo, 'rollme')), false, 'created worktree rolled back');
  assert.throws(
    () => git(repo, ['rev-parse', '--verify', 'refs/heads/deep-review/rollme']),
    'created branch rolled back',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

// ── confinement (unit test of the inline guard) ────────────────────────────────

test('confinement: assertUnderParent refuses an escape and allows a child', () => {
  assert.throws(() => assertUnderParent('/tmp/parent/../escape', '/tmp/parent'), /escapes/);
  assert.throws(() => assertUnderParent('/tmp/other', '/tmp/parent'), /escapes/);
  assert.doesNotThrow(() => assertUnderParent('/tmp/parent/deep-review-x', '/tmp/parent'));
  assert.doesNotThrow(() => assertUnderParent('/tmp/parent', '/tmp/parent'));
});

test('realWorktreeDeps wires cwd + real fs/spawn seams', () => {
  const d = realWorktreeDeps('/some/cwd');
  assert.equal(d.cwd, '/some/cwd');
  assert.equal(typeof d.existsSync, 'function');
  assert.equal(typeof d.realpath, 'function');
  assert.equal(typeof d.spawn, 'function');
});

// ── consumer worktree tooling (mocked git + fs seams) ──────────────────────────

// A mocked spawn that fakes the git reads tooling makes. §F9: consumer detection is now
// `ls-files -s -- vendor/dev-standards` (a gitlink is mode 160000). `submoduleSha` null
// simulates a repo WITHOUT the gitlink (core itself) — a SUCCESSFUL empty `ls-files`.
function toolingSpawn(submoduleSha: string | null, commonDir = '/main/.git'): WorktreeDeps['spawn'] {
  return (_file, args) => {
    const key = args.join(' ');
    if (key.includes('ls-files')) {
      return submoduleSha === null
        ? { status: 0, stdout: '', stderr: '' } // proven: no gitlink -> not a consumer
        : { status: 0, stdout: `160000 ${submoduleSha} 0\tvendor/dev-standards\n`, stderr: '' };
    }
    if (key.includes('submodule update')) return { status: 0, stdout: '', stderr: '' };
    if (key.includes('--git-common-dir')) return { status: 0, stdout: `${commonDir}\n`, stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected: ${key}` };
  };
}

function toolingDeps(submoduleSha: string | null, over: Partial<WorktreeDeps> = {}): {
  deps: WorktreeDeps;
  links: Array<[string, string]>;
} {
  const links: Array<[string, string]> = [];
  const d: WorktreeDeps = {
    cwd: '/wt',
    existsSync: () => true,
    realpath: (p) => p,
    spawn: toolingSpawn(submoduleSha),
    symlink: (target, linkPath) => links.push([target, linkPath]),
    readFileMaybe: () => null,
    ...over,
  };
  return { deps: d, links };
}

// A real-fs fixture for the COPY path of setupWorktreeTooling: a `main` checkout holding the built
// dist sources (each with its own `.built-from` stamp + bundle entrypoint, as ds-bootstrap leaves
// them) plus node_modules/.tools, and an empty worktree dir. Git reads stay MOCKED (toolingSpawn) —
// only the fs copy is real, so the immutable-snapshot + race guards run against real files.
const TOOLING_DISTS = [
  ['vendor/dev-standards/runner/dist', 'verify-runner.mjs'],
  ['vendor/dev-standards/deep-review/dist', 'deep-review-runner.mjs'],
] as const;

function makeToolingFixture(pinned: string): { root: string; main: string; wt: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-tooling-')));
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  for (const [rel, entry] of TOOLING_DISTS) {
    fs.mkdirSync(path.join(main, rel), { recursive: true });
    fs.writeFileSync(path.join(main, rel, '.built-from'), `${pinned}\n`);
    fs.writeFileSync(path.join(main, rel, entry), '/* built */\n');
  }
  fs.mkdirSync(path.join(main, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(main, '.tools'), { recursive: true });
  return { root, main, wt };
}

// deps for setupWorktreeTooling against a real-fs fixture: real fs reads + copy, but MOCKED git so
// no real submodule is needed. `--git-common-dir` -> `<main>/.git` makes mainCheckoutOf resolve to
// `<main>`. `over` layers a copyDir fault injection.
function realFsToolingDeps(fx: { main: string; wt: string }, pinned: string, over: Partial<WorktreeDeps> = {}): WorktreeDeps {
  return {
    cwd: fx.wt,
    existsSync: (p) => fs.existsSync(p),
    realpath: (p) => p,
    spawn: toolingSpawn(pinned, `${fx.main}/.git`),
    ...over,
  };
}

function captureError(run: () => void): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function tempDirsBeside(dest: string): string[] {
  const parent = path.dirname(dest);
  const prefix = `${path.basename(dest)}.tmp-`;
  return fs.existsSync(parent) ? fs.readdirSync(parent).filter((name) => name.startsWith(prefix)) : [];
}

test('tooling: a repo WITHOUT a vendor/dev-standards gitlink is a no-op (no symlinks, no throw)', () => {
  const { deps: d, links } = toolingDeps(null);
  assert.doesNotThrow(() => setupWorktreeTooling(d, '/wt'));
  assert.equal(links.length, 0, 'core repo => nothing wired');
});

test('tooling: a fresh stamp COPIES the dist dirs (immutable real snapshots) and SYMLINKS node_modules/.tools', () => {
  const pinned = 'abc123def456';
  const fx = makeToolingFixture(pinned);
  try {
    setupWorktreeTooling(realFsToolingDeps(fx, pinned), fx.wt);

    for (const [rel, entry] of TOOLING_DISTS) {
      const distPath = path.join(fx.wt, rel);
      assert.equal(fs.lstatSync(distPath).isSymbolicLink(), false, `${rel} must be a copied real dir, not a symlink`);
      assert.equal(fs.statSync(distPath).isDirectory(), true, `${rel} must be a directory`);
      assert.equal(fs.readFileSync(path.join(distPath, '.built-from'), 'utf8').trim(), pinned, `${rel} stamp copied from main`);
      assert.equal(fs.existsSync(path.join(distPath, entry)), true, `${rel} entrypoint copied from main`);
      const leftovers = fs.readdirSync(path.dirname(distPath)).filter((n) => n.includes('.tmp-'));
      assert.deepEqual(leftovers, [], `no leftover temp copy dir beside ${rel}`);
    }
    for (const rel of ['node_modules', '.tools']) {
      const link = path.join(fx.wt, rel);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${rel} must stay a symlink`);
      assert.equal(fs.existsSync(link), true, `${rel} symlink must resolve`);
    }
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

for (const [rel, entrypoint] of TOOLING_DISTS) {
  test(`tooling: ${rel} same-pin invalid-UTF-8 bundle mutation -> concurrent ToolingError, no published/temp dist`, () => {
    const pinned = 'abc123def456';
    const fx = makeToolingFixture(pinned);
    const sourceDist = path.join(fx.main, rel);
    const sourceBundle = path.join(sourceDist, entrypoint);
    const destinationDist = path.join(fx.wt, rel);
    let mutationRan = false;
    try {
      fs.writeFileSync(sourceBundle, Buffer.from([0x2f, 0x2a, 0x20, 0x80, 0x20, 0x2a, 0x2f, 0x0a]));
      const error = captureError(() =>
        setupWorktreeTooling(
          realFsToolingDeps(fx, pinned, {
            copyDir: (src, dest) => {
              fs.cpSync(src, dest, { recursive: true });
              if (src !== sourceDist) return;
              const bytes = fs.readFileSync(sourceBundle);
              const byteIndex = bytes.indexOf(0x80);
              if (byteIndex === -1) throw new Error('invalid UTF-8 mutation byte missing');
              bytes[byteIndex] = 0x81;
              fs.writeFileSync(sourceBundle, bytes);
              mutationRan = true;
            },
          }),
          fx.wt,
        ),
      );

      assert.deepEqual(
        {
          mutationRan,
          concurrentContentError:
            error instanceof ToolingError && /concurrent/i.test(error.message) && /content mismatch/i.test(error.message),
          sourceStamp: fs.readFileSync(path.join(sourceDist, '.built-from'), 'utf8').trim(),
          destinationExists: fs.existsSync(destinationDist),
          tempDirs: tempDirsBeside(destinationDist),
        },
        {
          mutationRan: true,
          concurrentContentError: true,
          sourceStamp: pinned,
          destinationExists: false,
          tempDirs: [],
        },
      );
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
}

test('tooling: source removal during the post-copy hash fails closed as a concurrent bootstrap', () => {
  const pinned = 'abc123def456';
  const fx = makeToolingFixture(pinned);
  const [rel, entrypoint] = TOOLING_DISTS[0];
  const sourceDist = path.join(fx.main, rel);
  const destinationDist = path.join(fx.wt, rel);
  let sourceRemoved = false;
  try {
    const error = captureError(() =>
      setupWorktreeTooling(
        realFsToolingDeps(fx, pinned, {
          existsSync: (p) => {
            const exists = fs.existsSync(p);
            if (!sourceRemoved && p.startsWith(`${destinationDist}.tmp-`) && path.basename(p) === entrypoint) {
              fs.rmSync(sourceDist, { recursive: true, force: true });
              sourceRemoved = true;
            }
            return exists;
          },
        }),
        fx.wt,
      ),
    );

    assert.deepEqual(
      {
        sourceRemoved,
        concurrentContentError:
          error instanceof ToolingError && /concurrent/i.test(error.message) && /content mismatch/i.test(error.message),
        destinationExists: fs.existsSync(destinationDist),
        tempDirs: tempDirsBeside(destinationDist),
      },
      {
        sourceRemoved: true,
        concurrentContentError: true,
        destinationExists: false,
        tempDirs: [],
      },
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

for (const fault of ['copy', 'rename'] as const) {
  test(`tooling: a throwing ${fault} leaves no .tmp-* snapshot`, () => {
    const pinned = 'abc123def456';
    const fx = makeToolingFixture(pinned);
    const [rel] = TOOLING_DISTS[0];
    const sourceDist = path.join(fx.main, rel);
    const destinationDist = path.join(fx.wt, rel);
    try {
      if (fault === 'rename') {
        fs.mkdirSync(path.dirname(destinationDist), { recursive: true });
        fs.writeFileSync(destinationDist, 'occupied');
      }
      const error = captureError(() =>
        setupWorktreeTooling(
          realFsToolingDeps(fx, pinned, {
            copyDir: (src, dest) => {
              fs.cpSync(src, dest, { recursive: true });
              if (fault === 'copy' && src === sourceDist) throw new Error('injected copy failure');
            },
          }),
          fx.wt,
        ),
      );

      assert.deepEqual(
        { threw: error instanceof Error, tempDirs: tempDirsBeside(destinationDist) },
        { threw: true, tempDirs: [] },
      );
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
}

test('tooling: a concurrent re-bootstrap changing the SOURCE stamp mid-copy -> ToolingError, no dist at the destination (temp cleaned up)', () => {
  const pinned = 'abc123def456';
  const fx = makeToolingFixture(pinned);
  const runnerDist = path.join(fx.wt, 'vendor/dev-standards/runner/dist');
  const copiedFrom: string[] = [];
  try {
    // Copy for real, then simulate a concurrent ds-bootstrap rebuilding main at a DIFFERENT pin:
    // the SOURCE stamp changes between the pre-copy gate and the post-copy re-read.
    const deps = realFsToolingDeps(fx, pinned, {
      copyDir: (src, dest) => {
        copiedFrom.push(src);
        fs.cpSync(src, dest, { recursive: true });
        fs.writeFileSync(path.join(fx.main, 'vendor/dev-standards/runner/dist/.built-from'), 'deadbeefdeadbeef\n');
      },
    });

    // `concurrent` is unique to snapshotDist's post-copy race guard (the before-copy gate says
    // "run scripts/ds-bootstrap.sh") — matching it proves the fault fired at the intended site.
    assert.throws(
      () => setupWorktreeTooling(deps, fx.wt),
      (error: unknown) => error instanceof ToolingError && /concurrent/i.test((error as Error).message),
    );
    assert.ok(
      copiedFrom.includes(path.join(fx.main, 'vendor/dev-standards/runner/dist')),
      'the copy seam ran for runner/dist (the fault landed at the copy site, not before it)',
    );

    assert.equal(fs.existsSync(runnerDist), false, 'no dist dir left at the destination');
    const parent = path.dirname(runnerDist);
    const leftovers = fs.existsSync(parent) ? fs.readdirSync(parent).filter((n) => n.includes('.tmp-')) : [];
    assert.deepEqual(leftovers, [], 'temp copy dir cleaned up');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('tooling: a STALE stamp (main built a different submodule SHA) -> ToolingError, no symlinks, bootstrap instruction', () => {
  const { deps: d, links } = toolingDeps('abc123', {
    readFileMaybe: () => 'deadbeef\n', // main was built from a different pin
  });

  assert.throws(
    () => setupWorktreeTooling(d, '/wt'),
    (error: unknown) => error instanceof ToolingError && /bootstrap/i.test((error as Error).message),
  );
  assert.equal(links.length, 0, 'no symlinks created on a stale stamp');
});

// ── §F9 consumer detection fails CLOSED ─────────────────────────────────────────

test('F9: a consumer-detection git failure fails CLOSED -> EXIT_FAILURE machine error, worktree rolled back', () => {
  const { base, repo } = makeBase();
  // Delegate to real git, but force the vendor/dev-standards consumer-detection ls-files to fail —
  // it must NOT collapse to "core repo" (null); it must surface as a machine error.
  const spawn: WorktreeDeps['spawn'] = (file, args, options) => {
    if (file === 'git' && args.includes('ls-files') && args.includes('vendor/dev-standards')) {
      return { status: 1, stdout: '', stderr: 'fatal: simulated ls-files failure' };
    }
    const r = spawnSync(file, [...args], { cwd: options.cwd, encoding: 'utf8', shell: false });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  const result = selectWorktree('f9detect', deps(repo, { spawn }));

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.machineError?.step, 'consumer-detect');
  assert.equal(fs.existsSync(fallbackWtPath(repo, 'f9detect')), false, 'the half-set-up worktree is rolled back (no descriptor)');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── §F7 descriptor git spawns are deadline-bounded ──────────────────────────────

test('F7: verifyDescriptor bounds every git spawn with a deadline-derived timeout (<= 15s)', () => {
  const timeouts: Array<number | undefined> = [];
  const descriptor = {
    schema: 1,
    run_id: 'r',
    created_at: 't',
    canonical_root: '/wt',
    git_dir: '/wt/.git',
    git_common_dir: '/wt/.git',
    branch_ref: 'refs/heads/deep-review/x',
    base_ref: 'refs/heads/main',
    base_sha: 'b',
    initial_head_sha: 'h0',
  };
  const git = (args: string[], _cwd: string, timeout?: number) => {
    timeouts.push(timeout);
    const key = args.join(' ');
    if (key.includes('--absolute-git-dir')) return { status: 0, stdout: '/wt/.git\n', stderr: '' };
    if (key.includes('--git-common-dir')) return { status: 0, stdout: '/wt/.git\n', stderr: '' };
    if (key.includes('--show-toplevel')) return { status: 0, stdout: '/wt\n', stderr: '' };
    if (key.includes('symbolic-ref')) return { status: 0, stdout: 'refs/heads/deep-review/x\n', stderr: '' };
    if (key.includes('merge-base')) return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected ${key}` };
  };

  const verdict = verifyDescriptor('/wt', {
    git,
    readFile: () => JSON.stringify(descriptor),
    exists: () => true,
    realpath: (p) => p,
    deadline: createDeadline(900),
  });

  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason);
  assert.ok(timeouts.length > 0, 'git spawns happened');
  for (const t of timeouts) {
    assert.equal(typeof t, 'number', 'each git spawn is timeout-bounded');
    assert.ok((t as number) > 0 && (t as number) <= 15_000, 'timeout within the 15s cap');
  }
});

// ── §G4 the reuse path threads the run deadline into verifyDescriptor ────────────

test('G4: the REUSE path threads the run deadline into verifyDescriptor so its git spawns are timeout-bounded', () => {
  const { base, repo } = makeBase();
  assert.equal(selectWorktree('reusedl', deps(repo)).exitCode, EXIT_OK);

  const deadline = createDeadline(900);
  let seenDeadline: unknown = 'unset';
  const second = selectWorktree(
    'reusedl',
    deps(repo, {
      deadline,
      verifyDescriptorFn: (p, over) => {
        seenDeadline = over?.deadline;
        return verifyDescriptor(p, over); // delegate to the real gate WITH the threaded deadline
      },
    }),
  );

  assert.equal(second.exitCode, EXIT_OK, 'reuse succeeds');
  assert.equal(seenDeadline, deadline, 'the run deadline reaches verifyDescriptor on the reuse path (bounds its git reads)');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── §G5 rollback failures are surfaced, not silently swallowed ───────────────────

// A spawn seam that delegates to real git for everything EXCEPT `git worktree remove`, forced to a
// non-zero exit so a rollback-cleanup failure can be driven deterministically.
function spawnFailingRemove(): WorktreeDeps['spawn'] {
  return (file, args, options) => {
    if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
      return { status: 1, stdout: '', stderr: 'fatal: cannot remove worktree' };
    }
    const r = spawnSync(file, [...args], { cwd: options.cwd, encoding: 'utf8', shell: false });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

test('G5: a rollback spawn failure is surfaced in the machine error (rollback incomplete), not silently swallowed', () => {
  const { base, repo } = makeBase();
  const result = selectWorktree(
    'g5roll',
    deps(repo, {
      spawn: spawnFailingRemove(),
      writeDescriptorFn: () => {
        throw new Error('simulated descriptor write failure');
      },
    }),
  );

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.match(result.machineError?.message ?? '', /rollback incomplete/);
  assert.match(result.machineError?.message ?? '', /worktree remove failed/);
  fs.rmSync(base, { recursive: true, force: true });
});
