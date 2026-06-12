// §8 (plan) `workflow resume` — the ONLY normal exit from `needs-human`. It reads
// the needs-human record, applies the per-reason resolution, RECORDS the waiver in
// `forced_actions[]`, and returns `state` to the prior state the workflow was in
// before `needs-human` was set.
//
// resume is STATE-MUTATING: like the other §6 verbs it runs inside the §2.10
// worktree mutex (withLock) and commits the planning file with a matching
// `Workflow-Phase: <return-state>` trailer, so the durable record (HEAD's last
// reachable trailer) never diverges from the runtime front-matter `state` after a
// resume (the same invariant recover/transactions maintain).
//
// THE NEEDS-HUMAN RECORD CONTRACT (read by resume, written by the §2.11 producer
// that SETS needs-human — Task 11.5):
//   - state                = 'needs-human'
//   - needs_human_reason   ∈ { loopback-cap | budget-exhausted | guide-missing |
//                              corrupt-state }   (§2.1 vocabulary)
//   - needs_human_from     = the WorkflowState the workflow was in immediately
//                            BEFORE needs-human was set (the "return state").
//                            REQUIRED for loopback-cap / budget-exhausted /
//                            guide-missing; resume returns `state` here.
//   The committing producer lands `Workflow-Phase: needs-human` on that commit.
//
// Per-reason resolution (revised §2.1 reason vocabulary):
//   - loopback-cap      — extend-cap WAIVER: raise `loopback_cap` (+1) so another
//                         round fits, return to the loop (needs_human_from is the
//                         producer's changes-requested state).
//   - budget-exhausted  — grant a FRESH, recorded budget: reset
//                         `budget_spent.total_seconds` to 0, return to the prior state.
//   - guide-missing     — WAIVER with NO counter change: return to the prior state.
//   - corrupt-state     — REFUSE unless a prior `workflow recover` already ran
//                         (the file no longer parses as corrupt and `state` is no
//                         longer needs-human). resume does NOT repair YAML.
// Every non-corrupt resolution appends ONE forced_actions[] entry recording the
// resolution by reason, at the prior state.

import {
  EXIT_FAILURE,
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_WRONG_STATE,
} from './types.ts';
import type {
  ForcedAction,
  FrontMatter,
  NeedsHumanReason,
  WorkflowPhase,
  WorkflowState,
} from './types.ts';
import {
  CorruptStateError,
  parseFrontMatter,
  validateReason,
} from './front-matter.ts';
import { withWorkflowPhaseTrailer } from './trailers.ts';
import { withLock } from './lock.ts';
import { TRANSITION_TABLE } from './transitions.ts';
import type { TransitionRow } from './transitions.ts';
import { splitPlanningFile } from './recover.ts';
import {
  commitPlanningFile,
  entryDivergence,
  nowIso,
  savePlanning,
} from './planning-io.ts';
import type { MutatingDeps } from './planning-io.ts';

// ── Injected edge + result ───────────────────────────────────────────────────

// resume shares the mutating-verb seam (MutatingDeps) with the §6 verbs but adds
// no task-specific fields: `now` here drives `updated` and the waiver `at`, and
// `claimedBy` is recorded on the waiver.
export type ResumeDeps = MutatingDeps;

export type ResumeOutcome =
  | 'resumed'
  | 'wrong-state'
  | 'corrupt-needs-recover'
  | 'divergence';

export interface ResumeResult {
  exitCode: number;
  outcome: ResumeOutcome;
  reason?: NeedsHumanReason;
  fromState: WorkflowState; // the state observed (needs-human on the resume path)
  toState: WorkflowState; // the return state (== fromState on a refusal)
  message?: string;
}

// ── resume ───────────────────────────────────────────────────────────────────

export function resume(deps: ResumeDeps): ResumeResult {
  return withLock(deps.worktree, deps.lockSeams, () => resumeInner(deps));
}

