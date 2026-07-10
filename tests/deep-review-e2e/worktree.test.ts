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
import { EXIT_OK, EXIT_FAILURE } from '../../deep-review/src/types.ts';
import { initConsumerRepo, runVerb, git, cleanup } from './helper.ts';

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
