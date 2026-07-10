/* Real-git e2e for the commit-slice engine + the full fix vertical (Phase 5 §5.7).
   Every case drives the real CLI through tsx-on-source against its own throwaway
   repo: real staging, real one-shot validation worktree, real trailers, real
   findings mutations. The pure gates (scope / no-touch / eligibility) are proven to
   refuse against a real dirty tree, and the red/timeout/spawn-fault paths are proven
   to leave the LIVE worktree untouched (compared by FILE BYTES, not porcelain —
   commit-slice leaves the slice STAGED, so porcelain differs while bytes do not). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT_OK,
  EXIT_FAILURE,
  EXIT_WRONG_STATE,
} from '../../deep-review/src/types.ts';
import {
  initCoreRepo,
  selectWorktree,
  readRunDescriptor,
  placeFindings,
  findingsFile,
  finding,
  findingById,
  git,
  runVerb,
  cleanup,
  writeFile,
  EDITED,
  RED_SHIM,
  TIMEOUT_SHIM,
  FINDINGS_REL,
} from './helper.ts';

/* Drives the shared prefix of the happy path: a run-worktree with a bound,
   classified findings file and the AI edit applied to src/app.ts (unstaged). */
function preparedRun(box: ReturnType<typeof initCoreRepo>): { worktree: string } {
  const worktree = selectWorktree(box.repo, box.env);
  placeFindings(worktree, findingsFile([finding()]));
  const cls = runVerb(worktree, ['classify', '--findings', FINDINGS_REL], box.env);
  assert.equal(cls.status, EXIT_OK, `classify failed: ${cls.stderr}`);
  fs.writeFileSync(path.join(worktree, 'src/app.ts'), EDITED);
  return { worktree };
}

/* A tight, bounded busy-poll for a pid becoming dead. The process-group reap runs
   SYNCHRONOUSLY inside runProcess before the verb returns, so under correct
   behavior the grandchild is already SIGKILLed by the time we read the pidfile;
   the bound only guards against a broken group-kill (which is the regression this
   asserts). No fixed sleep — it returns the instant the condition holds. */
function waitDead(pid: number, timeoutMs = 5000): boolean {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() >= end) return false;
  }
}

test('happy vertical: classify -> commit-slice (green, trailer) -> verify -> handoff', () => {
  const box = initCoreRepo();
  try {
    const { worktree } = preparedRun(box);

    const bound = findingById(worktree, 'f-001');
    assert.equal(bound?.['classification'], 'fixable-now');
    assert.equal(bound?.['status'], 'pending');
    assert.notEqual(readRunDescriptor(worktree, box.env).run_id, '');

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_OK, `commit-slice failed: ${slice.stderr}`);
    const fixed = findingById(worktree, 'f-001');
    assert.equal(fixed?.['status'], 'fixed');
    assert.notEqual(fixed?.['sha'], '');
    const headSha = git(worktree, ['rev-parse', 'HEAD'], box.env).trim();
    assert.equal(fixed?.['sha'], headSha);
    const trailer = git(worktree, ['log', '-1', '--format=%(trailers:key=Deep-Review-Slice,valueonly=true)'], box.env).trim();
    assert.equal(trailer, 'f-001');

    const ver = runVerb(worktree, ['verify', '--findings', FINDINGS_REL, '--scope', '--fast'], box.env);
    assert.equal(ver.status, EXIT_OK, `verify failed: ${ver.stderr}`);
    const record = JSON.parse(fs.readFileSync(path.join(worktree, FINDINGS_REL), 'utf8')) as { verification: { sha: string } | null };
    assert.notEqual(record.verification, null);
    assert.equal(record.verification?.sha, headSha);

    const handoff = runVerb(worktree, ['handoff', '--findings', FINDINGS_REL], box.env);
    assert.equal(handoff.status, EXIT_OK, `handoff refused: ${handoff.stderr}`);
    assert.match(handoff.stdout, /Landing mode: standalone/);
  } finally {
    cleanup(box);
  }
});

