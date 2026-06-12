// Frozen §2.2 transition table + §2.3 seat map (ADR-012). The table is the
// single source of gate truth: every field is explicit, never name-derived.
// Import-time assertions (run at the bottom of this file) verify the table and
// seat map against the invariants in the plan §2.2; assertTransitionTable
// takes its inputs as arguments so a test can feed a deliberately-broken copy.

import { WORKFLOW_STATES } from './types.ts';
import type { Seat, WorkflowPhase, WorkflowState } from './types.ts';

export interface TransitionRow {
  order: number;
  phase: WorkflowPhase;
  preconditions: readonly WorkflowState[];
  // `start` is null for helper/human-driven phases with no `-inprogress` state
  // (new-feature, ship-feature); `changes_requested` is null for phases that
  // emit no loopback state.
  start: WorkflowState | null;
  success: WorkflowState;
  changes_requested: WorkflowState | null;
  failure: WorkflowState;
}

export const TRANSITION_TABLE = [
  {
    order: 0,
    phase: 'new-feature',
    preconditions: [],
    start: null,
    success: 'created',
    changes_requested: null,
    failure: 'new-feature-failed',
  },
  {
    order: 1,
    phase: 'plan',
    preconditions: ['created', 'plan-changes-requested'],
    start: 'plan-inprogress',
    success: 'plan-ready',
    changes_requested: null,
    failure: 'plan-failed',
  },
  {
    order: 2,
    phase: 'review-plan',
    preconditions: ['plan-ready'],
    start: 'review-plan-inprogress',
    success: 'plan-reviewed',
    changes_requested: 'plan-changes-requested',
    failure: 'review-plan-failed',
  },
  {
    order: 3,
    phase: 'consolidate-plan',
    preconditions: ['plan-reviewed'],
    start: 'consolidate-inprogress',
    success: 'plan-consolidated',
    changes_requested: null,
    failure: 'consolidate-failed',
  },
  {
    order: 4,
    phase: 'implement-plan',
    preconditions: ['plan-consolidated', 'impl-changes-requested'],
    start: 'implement-inprogress',
    success: 'implemented',
    changes_requested: null,
    failure: 'implement-failed',
  },
  {
    order: 5,
    phase: 'review-implementation',
    preconditions: ['implemented'],
    start: 'review-impl-inprogress',
    success: 'implementation-reviewed',
    changes_requested: 'impl-changes-requested',
    failure: 'review-impl-failed',
  },
  {
    order: 6,
    phase: 'ship-feature',
    preconditions: ['implementation-reviewed'],
    start: null,
    success: 'shipped',
    changes_requested: null,
    failure: 'ship-failed',
  },
] as const satisfies readonly TransitionRow[];

// §2.3 seat map: covers EXACTLY the transition-table phase set. `satisfies
// Record<WorkflowPhase, Seat>` enforces exact coverage at compile time (a
// missing phase or an extra key such as `process-review` fails to type-check);
// the runtime assertion below repeats the check against the live table.
export const SEAT_MAP = {
  'new-feature': 'human+helper',
  plan: 'Claude',
  'review-plan': 'Codex',
  'consolidate-plan': 'Claude',
  'implement-plan': 'Claude',
  'review-implementation': 'Codex',
  'ship-feature': 'helper',
} as const satisfies Record<WorkflowPhase, Seat>;

// Throws if any §2.2 invariant fails. Operates on its arguments (not the module
// constants) so a test can pass a mutated copy and observe the throw.
export function assertTransitionTable(
  table: readonly TransitionRow[],
  seatMap: Readonly<Record<string, Seat>>,
): void {
  assertEveryStateInEnum(table);
  assertMainlineOrderContiguous(table);
  assertChangesRequestedAreProducerPreconditions(table);
  assertSeatMapCoversTablePhases(table, seatMap);
}

function assertEveryStateInEnum(table: readonly TransitionRow[]): void {
  const validStates = new Set<string>(WORKFLOW_STATES);
  for (const row of table) {
    const referenced: ReadonlyArray<WorkflowState | null> = [
      ...row.preconditions,
      row.start,
      row.success,
      row.changes_requested,
      row.failure,
    ];
    for (const state of referenced) {
      if (state === null) continue;
      if (!validStates.has(state)) {
        throw new Error(
          `transition table phase "${row.phase}" references state "${state}", which is not a member of WORKFLOW_STATES`,
        );
      }
    }
  }
}

function assertMainlineOrderContiguous(table: readonly TransitionRow[]): void {
  table.forEach((row, index) => {
    if (row.order !== index) {
      throw new Error(
        `transition table order is not contiguous: expected order ${index} at index ${index}, got ${row.order} (phase "${row.phase}")`,
      );
    }
  });
}

// Each emitted `changes_requested` (loopback) state must be consumable as a
// precondition of some phase — i.e. it loops back to its producer phase
// (plan-changes-requested -> plan; impl-changes-requested -> implement-plan).
function assertChangesRequestedAreProducerPreconditions(
  table: readonly TransitionRow[],
): void {
  const allPreconditions = new Set<string>(
    table.flatMap((row) => [...row.preconditions]),
  );
  for (const row of table) {
    if (row.changes_requested === null) continue;
    if (!allPreconditions.has(row.changes_requested)) {
      throw new Error(
        `changes_requested state "${row.changes_requested}" (emitted by phase "${row.phase}") is not a precondition of any phase; it has no producer to loop back to`,
      );
    }
  }
}

function assertSeatMapCoversTablePhases(
  table: readonly TransitionRow[],
  seatMap: Readonly<Record<string, Seat>>,
): void {
  const tablePhases = new Set<string>(table.map((row) => row.phase));
  const seatPhases = new Set(Object.keys(seatMap));
  for (const phase of tablePhases) {
    if (!seatPhases.has(phase)) {
      throw new Error(`seat map is missing transition-table phase "${phase}"`);
    }
  }
  for (const phase of seatPhases) {
    if (!tablePhases.has(phase)) {
      throw new Error(
        `seat map phase "${phase}" has no transition-table row (non-table phases such as process-review must be excluded)`,
      );
    }
  }
}

// Run on the real table + seat map at module import.
assertTransitionTable(TRANSITION_TABLE, SEAT_MAP);
