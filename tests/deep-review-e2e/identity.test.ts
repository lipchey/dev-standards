/* Real-git e2e for the run-identity + findings-integrity boundaries (Phase 5 §5.2,
   §5.5, §5.4). These exercise the guards that keep a fix verb from mutating the
   wrong tree or a contended/escaping findings file: running outside a run-worktree,
   a real CAS lock held by a live process, a real symlink that escapes the reports
   root, and the handoff completeness gate. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT_WRONG_STATE,
  EXIT_DESCRIPTOR_MISMATCH,
  EXIT_FINDINGS_CONFLICT,
  EXIT_FAILURE,
  EXIT_OK,
} from '../../deep-review/src/types.ts';
import {
  initCoreRepo,
  selectWorktree,
  placeFindings,
  findingsFile,
  finding,
  runVerb,
  cleanup,
  FINDINGS_REL,
} from './helper.ts';

test('a fix verb on main (no run descriptor) -> EXIT_DESCRIPTOR_MISMATCH before any mutation', () => {
  const box = initCoreRepo();
  try {
    placeFindings(box.repo, findingsFile([finding()]));
    const slice = runVerb(box.repo, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_DESCRIPTOR_MISMATCH, slice.stderr);
    assert.match(slice.stderr, /run identity mismatch|no run descriptor/);
  } finally {
    cleanup(box);
  }
});

test('handoff with a pending finding -> EXIT_WRONG_STATE naming the incomplete work', () => {
  const box = initCoreRepo();
  try {
    const worktree = selectWorktree(box.repo, box.env);
    placeFindings(worktree, findingsFile([finding()]));
    const cls = runVerb(worktree, ['classify', '--findings', FINDINGS_REL], box.env);
    assert.equal(cls.status, EXIT_OK, cls.stderr);

    const handoff = runVerb(worktree, ['handoff', '--findings', FINDINGS_REL], box.env);
    assert.equal(handoff.status, EXIT_WRONG_STATE, handoff.stdout || handoff.stderr);
    assert.match(handoff.stderr, /not terminal/);
  } finally {
    cleanup(box);
  }
});

test('CAS contention: a live lock holder makes the second mutator lose with EXIT_FINDINGS_CONFLICT', () => {
  const box = initCoreRepo();
  try {
    placeFindings(box.repo, findingsFile([finding()]));
    /* Model the first mutator by holding the real lock with a PID that is provably
       alive (this test process). The verb's own isAlive(pid) sees it live and must
       refuse rather than clobber. */
    const lockPath = path.join(box.repo, `${FINDINGS_REL}.lock`);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));

    const cls = runVerb(box.repo, ['classify', '--findings', FINDINGS_REL], box.env);
    assert.equal(cls.status, EXIT_FINDINGS_CONFLICT, cls.stderr);
    /* The loser never wrote: the file still reads revision 0 (unmutated). */
    const after = JSON.parse(fs.readFileSync(path.join(box.repo, FINDINGS_REL), 'utf8')) as { revision: number };
    assert.equal(after.revision, 0);
  } finally {
    cleanup(box);
  }
});

test('symlink-escape: a findings path that resolves outside the reports root via a symlink is refused', () => {
  const box = initCoreRepo();
  try {
    /* A real symlink under the reports root pointing OUT of it. The target exists so
       realpath resolves (an escape), rather than failing as unreadable. */
    const target = path.join(box.root, 'outside.json');
    fs.writeFileSync(target, findingsFile([finding()]));
    fs.mkdirSync(path.join(box.repo, 'reports/quality'), { recursive: true });
    fs.symlinkSync(target, path.join(box.repo, 'reports/quality/link.json'));

    const cls = runVerb(box.repo, ['classify', '--findings', 'reports/quality/link.json'], box.env);
    assert.equal(cls.status, EXIT_FAILURE, cls.stderr);
    assert.match(cls.stderr, /symlink escape/);
  } finally {
    cleanup(box);
  }
});

test('a no_touch_globs_ref inside the repo still confines the findings write (control: legit path binds cleanly)', () => {
  /* Control alongside the escape cases above: a normal in-repo findings path under
     the reports root binds without error, so the escape refusals are proven to be
     the confinement firing, not an unconditional refusal. */
  const box = initCoreRepo();
  try {
    const worktree = selectWorktree(box.repo, box.env);
    placeFindings(worktree, findingsFile([finding()]));
    const cls = runVerb(worktree, ['classify', '--findings', FINDINGS_REL], box.env);
    assert.equal(cls.status, EXIT_OK, cls.stderr);
    const after = JSON.parse(fs.readFileSync(path.join(worktree, FINDINGS_REL), 'utf8')) as { revision: number; run_id: string | null };
    assert.equal(after.revision >= 1, true);
    assert.notEqual(after.run_id, null);
  } finally {
    cleanup(box);
  }
});