test('out-of-slice dirty -> refuse (scope gate), no commit, no findings mutation', () => {
  const box = initCoreRepo();
  try {
    const { worktree } = preparedRun(box);
    const before = git(worktree, ['rev-parse', 'HEAD'], box.env).trim();
    fs.writeFileSync(path.join(worktree, 'stray.txt'), 'out of slice\n');

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_WRONG_STATE, slice.stderr);
    assert.equal(findingById(worktree, 'f-001')?.['status'], 'pending');
    assert.equal(git(worktree, ['rev-parse', 'HEAD'], box.env).trim(), before);
  } finally {
    cleanup(box);
  }
});

test('unstaged write into a no-touch zone -> refuse (no-touch gate enforces even against a lying findings file)', () => {
  const box = initCoreRepo();
  try {
    const worktree = selectWorktree(box.repo, box.env);
    const desc = readRunDescriptor(worktree, box.env);
    /* A findings file that CLAIMS a no-touch path is fixable-now — the engine must
       refuse anyway. Pre-bound to the descriptor so the identity gate passes and the
       no-touch gate is what refuses. `.githooks/**` is a baseline no-touch zone. */
    placeFindings(
      worktree,
      findingsFile(
        [finding({ file: '.githooks/pre-commit', slice_files: ['.githooks/pre-commit'], classification: 'fixable-now', status: 'pending' })],
        { run_id: desc.run_id, base_sha: desc.base_sha },
      ),
    );
    /* An actual unstaged edit inside the no-touch zone, to model the AI having
       touched a protected path. */
    writeFile(worktree, '.githooks/pre-commit', '#!/usr/bin/env bash\necho tampered\n');

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_WRONG_STATE, slice.stderr);
    assert.equal(findingById(worktree, 'f-001')?.['status'], 'pending');
  } finally {
    cleanup(box);
  }
});

test('red test -> fix-failed; live tree AND index byte-identical (§F6: NOT left staged); tmp worktree + residue gone', () => {
  const box = initCoreRepo({ verifyShim: RED_SHIM });
  try {
    const { worktree } = preparedRun(box);
    const appPath = path.join(worktree, 'src/app.ts');
    const bytesBefore = fs.readFileSync(appPath);
    /* §F6 the index snapshot: the AI's edit is UNSTAGED before commit-slice, so a red
       refusal must restore the index and leave porcelain byte-identical (the OLD contract
       left the slice staged; F6 fixes that so a user's partial staging survives). */
    const porcelainBefore = git(worktree, ['status', '--porcelain'], box.env);

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_OK, slice.stderr);
    const rec = findingById(worktree, 'f-001');
    assert.equal(rec?.['status'], 'fix-failed');
    assert.equal(rec?.['sha'], '');

    /* §F6 the index is restored: porcelain is byte-identical to before the call AND the
       working-tree bytes are the AI's edit (never touched). */
    assert.equal(git(worktree, ['status', '--porcelain'], box.env), porcelainBefore, 'porcelain byte-identical (slice NOT left staged)');
    assert.deepEqual(fs.readFileSync(appPath), bytesBefore, 'live src/app.ts bytes must be unchanged');

    /* The one-shot validation worktree is torn down (no leaked deep-review-validate). */
    const worktrees = git(worktree, ['worktree', 'list', '--porcelain'], box.env);
    assert.equal(/deep-review-validate/.test(worktrees), false, 'validation worktree leaked');

    /* The residue the red shim writes lives ONLY in the (now-removed) tmp worktree,
       never in the live tree or the main checkout. This is exactly what a regression
       to running the test in-place would violate. */
    assert.equal(fs.existsSync(path.join(worktree, 'coverage/lcov.info')), false, 'residue leaked into run worktree');
    assert.equal(fs.existsSync(path.join(box.repo, 'coverage/lcov.info')), false, 'residue leaked into main checkout');
  } finally {
    cleanup(box);
  }
});

