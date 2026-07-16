/* Real-git e2e for BUG-05: the whole-run budget must persist ACROSS separate CLI
   processes instead of each verb restarting a fresh `config.budget.seconds` window.
   select-worktree stamps `budget_seconds`/`expires_at` onto the run descriptor at
   creation (descriptor.ts `stampRunBudget`, called from cli.ts's selectWorktreeCmd);
   every later verb computes its LOCAL monotonic deadline from the REMAINING time
   until that one shared expiry (cli.ts `verbDeadline`), and the identity gate
   `checkpoint`s on it before doing any work. This drives two REAL processes
   (select-worktree, then a fix verb) with a real wall-clock gap longer than the
   configured budget in between — proving the SECOND process sees an ALREADY
   exhausted deadline instead of a fresh one. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_OK, EXIT_FAILURE } from '../../deep-review/src/types.ts';
import {
  initCoreRepo,
  selectWorktree,
  readRunDescriptor,
  placeFindings,
  findingsFile,
  finding,
  runVerb,
  cleanup,
  FINDINGS_REL,
} from './helper.ts';

/* Blocks the event loop synchronously for `ms` — no external `sleep` binary, no
   timer/async plumbing. The test needs a REAL wall-clock gap between two SEPARATE
   spawned processes (the whole point is proving persistence survives a process
   boundary, not just an in-process clock). */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('BUG-05: select-worktree stamps budget_seconds/expires_at onto the run descriptor', () => {
  const box = initCoreRepo({ budgetSeconds: 1 });
  try {
    const worktree = selectWorktree(box.repo, box.env);
    const descriptor = readRunDescriptor(worktree, box.env) as unknown as {
      budget_seconds?: number;
      expires_at?: string;
      created_at: string;
    };
    assert.equal(descriptor.budget_seconds, 1);
    assert.equal(typeof descriptor.expires_at, 'string');
    const expiresAtMs = descriptor.expires_at === undefined ? NaN : Date.parse(descriptor.expires_at);
    assert.equal(Number.isNaN(expiresAtMs), false, 'expires_at must be a parseable timestamp');
    // expires_at = created_at + budget_seconds, NOT "now": pins the derivation this bug's fix
    // requires (re-stamping on a reuse must not push the deadline out).
    assert.equal(expiresAtMs, Date.parse(descriptor.created_at) + 1000);
  } finally {
    cleanup(box);
  }
});

test('BUG-05: a verb run in a LATER process, after the whole-run budget elapsed, sees an ALREADY exhausted deadline — not a fresh per-process one', () => {
  const box = initCoreRepo({ budgetSeconds: 1 });
  try {
    const worktree = selectWorktree(box.repo, box.env);
    placeFindings(worktree, findingsFile([finding()]));
    const cls = runVerb(worktree, ['classify', '--findings', FINDINGS_REL], box.env);
    assert.equal(cls.status, EXIT_OK, `classify failed: ${cls.stderr}`);

    // Real wall-clock gap, longer than the 1s whole-run budget, between the two CLI
    // PROCESSES (select-worktree already ran above; `verify` runs next as its OWN
    // process). Pre-fix, `verify` would call `createDeadline(config.budget.seconds)`
    // fresh here and sail through on a brand-new 1s window; post-fix it computes the
    // deadline from the descriptor's stamped `expires_at`, finds it already past, and
    // the identity gate's checkpoint aborts BEFORE any spawn.
    blockFor(1500);

    const ver = runVerb(worktree, ['verify', '--findings', FINDINGS_REL, '--scope', '--fast'], box.env);
    assert.equal(ver.status, EXIT_FAILURE, `expected the exhausted whole-run budget to fail verify: ${ver.stdout}${ver.stderr}`);
    assert.match(ver.stderr, /deadline exceeded/);
  } finally {
    cleanup(box);
  }
});

test('BUG-05 (classify): classify run in a LATER process after the whole-run budget elapsed also fails closed, not on a fresh per-process budget', () => {
  const box = initCoreRepo({ budgetSeconds: 1 });
  try {
    const worktree = selectWorktree(box.repo, box.env);
    placeFindings(worktree, findingsFile([finding()]));
    // classify is a MUTATING whole-run verb; after the shared budget expires it must abort at its
    // own checkpoint rather than restart a fresh window (the doc's classifyAfterBudgetExpired case).
    blockFor(1500);
    const cls = runVerb(worktree, ['classify', '--findings', FINDINGS_REL], box.env);
    assert.equal(cls.status, EXIT_FAILURE, `expected the exhausted whole-run budget to fail classify: ${cls.stdout}${cls.stderr}`);
    assert.match(cls.stderr, /deadline exceeded/);
  } finally {
    cleanup(box);
  }
});

test('BUG-05 control: the SAME sequence with a generous budget does NOT report a deadline failure (isolates the failure above to the budget, not a general regression)', () => {
  const box = initCoreRepo({ budgetSeconds: 900 });
  try {
    const worktree = selectWorktree(box.repo, box.env);
    placeFindings(worktree, findingsFile([finding()]));
    const cls = runVerb(worktree, ['classify', '--findings', FINDINGS_REL], box.env);
    assert.equal(cls.status, EXIT_OK, `classify failed: ${cls.stderr}`);

    // No sleep here: with a 900s budget nowhere near exhausted, the identity gate's checkpoint
    // must NOT fire. Asserted narrowly (no "deadline exceeded", rather than a blanket EXIT_OK) so
    // this stays a control for the BUDGET mechanism specifically, independent of any unrelated
    // verify-gate behavior (e.g. its own dirty-tree check) this fixture happens to also exercise.
    const ver = runVerb(worktree, ['verify', '--findings', FINDINGS_REL, '--scope', '--fast'], box.env);
    assert.doesNotMatch(ver.stderr, /deadline exceeded/, `verify must not fail on the whole-run deadline here: ${ver.stdout}${ver.stderr}`);
  } finally {
    cleanup(box);
  }
});
