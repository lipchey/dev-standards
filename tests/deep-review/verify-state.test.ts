// BUG-01 / BUG-02 (2026-07-16) — verification-state invariants of runFinalVerify.
//
// BUG-01: a green stamp must NOT be written when the worktree is dirty with non-tooling work
// (the shim would certify uncommitted changes, not the committed HEAD the stamp binds to), nor
// when HEAD / status changed across the run.
// BUG-02: every attempt invalidates any PRIOR green stamp before the shim runs, so a later
// red / timeout / signal / post-verify HEAD-read failure leaves NO usable green for handoff.
//
// These are pure runFinalVerify cases with an injected spawn (shim + git HEAD), an injected
// `getStatus` (porcelain), and a mutate capture that records each written `verification` value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFinalVerify } from '../../deep-review/src/verify.ts';
import type { SpawnResult, VerifyDeps } from '../../deep-review/src/verify.ts';
import { EXIT_OK, EXIT_FAILURE, EXIT_NEEDS_HUMAN } from '../../deep-review/src/types.ts';
import type { FindingsFileV2, VerificationRecord } from '../../deep-review/src/types.ts';
import { createDeadline } from '../../deep-review/src/deadline.ts';

const WORKTREE = '/work/tree';
const HEAD_SHA = 'a'.repeat(40);
const NOW = '2026-07-16T12:00:00Z';
// A stale prior stamp (a DIFFERENT sha than HEAD) so its survival past a later attempt is visible.
const PRIOR_STAMP: VerificationRecord = { sha: 'b'.repeat(40), scope: 'verify:fast', completed_at: '2026-07-15T00:00:00Z' };
const GREEN_STAMP: VerificationRecord = { sha: HEAD_SHA, scope: 'verify:fast', completed_at: NOW };

function fileWith(verification: VerificationRecord | null, revision = 0): FindingsFileV2 {
  return {
    schema: 2,
    mode: 'review-and-refactor',
    generated_at: '2026-07-16T00:00:00Z',
    run_id: 'run-1',
    base_sha: 'base-1',
    revision,
    verification,
    self_review: null,
    findings: [],
  };
}

interface Harness {
  deps: VerifyDeps;
  // The `verification` value after each mutate, in call order (invalidation -> null, green -> stamp).
  writes: Array<VerificationRecord | null>;
  shimSpawned: () => boolean;
}

// Builds injected deps. `head` may be one SpawnResult (returned for every git call) or a sequence
// (one per git call: pre-shim HEAD, then post-shim HEAD). `getStatus` is the porcelain seam (absent
// -> clean tree). `mutate` applies `fn` to a mutable current-file so an invalidation write is
// observable, and records the resulting `verification`.
function harness(opts: {
  shim?: SpawnResult;
  head?: SpawnResult | SpawnResult[];
  getStatus?: () => string;
  initial?: FindingsFileV2;
  scope?: '--fast' | '--full';
}): Harness {
  const writes: Array<VerificationRecord | null> = [];
  let current = opts.initial ?? fileWith(null);
  let gitCall = 0;
  let shimCalls = 0;
  const heads = Array.isArray(opts.head) ? opts.head : [opts.head ?? { status: 0, stdout: `${HEAD_SHA}\n`, stderr: '' }];
  const spawn: VerifyDeps['spawn'] = (file) => {
    if (file === 'git') {
      const r = heads[Math.min(gitCall, heads.length - 1)] ?? { status: 0, stdout: `${HEAD_SHA}\n`, stderr: '' };
      gitCall += 1;
      return r;
    }
    shimCalls += 1;
    return opts.shim ?? { status: 0, stdout: '', stderr: '' };
  };
  const deps: VerifyDeps = {
    cwd: WORKTREE,
    scope: opts.scope ?? '--fast',
    entry: 'verify',
    findingsPath: '/reports/findings.json',
    deadline: createDeadline(900),
    spawn,
    readFindings: () => current,
    ...(opts.getStatus ? { getStatus: opts.getStatus } : {}),
    mutate: (_p, fn): FindingsFileV2 => {
      const next = { ...fn(current), revision: current.revision + 1 };
      current = next;
      writes.push(next.verification);
      return next;
    },
    now: () => NOW,
  };
  return { deps, writes, shimSpawned: () => shimCalls > 0 };
}

// ── BUG-02: a later failed attempt must not leave a usable prior green ───────────────

