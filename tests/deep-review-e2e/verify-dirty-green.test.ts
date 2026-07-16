/* Real-git e2e for BUG-01 (2026-07-16): a green verification stamp must never certify a
   dirty-then-restored HEAD. The attack the doc describes: HEAD fails verify, so the fixer
   dirties the worktree with an UNCOMMITTED change that makes the shim pass, lets verify stamp a
   green bound to the (clean) HEAD sha, then `git restore`s the tree — leaving a clean worktree
   whose sha matches a green stamp, which handoff would wave through. The fix refuses the green
   stamp on a dirty tree, so handoff stays blocked.

   Drives the real CLI (tsx on source) end-to-end against a throwaway repo. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_OK, EXIT_NEEDS_HUMAN, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import {
  initCoreRepo,
  selectWorktree,
  readRunDescriptor,
  placeFindings,
  findingsFile,
  git,
  runVerb,
  cleanup,
  FINDINGS_REL,
} from './helper.ts';

/* A verify shim that is RED on the committed HEAD (src/app.ts carries no PASS_MARKER) and GREEN
   ONLY when an uncommitted PASS_MARKER is present — i.e. HEAD fails verify but a dirty tree passes
   it, which is exactly the state BUG-01 exploits. */
const MARKER_SHIM = '#!/usr/bin/env bash\ngrep -q PASS_MARKER src/app.ts && exit 0\nexit 1\n';

/* The `verification` field of the on-disk findings file (null when no green stamp is recorded). */
function readVerification(worktree: string): unknown {
  const raw = fs.readFileSync(path.join(worktree, FINDINGS_REL), 'utf8');
  return (JSON.parse(raw) as { verification: unknown }).verification;
}

test('BUG-01 dirty green -> restore -> handoff must fail (a green stamp never certifies a dirty-then-restored HEAD)', () => {
  const box = initCoreRepo({ verifyShim: MARKER_SHIM });
  try {
    const worktree = selectWorktree(box.repo, box.env);
    const desc = readRunDescriptor(worktree, box.env);
    const headSha = git(worktree, ['rev-parse', 'HEAD'], box.env).trim();
    const appPath = path.join(worktree, 'src/app.ts');
    const committed = fs.readFileSync(appPath, 'utf8');

    /* A run complete on every axis EXCEPT verification: no blocking findings and a clean
       self-review bound to HEAD, with verification still null. So the ONLY thing that could
       unblock handoff is a green verify stamp. */
    placeFindings(
      worktree,
      findingsFile([], {
        run_id: desc.run_id,
        base_sha: desc.base_sha,
        self_review: { sha: headSha, verdict: 'clean', noted_at: '2026-07-16T00:00:00Z' },
        verification: null,
      }),
    );

    /* Premise: the actual (clean) HEAD does NOT pass verify — a red verdict, no stamp. */
    const onHead = runVerb(worktree, ['verify', '--findings', FINDINGS_REL, '--scope', '--fast'], box.env);
    assert.equal(onHead.status, EXIT_NEEDS_HUMAN, `verify on the clean HEAD should be red: ${onHead.stderr}`);
    assert.equal(readVerification(worktree), null, 'a red verify writes no stamp');

    /* The attack: an UNCOMMITTED edit makes the shim pass while the tree is dirty. */
    fs.writeFileSync(appPath, `${committed}// PASS_MARKER\n`);
    assert.notEqual(git(worktree, ['status', '--porcelain'], box.env).trim(), '', 'the tree is dirty');
    const onDirty = runVerb(worktree, ['verify', '--findings', FINDINGS_REL, '--scope', '--fast'], box.env);
    assert.notEqual(onDirty.status, EXIT_OK, 'verify must NOT go green on a dirty tree');
    assert.match(onDirty.stderr, /uncommitted non-tooling changes/);
    assert.equal(readVerification(worktree), null, 'no stamp is written for a dirty-tree verify');

    /* Restore the tree to HEAD -> clean again (the "then restored" half of the exploit). */
    git(worktree, ['checkout', '--', 'src/app.ts'], box.env);
    assert.equal(git(worktree, ['status', '--porcelain'], box.env).trim(), '', 'the tree is clean after restore');
    assert.equal(readVerification(worktree), null, 'restoring the tree cannot conjure a stamp');

    /* Handoff must REFUSE: HEAD never passed verify, so there is no usable verification on record. */
    const handoff = runVerb(worktree, ['handoff', '--findings', FINDINGS_REL], box.env);
    assert.equal(handoff.status, EXIT_WRONG_STATE, `handoff must refuse without a verification: ${handoff.stdout}${handoff.stderr}`);
    assert.match(handoff.stderr, /no verification on record/);
  } finally {
    cleanup(box);
  }
});
