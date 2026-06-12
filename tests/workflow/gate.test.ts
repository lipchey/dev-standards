import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_ALREADY_DONE,
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_WRONG_STATE,
} from '../../workflow/src/types.ts';
import type {
  ForcedAction,
  FrontMatter,
  WorkflowState,
} from '../../workflow/src/types.ts';
import { gate } from '../../workflow/src/gate.ts';
import type { GateDeps, GateOptions } from '../../workflow/src/gate.ts';

// A complete, valid planning-file front matter; tests override only the fields
// the case is about.
function makeFrontMatter(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'demo',
    branch: 'feature/demo',
    worktree: '/tmp/worktrees/demo',
    base: 'main',
    base_sha: '0'.repeat(40),
    cmux_section: 'demo',
    state: 'created',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: 'pane-1:claude',
    updated: '2026-06-12T00:00:00Z',
    phases: {},
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

// Deterministic injected seams: no real fs/git/clock. Tests override the ones
// they exercise.
function makeDeps(overrides: Partial<GateDeps> = {}): GateDeps {
  return {
    readState: () => makeFrontMatter(),
    checkDivergence: () => false,
    now: () => 0,
    sleep: () => {},
    recordForcedAction: () => {},
    ...overrides,
  };
}

const NO_WAIT: GateOptions = { waitSeconds: 30 };

test('terminal-needs-human', () => {
  // needs-human plus every failure state are terminal -> NEEDS_HUMAN.
  const terminalStates: WorkflowState[] = [
    'needs-human',
    'plan-failed',
    'ship-failed',
    'review-impl-failed',
  ];
  for (const state of terminalStates) {
    const deps = makeDeps({ readState: () => makeFrontMatter({ state }) });
    const result = gate('plan', NO_WAIT, deps);
    assert.equal(result.exitCode, EXIT_NEEDS_HUMAN, `state ${state}`);
    assert.equal(result.outcome, 'needs-human', `state ${state}`);
    assert.equal(result.state, state);
  }
});

test('already-done-on-last-success-loop', () => {
  // 'created' IS a valid plan precondition, so PROCEED would fire unless the
  // self-completion check (step 2) takes precedence: last_success_loop ==
  // loopback_count -> ALREADY_DONE.
  const deps = makeDeps({
    readState: () =>
      makeFrontMatter({
        state: 'created',
        loopback_count: 1,
        phases: {
          plan: {
            last_success_loop: 1,
            attempts: 1,
            start_sha: null,
            complete_sha: null,
          },
        },
      }),
  });
  const result = gate('plan', NO_WAIT, deps);
  assert.equal(result.exitCode, EXIT_ALREADY_DONE);
  assert.equal(result.outcome, 'already-done');

  // A success recorded in a PRIOR round must NOT satisfy the current round
  // (the §2.9 keying that keeps re-review from being skipped after a loopback).
  const stale = makeDeps({
    readState: () =>
      makeFrontMatter({
        state: 'created',
        loopback_count: 1,
        phases: {
          plan: {
            last_success_loop: 0,
            attempts: 1,
            start_sha: null,
            complete_sha: null,
          },
        },
      }),
  });
  assert.equal(gate('plan', NO_WAIT, stale).outcome, 'proceed');
});

test('proceed-on-precondition', () => {
  const created = makeDeps({ readState: () => makeFrontMatter({ state: 'created' }) });
  const result = gate('plan', NO_WAIT, created);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.outcome, 'proceed');

  // A loopback precondition also opens the producer gate.
  const loopback = makeDeps({
    readState: () => makeFrontMatter({ state: 'plan-changes-requested' }),
  });
  assert.equal(gate('plan', NO_WAIT, loopback).outcome, 'proceed');
});