test('deadline timeout -> infra-blocked; the detached grandchild is group-killed', () => {
  const box = initCoreRepo({ verifyShim: TIMEOUT_SHIM, budgetSeconds: 3 });
  try {
    const { worktree } = preparedRun(box);
    const pidfile = path.join(box.root, 'grandchild.pid');

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env, { DR_E2E_PIDFILE: pidfile });
    assert.equal(slice.status, EXIT_OK, slice.stderr);
    const rec = findingById(worktree, 'f-001');
    assert.equal(rec?.['status'], 'infra-blocked');
    assert.equal(typeof rec?.['infra_error'], 'string');

    assert.equal(fs.existsSync(pidfile), true, 'timeout shim never recorded its grandchild pid');
    const pid = Number.parseInt(fs.readFileSync(pidfile, 'utf8').trim(), 10);
    assert.equal(Number.isInteger(pid) && pid > 0, true, 'invalid grandchild pid');
    /* Non-vacuity guard: waitDead must be able to return false, else the kill
       assertion below would pass regardless of the engine's behavior. This test
       process is provably alive. */
    assert.equal(waitDead(process.pid, 200), false, 'waitDead falsely reported a live process dead');
    assert.equal(waitDead(pid), true, `grandchild pid ${pid} survived the timeout (group-kill failed)`);
  } finally {
    cleanup(box);
  }
});

test('missing verify shim -> spawn fault is infra-blocked, never fix-failed', () => {
  const box = initCoreRepo({ verifyShim: null });
  try {
    const { worktree } = preparedRun(box);

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_OK, slice.stderr);
    const rec = findingById(worktree, 'f-001');
    assert.equal(rec?.['status'], 'infra-blocked');
    assert.notEqual(rec?.['status'], 'fix-failed');
    assert.equal(typeof rec?.['infra_error'], 'string');
  } finally {
    cleanup(box);
  }
});

test('crash-after-commit reconciliation: a landed slice trailer whose finding stayed pending is repaired to fixed', () => {
  const box = initCoreRepo();
  try {
    const worktree = selectWorktree(box.repo, box.env);
    const desc = readRunDescriptor(worktree, box.env);

    /* Simulate the crash window: the slice commit LANDED (trailer in the run's
       ancestry) but the findings write was lost, so the finding still reads
       pending. */
    fs.writeFileSync(path.join(worktree, 'src/app.ts'), EDITED);
    git(worktree, ['add', '--', 'src/app.ts'], box.env);
    git(worktree, ['commit', '-q', '-m', 'deep-review: apply fixable-now slice f-001\n\nDeep-Review-Slice: f-001'], box.env);
    const sliceSha = git(worktree, ['rev-parse', 'HEAD'], box.env).trim();

    placeFindings(
      worktree,
      findingsFile([finding({ classification: 'fixable-now', status: 'pending' })], { run_id: desc.run_id, base_sha: desc.base_sha }),
    );

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    /* Reconcile runs FIRST and repairs f-001 to fixed; the finding is then no longer
       eligible, so the fresh commit-slice returns EXIT_WRONG_STATE — but the
       recovery (the whole point) already happened. */
    assert.equal(slice.status, EXIT_WRONG_STATE, slice.stderr);
    const rec = findingById(worktree, 'f-001');
    assert.equal(rec?.['status'], 'fixed');
    assert.equal(rec?.['sha'], sliceSha);
  } finally {
    cleanup(box);
  }
});