function resumeInner(deps: ResumeDeps): ResumeResult {
  const text = deps.readFile(deps.planningFile);
  const { frontMatterText, body } = splitPlanningFile(text);

  // A structurally corrupt planning file IS the corrupt-state case: resume refuses
  // and points at `workflow recover` (it never repairs YAML itself).
  let fm: FrontMatter;
  try {
    fm = parseFrontMatter(frontMatterText);
  } catch (error) {
    if (error instanceof CorruptStateError) return corruptNeedsRecover('the planning file is corrupt');
    throw error;
  }

  const observed = fm.state;

  // Entry divergence check (parity with the §6 verbs): a needs-human record lands
  // a `needs-human` trailer, so a legitimate needs-human never diverges here. The
  // file is already proven parseable above (the corrupt-state branch returned), so
  // the shared check (which re-reads + re-parses) cannot throw here.
  if (entryDivergence(deps)) {
    return {
      exitCode: EXIT_NEEDS_HUMAN,
      outcome: 'divergence',
      fromState: observed,
      toState: observed,
      message:
        'front matter diverges from the HEAD Workflow-Phase trailer; run `workflow recover` before resuming',
    };
  }

  // resume is the ONLY exit from needs-human; any other state is a usage/wrong-state.
  if (observed !== 'needs-human') {
    return wrongState(observed, `resume only exits "needs-human"; current state is "${observed}"`);
  }

  const reason = fm.needs_human_reason;
  if (reason === undefined) {
    return wrongState(observed, 'needs-human record has no needs_human_reason');
  }
  // corrupt-state always demands a prior `workflow recover` first (a parseable
  // file still at needs-human means recover has not yet restored the state).
  if (reason === 'corrupt-state') {
    return corruptNeedsRecover('needs_human_reason is "corrupt-state"');
  }

  const returnState = fm.needs_human_from;
  if (returnState === undefined) {
    return {
      exitCode: EXIT_FAILURE,
      outcome: 'wrong-state',
      reason,
      fromState: observed,
      toState: observed,
      message: 'needs-human record is missing needs_human_from (the return state); cannot resume',
    };
  }

  // Per-reason counter resolution (mutates fm in place).
  const waiverNote = applyReason(fm, reason);

  // Record the resolution by reason, at the prior state (one forced_actions entry).
  const action = buildForcedAction(reason, returnState, fm, deps, waiverNote);
  validateReason(action.reason); // ASCII, <=200, no control chars (defense in depth)
  fm.forced_actions = [...(fm.forced_actions ?? []), action];

  // Return to the prior state; the needs-human-only fields are cleared.
  delete fm.needs_human_reason;
  delete fm.needs_human_from;
  fm.state = returnState;
  fm.updated = nowIso(deps);
  savePlanning(deps, fm, body);

  commitPlanningFile(
    deps,
    withWorkflowPhaseTrailer(`workflow(resume): ${reason} -> ${returnState}`, returnState),
  );

  return { exitCode: EXIT_OK, outcome: 'resumed', reason, fromState: observed, toState: returnState };
}

// ── Per-reason resolution ────────────────────────────────────────────────────

// Applies the per-reason counter mutation and returns a short note for the waiver
// record. loopback-cap raises the cap; budget-exhausted resets the spent budget;
// guide-missing changes no counter (a pure waiver).
function applyReason(fm: FrontMatter, reason: NeedsHumanReason): string {
  switch (reason) {
    case 'loopback-cap': {
      const previous = fm.loopback_cap;
      fm.loopback_cap = previous + 1; // grant one additional round
      return `extend-cap waiver: loopback_cap ${previous} -> ${fm.loopback_cap}`;
    }
    case 'budget-exhausted': {
      const previous = fm.budget_spent.total_seconds;
      fm.budget_spent = { total_seconds: 0 }; // fresh budget; the grant is recorded below
      return `fresh budget granted: budget_spent ${previous}s -> 0s`;
    }
    case 'guide-missing':
      return 'guide-missing waiver (no counter change)';
    case 'corrupt-state':
      // Unreachable: corrupt-state is handled (refused) before applyReason.
      return 'corrupt-state';
  }
}

// Builds the forced_actions[] waiver entry: by reason, AT the prior (return) state,
// in the current round, stamped with the caller identity and the injected clock.
function buildForcedAction(
  reason: NeedsHumanReason,
  returnState: WorkflowState,
  fm: FrontMatter,
  deps: ResumeDeps,
  note: string,
): ForcedAction {
  return {
    phase: phaseForState(returnState),
    loop: fm.loopback_count,
    from_state: returnState,
    reason: `resume:${reason} - ${note}`,
    at: nowIso(deps),
    claimed_by: deps.claimedBy,
  };
}

// The phase that OWNS a state, for the waiver's `phase` field (a valid
// WorkflowPhase by construction). Precedence: the phase the state is a
// precondition of (the phase that runs next from here), else its in-progress
// owner, else its success/failure owner. Derived structurally from the table.
function phaseForState(state: WorkflowState): WorkflowPhase {
  // Widened view: the `as const` table narrows each row's literal types (the
  // empty-preconditions row would make `.includes` expect `never`), so iterate
  // through the TransitionRow interface like gate.ts/transactions.ts do.
  const rows: readonly TransitionRow[] = TRANSITION_TABLE;
  for (const row of rows) if (row.preconditions.includes(state)) return row.phase;
  for (const row of rows) if (row.start === state) return row.phase;
  for (const row of rows) if (row.success === state) return row.phase;
  for (const row of rows) if (row.failure === state) return row.phase;
  // Unreachable for any non-needs-human WorkflowState; satisfies the type checker.
  return rows[0]?.phase ?? 'plan';
}

// ── Refusal builders ─────────────────────────────────────────────────────────

function wrongState(state: WorkflowState, message: string): ResumeResult {
  return { exitCode: EXIT_WRONG_STATE, outcome: 'wrong-state', fromState: state, toState: state, message };
}

function corruptNeedsRecover(why: string): ResumeResult {
  return {
    exitCode: EXIT_NEEDS_HUMAN,
    outcome: 'corrupt-needs-recover',
    fromState: 'needs-human',
    toState: 'needs-human',
    message: `${why}; run \`workflow recover\` before resuming`,
  };
}