test('wrong-state-names-precondition', () => {
  const deps = makeDeps({ readState: () => makeFrontMatter({ state: 'created' }) });
  const result = gate('review-plan', NO_WAIT, deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(result.outcome, 'wrong-state');
  assert.deepEqual(result.requiredPreconditions, ['plan-ready']);
});

test('wait-blocks-until-state-change', () => {
  let reads = 0;
  let sleeps = 0;
  const deps = makeDeps({
    readState: () => {
      reads += 1;
      // Wrong for the first two polls, then the precondition appears.
      const state: WorkflowState = reads < 3 ? 'plan-inprogress' : 'plan-ready';
      return makeFrontMatter({ state });
    },
    sleep: () => {
      sleeps += 1;
    },
    now: () => 0, // never advances -> the deadline is never reached
  });
  const result = gate('review-plan', { wait: true, waitSeconds: 60 }, deps);
  assert.equal(result.outcome, 'proceed');
  assert.equal(result.exitCode, EXIT_OK);
  assert.ok((result.pollCount ?? 0) > 1, 'must poll more than once before proceeding');
  assert.equal(reads, 3);
  assert.ok(sleeps >= 1, 'must sleep between polls');
});

test('wait-timeout-nonzero-no-autopromote', () => {
  let clock = 0;
  let reads = 0;
  const recorded: ForcedAction[] = [];
  const deps = makeDeps({
    readState: () => {
      reads += 1;
      return makeFrontMatter({ state: 'plan-inprogress' });
    },
    // Advances 600ms per call; with waitSeconds=1 (deadline 1000ms) the loop
    // exits via the deadline, never via a state change.
    now: () => {
      const current = clock;
      clock += 600;
      return current;
    },
    recordForcedAction: (action) => {
      recorded.push(action);
    },
  });
  const result = gate('review-plan', { wait: true, waitSeconds: 1 }, deps);
  assert.equal(result.exitCode, EXIT_TIMEOUT);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.state, 'plan-inprogress', 'state is observed, never mutated');
  assert.equal(recorded.length, 0, 'a timeout must never record a forced action');
  assert.ok(reads >= 1);
});

test('wait-timeout-on-exact-deadline-boundary', () => {
  // Lock the inclusive `>=` edge: when now() reaches EXACTLY start+deadlineMs on
  // the boundary iteration, the loop must TIMEOUT rather than poll once more. A
  // strict `>` would never fire here (the clock holds at the deadline) and the
  // loop would spin forever, so this both pins the contract and guards a hang.
  const ticks = [0, 500, 1000]; // start, below-deadline poll, exact-deadline
  let i = 0;
  let reads = 0;
  const deps = makeDeps({
    now: () => ticks[Math.min(i++, ticks.length - 1)] ?? 0,
    readState: () => {
      reads += 1;
      return makeFrontMatter({ state: 'plan-inprogress' }); // never a review-plan precondition
    },
  });
  const result = gate('review-plan', { wait: true, waitSeconds: 1 }, deps);
  assert.equal(result.exitCode, EXIT_TIMEOUT);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.state, 'plan-inprogress', 'state observed, never mutated');
  assert.deepEqual(result.requiredPreconditions, ['plan-ready']);
  assert.ok(reads >= 1);
});

test('wait-zero-seconds-times-out-immediately', () => {
  // waitSeconds=0 -> deadlineMs=0; the first loop check (now()-start >= 0) is
  // true at once, so a never-satisfiable wait returns TIMEOUT immediately with
  // no further poll/sleep and no infinite loop, leaving the state unmutated.
  let reads = 0;
  const deps = makeDeps({
    now: () => 0, // never advances; deadlineMs=0 still times out immediately
    readState: () => {
      reads += 1;
      return makeFrontMatter({ state: 'plan-inprogress' });
    },
    sleep: () => assert.fail('must not sleep when waitSeconds is 0'),
  });
  const result = gate('review-plan', { wait: true, waitSeconds: 0 }, deps);
  assert.equal(result.exitCode, EXIT_TIMEOUT);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.state, 'plan-inprogress', 'state observed, never mutated');
  assert.equal(reads, 1, 'only the initial poll read; the loop times out before re-reading');
});

test('already-done-takes-precedence-over-wrong-state', () => {
  // Step 2 (self-completion) precedes step 3 (precondition): even when the
  // current state is NOT a precondition of the phase (which alone would be
  // WRONG_STATE), last_success_loop === loopback_count yields ALREADY_DONE.
  const deps = makeDeps({
    readState: () =>
      makeFrontMatter({
        state: 'created', // NOT a review-plan precondition -> would be WRONG_STATE
        loopback_count: 0,
        phases: {
          'review-plan': {
            last_success_loop: 0,
            attempts: 1,
            start_sha: null,
            complete_sha: null,
          },
        },
      }),
  });
  const result = gate('review-plan', NO_WAIT, deps);
  assert.equal(result.exitCode, EXIT_ALREADY_DONE);
  assert.equal(result.outcome, 'already-done');
});