test('§F6 red with an untracked new file in the slice: after refusal porcelain is byte-identical, the new file survives', () => {
  const box = initCoreRepo({ verifyShim: RED_SHIM });
  try {
    const worktree = selectWorktree(box.repo, box.env);
    const desc = readRunDescriptor(worktree, box.env);
    placeFindings(
      worktree,
      findingsFile(
        [finding({ slice_files: ['src/app.ts', 'src/added.ts'], classification: 'fixable-now', status: 'pending' })],
        { run_id: desc.run_id, base_sha: desc.base_sha },
      ),
    );
    fs.writeFileSync(path.join(worktree, 'src/app.ts'), EDITED); // tracked edit (unstaged)
    writeFile(worktree, 'src/added.ts', 'export const b = 2;\n'); // untracked new file in the slice
    const porcelainBefore = git(worktree, ['status', '--porcelain'], box.env);

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_OK, slice.stderr);
    assert.equal(findingById(worktree, 'f-001')?.['status'], 'fix-failed');
    assert.equal(git(worktree, ['status', '--porcelain'], box.env), porcelainBefore, 'porcelain byte-identical (new file force-removed from index, back to untracked)');
    assert.equal(fs.existsSync(path.join(worktree, 'src/added.ts')), true, 'the working-tree new file is never removed');
  } finally {
    cleanup(box);
  }
});

test('§F4 self-protection: a slice targeting quality.json is refused by the no-touch gate (findings unchanged)', () => {
  const box = initCoreRepo();
  try {
    const worktree = selectWorktree(box.repo, box.env);
    const desc = readRunDescriptor(worktree, box.env);
    placeFindings(
      worktree,
      findingsFile(
        [finding({ file: 'quality.json', slice_files: ['quality.json'], classification: 'fixable-now', status: 'pending' })],
        { run_id: desc.run_id, base_sha: desc.base_sha },
      ),
    );

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_WRONG_STATE, slice.stderr);
    assert.equal(findingById(worktree, 'f-001')?.['status'], 'pending', 'the engine never edits its own manifest');
  } finally {
    cleanup(box);
  }
});

test('§F4 self-protection: a slice targeting the no-touch source (.agents/project-facts.md) is refused (two-slice bypass closed)', () => {
  const box = initCoreRepo();
  try {
    const worktree = selectWorktree(box.repo, box.env);
    const desc = readRunDescriptor(worktree, box.env);
    placeFindings(
      worktree,
      findingsFile(
        [finding({ file: '.agents/project-facts.md', slice_files: ['.agents/project-facts.md'], classification: 'fixable-now', status: 'pending' })],
        { run_id: desc.run_id, base_sha: desc.base_sha },
      ),
    );

    const slice = runVerb(worktree, ['commit-slice', 'f-001', '--findings', FINDINGS_REL], box.env);
    assert.equal(slice.status, EXIT_WRONG_STATE, slice.stderr);
    assert.equal(findingById(worktree, 'f-001')?.['status'], 'pending', 'the engine never edits the file that defines what is protected');
  } finally {
    cleanup(box);
  }
});

test('§F11 no_touch_globs_ref that resolves outside the repo via a symlink -> classify FAILS closed (confinement in review-only too)', () => {
  const box = initCoreRepo({ noTouchGlobsRef: '.agents/evil-facts.md' });
  try {
    /* An ABSOLUTE symlink escaping the repo root; the target exists so realpath
       resolves it (a missing target would take the unreadable path, not the escape
       path). Committed so the run-worktree checks it out. */
    const target = path.join(box.root, 'evil-target.md');
    fs.writeFileSync(target, '## No-Touch Zones\n- `x/**`\n');
    fs.symlinkSync(target, path.join(box.repo, '.agents', 'evil-facts.md'));
    git(box.repo, ['add', '.agents/evil-facts.md'], box.env);
    git(box.repo, ['commit', '-q', '-m', 'add escaping no-touch ref'], box.env);

    const worktree = selectWorktree(box.repo, box.env);
    placeFindings(worktree, findingsFile([finding()]));
    /* §F11: classify now confines the ref in review-only too, so the escaping symlink is
       rejected HERE (fail-closed) rather than silently falling back to the baseline. */
    const cls = runVerb(worktree, ['classify', '--findings', FINDINGS_REL], box.env);
    assert.equal(cls.status, EXIT_FAILURE, cls.stderr);
    assert.match(cls.stderr, /outside the repo root/);
  } finally {
    cleanup(box);
  }
});
