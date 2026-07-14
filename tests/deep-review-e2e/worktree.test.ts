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

const SYMLINK_TARGETS = [
  'vendor/dev-standards/runner/dist',
  'vendor/dev-standards/deep-review/dist',
  'node_modules',
  '.tools',
];

test('consumer worktree, fresh build stamp -> submodule initialized + tooling symlinked, descriptor written', () => {
  const box = initConsumerRepo({ stampFresh: true });
  try {
    const res = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(res.status, EXIT_OK, res.stderr);
    const wt = box.worktreePath;

    /* The submodule was checked out in the worktree (a real file-protocol clone). */
    assert.equal(fs.existsSync(path.join(wt, 'vendor/dev-standards/.git')), true, 'submodule not initialized in worktree');

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

test('non-Node consumer worktree: create then REUSE (node_modules symlink resolves both runs)', () => {
  /* initConsumerRepo models a non-Node consumer: an empty node_modules/ (only .keep)
     and NO package-lock.json. ds-bootstrap.sh `mkdir -p node_modules` for such repos so
     worktree.ts's UNCONDITIONAL node_modules symlink resolves — this test guards that
     contract across BOTH create and reuse (toolingAlive re-checks every symlink target). */
  const box = initConsumerRepo({ stampFresh: true });
  try {
    /* Fixture really is non-Node: empty node_modules, no lockfile. */
    assert.equal(fs.existsSync(path.join(box.repo, 'package-lock.json')), false, 'fixture unexpectedly has a lockfile');

    const first = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(first.status, EXIT_OK, first.stderr);
    const wt = box.worktreePath;

    const nodeModules = path.join(wt, 'node_modules');
    assert.equal(fs.lstatSync(nodeModules).isSymbolicLink(), true, 'node_modules is not a symlink');
    assert.equal(fs.existsSync(nodeModules), true, 'node_modules symlink does not resolve on create');
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
    assert.equal(fs.existsSync(nodeModules), true, 'node_modules symlink broke on reuse');

    /* Negative sensitivity check: without this, the reuse asserts would stay green even if
       toolingAlive stopped requiring node_modules. Break the symlink target in the main
       checkout and confirm a THIRD run REFUSES (EXIT_WRONG_STATE + stale-tooling message) —
       i.e. the non-Node node_modules contract is genuinely enforced on the reuse path. */
    fs.rmSync(path.join(box.repo, 'node_modules'), { recursive: true, force: true });
    const third = runVerb(box.repo, ['select-worktree', '--slug', 'e2e'], box.env);
    assert.equal(third.status, EXIT_WRONG_STATE, `dangling node_modules must refuse reuse; got status=${third.status} stdout=${third.stdout}`);
    assert.match(third.stderr, /stale tooling/);
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