test('force-overrides-only-wrong-state', () => {
  // Wrong state + force -> forced-proceed, recorded.
  const recorded: ForcedAction[] = [];
  const wrong = makeDeps({
    readState: () => makeFrontMatter({ state: 'plan-ready' }), // not a plan precondition
    recordForcedAction: (action) => recorded.push(action),
  });
  const forced = gate(
    'plan',
    { waitSeconds: 30, force: true, reason: 'recovery', claimedBy: 'pane-1:human' },
    wrong,
  );
  assert.equal(forced.outcome, 'forced-proceed');
  assert.equal(forced.exitCode, EXIT_OK);
  assert.equal(recorded.length, 1);

  // Already-open gate + force -> normal proceed, nothing recorded.
  const recorded2: ForcedAction[] = [];
  const open = makeDeps({
    readState: () => makeFrontMatter({ state: 'created' }),
    recordForcedAction: (action) => recorded2.push(action),
  });
  const normal = gate(
    'plan',
    { waitSeconds: 30, force: true, reason: 'recovery', claimedBy: 'pane-1:human' },
    open,
  );
  assert.equal(normal.outcome, 'proceed');
  assert.equal(recorded2.length, 0, 'force must not record when the gate already opens');
});

test('force-never-terminal-never-ship', () => {
  // Terminal + force -> stays needs-human, nothing recorded.
  const rec1: ForcedAction[] = [];
  const terminal = makeDeps({
    readState: () => makeFrontMatter({ state: 'plan-failed' }),
    recordForcedAction: (action) => rec1.push(action),
  });
  const t = gate(
    'plan',
    { waitSeconds: 30, force: true, reason: 'recovery', claimedBy: 'pane-1:human' },
    terminal,
  );
  assert.equal(t.outcome, 'needs-human');
  assert.equal(t.exitCode, EXIT_NEEDS_HUMAN);
  assert.equal(rec1.length, 0, 'force never overrides a terminal state');

  // ship-feature in a wrong state + force -> stays wrong-state, nothing recorded.
  const rec2: ForcedAction[] = [];
  const ship = makeDeps({
    readState: () => makeFrontMatter({ state: 'implemented' }), // ship needs implementation-reviewed
    recordForcedAction: (action) => rec2.push(action),
  });
  const s = gate(
    'ship-feature',
    { waitSeconds: 30, force: true, reason: 'recovery', claimedBy: 'pane-1:human' },
    ship,
  );
  assert.equal(s.outcome, 'wrong-state');
  assert.equal(s.exitCode, EXIT_WRONG_STATE);
  assert.equal(rec2.length, 0, 'force never applies to ship-feature');
});

test('force-recorded-in-forced-actions', () => {
  const recorded: ForcedAction[] = [];
  const at = 1700000000000;
  const deps = makeDeps({
    readState: () => makeFrontMatter({ state: 'plan-ready', loopback_count: 2 }),
    now: () => at,
    recordForcedAction: (action) => recorded.push(action),
  });
  const result = gate(
    'plan',
    { waitSeconds: 30, force: true, reason: 'manual override', claimedBy: 'pane-1:human' },
    deps,
  );
  assert.equal(result.outcome, 'forced-proceed');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    phase: 'plan',
    loop: 2,
    from_state: 'plan-ready',
    reason: 'manual override',
    at: new Date(at).toISOString(),
    claimed_by: 'pane-1:human',
  });
});

test('divergence-checked-once-at-entry', () => {
  // (a) Divergence true -> exit 13, outcome divergence, recover pointer; the
  //     wait loop is never entered even with --wait.
  let calls = 0;
  let sleeps = 0;
  const diverged = makeDeps({
    checkDivergence: () => {
      calls += 1;
      return true;
    },
    readState: () => makeFrontMatter({ state: 'created' }),
    sleep: () => {
      sleeps += 1;
    },
  });
  const r1 = gate('plan', { wait: true, waitSeconds: 60 }, diverged);
  assert.equal(r1.exitCode, EXIT_NEEDS_HUMAN);
  assert.equal(r1.outcome, 'divergence');
  assert.equal(calls, 1, 'divergence checked exactly once');
  assert.match(r1.message ?? '', /recover/, 'divergence points to workflow recover');
  assert.equal(sleeps, 0, 'divergence refuses before any wait');

  // (b) Divergence false + a --wait that polls several times -> still checked
  //     exactly once (never re-checked inside the loop).
  let calls2 = 0;
  let reads = 0;
  const converged = makeDeps({
    checkDivergence: () => {
      calls2 += 1;
      return false;
    },
    readState: () => {
      reads += 1;
      return makeFrontMatter({ state: reads < 3 ? 'plan-inprogress' : 'plan-ready' });
    },
    now: () => 0,
  });
  const r2 = gate('review-plan', { wait: true, waitSeconds: 60 }, converged);
  assert.equal(r2.outcome, 'proceed');
  assert.equal(calls2, 1, 'divergence is not re-checked inside the wait loop');
});
