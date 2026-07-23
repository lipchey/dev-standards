/* Real-git e2e for the consumer-worktree tooling of select-worktree (Phase 5 §5.2).
   A real gitlink submodule (added over file://) drives setupWorktreeTooling: the
   worktree's own `submodule update --init` runs for real, and the build-stamp gate
   decides between wiring the main checkout's tooling (fresh stamp) and refusing
   loudly (stale stamp). This is the one case that needs a genuine submodule + the
   `protocol.file.allow=always` isolation git >=2.38 requires. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import { initConsumerRepo, runVerb, git, cleanup, readRunDescriptor } from './helper.ts';

const COPY_TARGETS = [
  ['vendor/dev-standards/runner/dist', 'verify-runner.mjs'],
  ['vendor/dev-standards/deep-review/dist', 'deep-review-runner.mjs'],
] as const;
const REAL_DIRECTORY_TARGETS = ['node_modules'];
const SYMLINK_TARGETS = ['.tools'];

test('consumer worktree, fresh build stamp -> submodule initialized + dist copied / tooling symlinked, descriptor written', () => {
  const box = initConsumerRepo({ stampFresh: true });
  try {
    const res = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(res.status, EXIT_OK, res.stderr);
    const wt = box.worktreePath;

    /* The submodule was checked out in the worktree (a real file-protocol clone). */
    assert.equal(fs.existsSync(path.join(wt, 'vendor/dev-standards/.git')), true, 'submodule not initialized in worktree');

    /* The dist dirs are COPIED real directories (immutable snapshots), NOT symlinks — a symlink
       would let a concurrent main-checkout re-bootstrap swap the engine mid-run. */
    for (const [rel, entry] of COPY_TARGETS) {
      const distPath = path.join(wt, rel);
      assert.equal(fs.lstatSync(distPath).isSymbolicLink(), false, `${rel} must be a copied real dir, not a symlink`);
      assert.equal(fs.statSync(distPath).isDirectory(), true, `${rel} must be a directory`);
      assert.equal(fs.existsSync(path.join(distPath, entry)), true, `${rel} bundle entrypoint not copied from main`);
      /* The immutable-snapshot temp dir must have been renamed away, not left behind. */
      const leftovers = fs.readdirSync(path.dirname(distPath)).filter((n) => n.includes('.tmp-'));
      assert.deepEqual(leftovers, [], `leftover temp copy dir beside ${rel}`);
    }
    /* The copied stamp came from the main checkout (== the pinned submodule SHA). */
    assert.equal(
      fs.readFileSync(path.join(wt, 'vendor/dev-standards/runner/dist/.built-from'), 'utf8').trim(),
      box.pinnedSha,
      'copied runner/dist stamp != pinned submodule SHA',
    );

    for (const rel of REAL_DIRECTORY_TARGETS) {
      const directory = path.join(wt, rel);
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false, `${rel} must not be a symlink`);
      assert.equal(fs.statSync(directory).isDirectory(), true, `${rel} must be a directory`);
    }
    for (const rel of SYMLINK_TARGETS) {
      const link = path.join(wt, rel);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${rel} is not a symlink`);
      assert.equal(fs.existsSync(link), true, `${rel} symlink does not resolve`);
    }

    /* The descriptor (the "worktree ready" marker) landed at the worktree's git-dir. */
    const gitDir = git(wt, ['rev-parse', '--absolute-git-dir'], box.env).trim();
    assert.equal(fs.existsSync(path.join(gitDir, 'deep-review-run.json')), true, 'run descriptor not written');
  } finally {
    cleanup(box);
  }
});

test('non-Node consumer worktree: create then REUSE with a real node_modules mirror', () => {
  /* initConsumerRepo models a non-Node consumer: an empty node_modules/ (only .keep)
     and NO package-lock.json. ds-bootstrap.sh `mkdir -p node_modules` for such repos so
     the unconditional shallow mirror has a source — this guards create and reuse. */
  const box = initConsumerRepo({ stampFresh: true });
  try {
    /* Fixture really is non-Node: empty node_modules, no lockfile. */
    assert.equal(fs.existsSync(path.join(box.repo, 'package-lock.json')), false, 'fixture unexpectedly has a lockfile');

    const first = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(first.status, EXIT_OK, first.stderr);
    const wt = box.worktreePath;

    const nodeModules = path.join(wt, 'node_modules');
    assert.equal(fs.lstatSync(nodeModules).isSymbolicLink(), false, 'node_modules must not be a symlink');
    assert.equal(fs.statSync(nodeModules).isDirectory(), true, 'node_modules must be a directory');
    assert.equal(fs.existsSync(path.join(nodeModules, '.keep')), true, 'node_modules mirror does not resolve on create');
    /* The descriptor's run_id is the reuse discriminator: reuse validates and keeps it, whereas a
       silent remove-and-recreate at the same path/branch would mint a fresh run_id (worktree.ts
       writes the descriptor only on create). Capture it to prove the 2nd run truly reuses. */
    const runIdAfterCreate = readRunDescriptor(wt, box.env).run_id;

    const second = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(second.status, EXIT_OK, second.stderr || second.stdout);
    assert.equal(second.stdout.trim(), first.stdout.trim(), 'reuse returned a different worktree/branch');
    assert.match(second.stdout.trim(), /^dedicated /);
    assert.equal(readRunDescriptor(wt, box.env).run_id, runIdAfterCreate, 'run_id changed — worktree was recreated, not reused');

    const branchLines = git(box.repo, ['worktree', 'list', '--porcelain'], box.env)
      .split('\n')
      .filter((l) => l === `branch refs/heads/${box.branch}`);
    assert.equal(branchLines.length, 1, 'reuse created a second worktree for the branch');
    assert.equal(fs.existsSync(path.join(nodeModules, '.keep')), true, 'node_modules mirror broke on reuse');

    /* The pre-mirror engine's root symlink must force a re-wire instead of being silently reused. */
    fs.rmSync(nodeModules, { recursive: true, force: true });
    fs.symlinkSync(path.join(box.repo, 'node_modules'), nodeModules);
    const third = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(third.status, EXIT_WRONG_STATE, `symlinked node_modules must refuse reuse; got status=${third.status} stdout=${third.stdout}`);
    assert.match(third.stderr, /stale tooling/);
  } finally {
    cleanup(box);
  }
});

test('consumer worktree: a copied dist is immune to a concurrent main-checkout re-bootstrap (stamp mutation)', () => {
  const box = initConsumerRepo({ stampFresh: true });
  try {
    assert.equal(runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env).status, EXIT_OK);
    const copiedStamp = path.join(box.worktreePath, 'vendor/dev-standards/runner/dist/.built-from');
    assert.equal(fs.readFileSync(copiedStamp, 'utf8').trim(), box.pinnedSha, 'copied stamp != pin right after setup');

    /* Simulate a concurrent re-bootstrap in the MAIN checkout at a different pin: it rewrites the
       main's stamp + dist. The worktree's COPIED stamp is an immutable snapshot, so it must NOT
       change — this is exactly what the old symlink broke (it made the worktree's verify preflight
       read the main's mutated stamp mid-run and exit 127). */
    fs.writeFileSync(
      path.join(box.repo, 'vendor/dev-standards/runner/dist/.built-from'),
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
    );
    assert.equal(fs.readFileSync(copiedStamp, 'utf8').trim(), box.pinnedSha, 'copied stamp changed with the main checkout');
  } finally {
    cleanup(box);
  }
});

test('consumer worktree reuse: a SYMLINKED dist (left by the pre-copy engine) is refused as stale tooling', () => {
  const box = initConsumerRepo({ stampFresh: true });
  try {
    assert.equal(runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env).status, EXIT_OK);
    const dist = path.join(box.worktreePath, 'vendor/dev-standards/runner/dist');
    /* Replace the copied dist with a symlink into the main checkout — exactly the tooling the
       pre-copy engine wired, which the race made unsafe. Reuse must now refuse it. */
    fs.rmSync(dist, { recursive: true, force: true });
    fs.symlinkSync(path.join(box.repo, 'vendor/dev-standards/runner/dist'), dist);

    const res = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(res.status, EXIT_WRONG_STATE, res.stdout || res.stderr);
    assert.match(res.stderr, /stale tooling/);
  } finally {
    cleanup(box);
  }
});

test('consumer worktree reuse: a gutted dist (empty dir, no bundle/stamp) is refused as stale tooling', () => {
  const box = initConsumerRepo({ stampFresh: true });
  try {
    assert.equal(runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env).status, EXIT_OK);
    const dist = path.join(box.worktreePath, 'vendor/dev-standards/runner/dist');
    /* Gut the snapshot: a real dir that exists but carries neither the bundle entrypoint nor a
       stamp must be refused at reuse instead of surfacing later as a confusing verify exit 127. */
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });

    const res = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(res.status, EXIT_WRONG_STATE, res.stdout || res.stderr);
    assert.match(res.stderr, /stale tooling/);
  } finally {
    cleanup(box);
  }
});

test('consumer worktree, STALE build stamp -> loud failure with bootstrap instruction + rollback', () => {
  const box = initConsumerRepo({ stampFresh: false });
  try {
    const res = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(res.status, EXIT_FAILURE, res.stdout || res.stderr);
    assert.match(res.stderr, /ds-bootstrap\.sh/);

    /* Rollback: the half-set-up worktree + its branch must not survive. */
    assert.equal(fs.existsSync(box.worktreePath), false, 'stale-stamp worktree was not rolled back');
    assert.equal(git(box.repo, ['branch', '--list', box.branch], box.env).trim(), '', 'engine branch was not rolled back');
  } finally {
    cleanup(box);
  }
});
