import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_STATES } from '../../workflow/src/types.ts';
import type { Seat, WorkflowState } from '../../workflow/src/types.ts';
import {
  SEAT_MAP,
  TRANSITION_TABLE,
  assertTransitionTable,
} from '../../workflow/src/transitions.ts';
import type { TransitionRow } from '../../workflow/src/transitions.ts';

// Mutable deep copy so a test can deliberately break a single field and feed the
// result back into assertTransitionTable to observe a throw.
function cloneTable(): TransitionRow[] {
  return TRANSITION_TABLE.map((row) => ({
    order: row.order,
    phase: row.phase,
    preconditions: [...row.preconditions],
    start: row.start,
    success: row.success,
    changes_requested: row.changes_requested,
    failure: row.failure,
  }));
}

function cloneSeatMap(): Record<string, Seat> {
  return { ...SEAT_MAP };
}

test('every-state-in-enum', () => {
  const validStates = new Set<string>(WORKFLOW_STATES);
  for (const row of TRANSITION_TABLE) {
    const referenced: ReadonlyArray<WorkflowState | null> = [
      ...row.preconditions,
      row.start,
      row.success,
      row.changes_requested,
      row.failure,
    ];
    for (const state of referenced) {
      if (state === null) continue;
      assert.ok(
        validStates.has(state),
        `phase "${row.phase}" references state "${state}" absent from WORKFLOW_STATES`,
      );
    }
  }
});

test('mainline-order-contiguous', () => {
  TRANSITION_TABLE.forEach((row, index) => {
    assert.equal(
      row.order,
      index,
      `expected order ${index} at table index ${index}, got ${row.order}`,
    );
  });
});

test('changes-requested-is-producer-precondition', () => {
  const allPreconditions = new Set<string>(
    TRANSITION_TABLE.flatMap((row) => [...row.preconditions]),
  );
  for (const row of TRANSITION_TABLE) {
    if (row.changes_requested === null) continue;
    assert.ok(
      allPreconditions.has(row.changes_requested),
      `changes_requested "${row.changes_requested}" (emitted by "${row.phase}") is not a precondition of any phase`,
    );
  }
  // The two pinned loopbacks land on their producer phases exactly.
  const plan = TRANSITION_TABLE.find((row) => row.phase === 'plan');
  const implement = TRANSITION_TABLE.find((row) => row.phase === 'implement-plan');
  assert.ok(plan && implement, 'table must contain plan and implement-plan rows');
  assert.ok(
    plan.preconditions.includes('plan-changes-requested'),
    'plan must accept plan-changes-requested as a precondition',
  );
  assert.ok(
    implement.preconditions.includes('impl-changes-requested'),
    'implement-plan must accept impl-changes-requested as a precondition',
  );
});

test('changes-requested-misrouted-to-non-producer-throws', () => {
  // Pin the tightened guard: a loopback state must be a precondition of its
  // SPECIFIC producer (the phase whose success state is the review row's input
  // precondition), not merely a precondition of SOME phase. Here we move
  // plan-changes-requested off its producer (plan) and onto a non-producer
  // (ship-feature) that nonetheless lists it as a precondition. The old loose
  // check ("precondition of some phase") would PASS because ship-feature still
  // lists it; the tightened check must FAIL because plan no longer does.
  const misrouted = cloneTable();
  const planRow = misrouted.find((row) => row.phase === 'plan');
  const shipRow = misrouted.find((row) => row.phase === 'ship-feature');
  assert.ok(planRow && shipRow, 'clone has plan and ship-feature rows');
  planRow.preconditions = planRow.preconditions.filter(
    (state) => state !== 'plan-changes-requested',
  );
  shipRow.preconditions = [...shipRow.preconditions, 'plan-changes-requested'];

  // Sanity: the old loose invariant still holds for this mutated copy — the
  // loopback state IS a precondition of some phase (ship-feature).
  const allPreconditions = new Set<string>(
    misrouted.flatMap((row) => [...row.preconditions]),
  );
  assert.ok(
    allPreconditions.has('plan-changes-requested'),
    'misrouted copy still has plan-changes-requested as a precondition of some phase (would pass the old loose check)',
  );

  // The tightened guard must reject it: the loopback no longer lands on plan.
  assert.throws(
    () => assertTransitionTable(misrouted, SEAT_MAP),
    /producer/i,
  );
});

test('seat-map-covers-all-phases', () => {
  const tablePhases = new Set(TRANSITION_TABLE.map((row) => row.phase));
  const seatPhases = new Set(Object.keys(SEAT_MAP));
  assert.deepEqual(
    [...seatPhases].sort(),
    [...tablePhases].sort(),
    'seat-map keys must equal the transition-table phase set exactly',
  );
  assert.ok(
    !seatPhases.has('process-review'),
    'process-review is a non-table phase and must be excluded from the pinned seat map',
  );
});

test('assertions-throw-on-mutated-copy', () => {
  // Sanity: the real frozen table + seat map satisfy every invariant.
  assert.doesNotThrow(() => assertTransitionTable(TRANSITION_TABLE, SEAT_MAP));

  // Break kind 1: a non-contiguous order.
  const gappy = cloneTable();
  const second = gappy[1];
  assert.ok(second, 'clone has a second row');
  second.order = 99;
  assert.throws(() => assertTransitionTable(gappy, SEAT_MAP), /order/i);

  // Break kind 2: a changes_requested state that no phase consumes.
  const orphaned = cloneTable();
  const implementRow = orphaned.find((row) => row.phase === 'implement-plan');
  assert.ok(implementRow, 'clone has an implement-plan row');
  implementRow.preconditions = implementRow.preconditions.filter(
    (state) => state !== 'impl-changes-requested',
  );
  assert.throws(
    () => assertTransitionTable(orphaned, SEAT_MAP),
    /precondition/i,
  );

  // Break kind 3: a referenced state outside the enum.
  const bogus = cloneTable();
  const firstRow = bogus[0];
  assert.ok(firstRow, 'clone has a first row');
  firstRow.success = 'not-a-real-state' as WorkflowState;
  assert.throws(() => assertTransitionTable(bogus, SEAT_MAP), /not-a-real-state/);

  // Break kind 4: seat map missing a table phase.
  const missing = cloneSeatMap();
  delete missing['ship-feature'];
  assert.throws(
    () => assertTransitionTable(TRANSITION_TABLE, missing),
    /ship-feature/,
  );

  // Break kind 5: seat map with an extra non-table phase (process-review).
  const extra = cloneSeatMap();
  extra['process-review'] = 'Claude';
  assert.throws(
    () => assertTransitionTable(TRANSITION_TABLE, extra),
    /process-review/,
  );
});