test('BUG-02 green -> red: a red verify invalidates the prior green stamp (no usable green)', () => {
  const h = harness({ shim: { status: 1, stdout: '', stderr: 'boom' }, initial: fileWith(PRIOR_STAMP, 3) });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_NEEDS_HUMAN);
  assert.deepEqual(h.writes, [null], 'the prior stamp is cleared to null; no new green written');
});

test('BUG-02 green -> null status (timeout/signal): the prior green is invalidated', () => {
  const h = harness({ shim: { status: null, stdout: '', stderr: 'killed' }, initial: fileWith(PRIOR_STAMP, 3) });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_FAILURE);
  assert.equal(r.machineError?.step, 'verify');
  assert.deepEqual(h.writes, [null], 'a killed/timed-out shim leaves no usable green');
});

test('BUG-02 green -> post-verify HEAD read failure: the prior green is invalidated', () => {
  const h = harness({
    shim: { status: 0, stdout: '', stderr: '' },
    // pre-shim HEAD read OK, post-shim HEAD read fails.
    head: [
      { status: 0, stdout: `${HEAD_SHA}\n`, stderr: '' },
      { status: 128, stdout: '', stderr: 'fatal: not a git repository' },
    ],
    initial: fileWith(PRIOR_STAMP, 3),
  });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_FAILURE);
  assert.ok(r.machineError, 'a HEAD-read failure surfaces a machine error');
  assert.deepEqual(h.writes, [null], 'invalidated up front; a post-HEAD-read failure writes no green');
});

test('BUG-02 green -> green: a later green supersedes the prior stamp with the current sha', () => {
  const h = harness({ shim: { status: 0, stdout: '', stderr: '' }, initial: fileWith(PRIOR_STAMP, 3) });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_OK);
  assert.deepEqual(h.writes, [null, GREEN_STAMP], 'invalidate the stale stamp, then restamp the fresh green');
});

test('BUG-02 first verify (no prior stamp): exactly one green write, no invalidation', () => {
  const h = harness({ shim: { status: 0, stdout: '', stderr: '' }, initial: fileWith(null, 0) });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_OK);
  assert.deepEqual(h.writes, [GREEN_STAMP], 'with nothing to invalidate, verify stays a single write');
});

// ── BUG-01: a green stamp must certify a clean, unchanged HEAD ────────────────────────

test('BUG-01 dirty tree before the shim: fail closed, shim not spawned, no stamp', () => {
  const h = harness({ shim: { status: 0, stdout: '', stderr: '' }, getStatus: () => ' M src/app.ts\n', initial: fileWith(null) });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_FAILURE);
  assert.equal(r.machineError?.step, 'verify');
  assert.match(r.machineError?.message ?? '', /uncommitted non-tooling changes/);
  assert.equal(h.shimSpawned(), false, 'a dirty tree fails closed BEFORE spawning the shim');
  assert.deepEqual(h.writes, [], 'no stamp written on a dirty tree');
});

test('BUG-01 tree dirtied DURING the shim (clean pre, dirty post): no green stamp', () => {
  let calls = 0;
  const h = harness({
    shim: { status: 0, stdout: '', stderr: '' },
    getStatus: () => (calls++ === 0 ? '' : ' M src/app.ts\n'),
    initial: fileWith(null),
  });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_FAILURE);
  assert.match(r.machineError?.message ?? '', /changed during verification/);
  assert.deepEqual(h.writes, [], 'a tree dirtied mid-run never stamps a green');
});

test('BUG-01 status changed across the run (clean but different): no green stamp', () => {
  let calls = 0;
  const h = harness({
    // Post-shim status differs from pre even though it carries no non-tooling dirt: the
    // "status unchanged across the run" guard must still refuse the green (fail closed).
    shim: { status: 0, stdout: '', stderr: '' },
    getStatus: () => (calls++ === 0 ? '' : '?? node_modules/\n'),
    initial: fileWith(null),
  });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_FAILURE);
  assert.match(r.machineError?.message ?? '', /changed during verification/);
  assert.deepEqual(h.writes, []);
});

test('BUG-01 tooling-only dirt (node_modules/.tools), stable across the run: green is stamped', () => {
  const h = harness({
    shim: { status: 0, stdout: '', stderr: '' },
    getStatus: () => '?? node_modules/\n?? .tools/\n',
    initial: fileWith(null),
  });
  const r = runFinalVerify(h.deps);
  assert.equal(r.exitCode, EXIT_OK);
  assert.deepEqual(h.writes, [GREEN_STAMP], 'engine tooling dirt does not block a green (matches the self-review gate)');
});
