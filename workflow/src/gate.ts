// §5 (spec) / §2.2, §2.7, §2.9 (plan) three-step gate with fixed exit codes.
//
// This is a frozen-contract surface: the gate's exit-code mapping is a CLI
// contract (§2.7). The gate is a PURE function over INJECTED reads — it performs
// no direct fs/git/process/clock IO and never calls `process.exit`. The CLI
// layer (Task 10.6) supplies the real seams and maps GateResult.exitCode to the
// process exit code; await-and-launch (Task 13.2) reuses the same result.
//
// Evaluation order (spec §5, plan §2.2), checked on the front-matter state:
//   (0) Divergence — front-matter-vs-HEAD-trailer, checked exactly ONCE at entry
//       (§spec-6), BEFORE the three steps and NEVER inside the --wait loop.
//   (1) Terminal     — `needs-human` or any failure state -> NEEDS_HUMAN (13).
//   (2) Self-complete — phases[phase].last_success_loop === loopback_count
//                       (§2.9) -> ALREADY_DONE (10).
//   (3) Precondition  — state ∈ phase preconditions -> PROCEED (0);
//                       else -> WRONG_STATE (11), naming the precondition(s).
//
// --wait: re-poll readState until it would PROCEED (or a terminal/already-done
// verdict appears), bounded by waitSeconds via the injected clock; on expiry ->
// TIMEOUT (12). The loop OBSERVES only — it never auto-promotes or mutates state.
//
// force (recovery-only): overrides ONLY a WRONG_STATE verdict -> records a
// forced_action via the sink and returns `forced-proceed` (0). It NEVER overrides
// a terminal state (handled before force) and NEVER applies to `ship-feature`.

import {
  EXIT_ALREADY_DONE,
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_WRONG_STATE,
} from './types.ts';
import type {
  ForcedAction,
  FrontMatter,
  WorkflowPhase,
  WorkflowState,
} from './types.ts';
import { TRANSITION_TABLE } from './transitions.ts';
import type { TransitionRow } from './transitions.ts';

// Default poll interval for the --wait loop when the caller does not override it.
// The pure gate only forwards this to the injected `sleep`; the real cadence is
// the CLI's concern (a synchronous blocking sleep at the edge).
const DEFAULT_POLL_MS = 1000;

// Terminal set = `needs-human` plus every failure state (plan §2.1). Derived
// from the frozen table's `failure` fields so it can never drift from the table.
const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set<WorkflowState>([
  'needs-human',
  ...TRANSITION_TABLE.map((row) => row.failure),
]);

const ROW_BY_PHASE = new Map<WorkflowPhase, TransitionRow>(
  TRANSITION_TABLE.map((row) => [row.phase, row]),
);

// Injected, side-effecting seams. The gate calls these and nothing else; all
// fs/git/clock/persistence lives behind them so the gate logic stays pure.
export interface GateDeps {
  readState: () => FrontMatter; // re-read each --wait poll
  checkDivergence: () => boolean; // front-matter-vs-HEAD trailer; called ONCE at entry
  // Clock (ms since epoch). MUST be monotonic non-decreasing: the --wait loop
  // relies on now() advancing toward the deadline to terminate.
  now: () => number;
  sleep: (ms: number) => void; // injectable poll step (real edge blocks synchronously)
  recordForcedAction: (action: ForcedAction) => void; // force sink (real persistence: later task)
}

export interface GateOptions {
  wait?: boolean;
  waitSeconds: number;
  pollMs?: number;
  force?: boolean;
  reason?: string;
  claimedBy?: string;
}

export type GateOutcome =
  | 'proceed'
  | 'already-done'
  | 'wrong-state'
  | 'timeout'
  | 'needs-human'
  | 'divergence'
  | 'forced-proceed';

export interface GateResult {
  exitCode: number;
  outcome: GateOutcome;
  phase: WorkflowPhase;
  state: WorkflowState;
  requiredPreconditions?: readonly WorkflowState[];
  pollCount?: number;
  message?: string;
}

// One pass of the three-step evaluation over a single observed state. Never
// performs IO; the caller owns reads and the wait/force policy.
interface Verdict {
  outcome: 'proceed' | 'already-done' | 'needs-human' | 'wrong-state';
  exitCode: number;
}

function classify(
  phase: WorkflowPhase,
  row: TransitionRow,
  fm: FrontMatter,
): Verdict {
  // (1) Terminal — never overridden by force, never waited out.
  if (TERMINAL_STATES.has(fm.state)) {
    return { outcome: 'needs-human', exitCode: EXIT_NEEDS_HUMAN };
  }
  // (2) Self-completion — this phase already succeeded in the CURRENT round.
  // last_success_loop is number | null; null never equals a numeric round.
  const record = fm.phases[phase];
  if (record !== undefined && record.last_success_loop === fm.loopback_count) {
    return { outcome: 'already-done', exitCode: EXIT_ALREADY_DONE };
  }
  // (3) Precondition — current state opens the gate.
  if (row.preconditions.includes(fm.state)) {
    return { outcome: 'proceed', exitCode: EXIT_OK };
  }
  return { outcome: 'wrong-state', exitCode: EXIT_WRONG_STATE };
}

function rowFor(phase: WorkflowPhase): TransitionRow {
  const row = ROW_BY_PHASE.get(phase);
  if (row === undefined) {
    // Unreachable: WorkflowPhase is exactly the transition-table phase set
    // (enforced by transitions.ts import-time assertions). The guard satisfies
    // the type checker and turns any future drift into a clear error.
    throw new Error(`no transition-table row for phase "${phase}"`);
  }
  return row;
}

function toResult(
  verdict: Verdict,
  phase: WorkflowPhase,
  fm: FrontMatter,
  pollCount: number,
  includePollCount: boolean,
): GateResult {
  const result: GateResult = {
    exitCode: verdict.exitCode,
    outcome: verdict.outcome,
    phase,
    state: fm.state,
  };
  if (includePollCount) {
    result.pollCount = pollCount;
  }
  return result;
}

// Builds a result that NAMES the phase's required precondition(s): the immediate
// wrong-state refusal and the --wait timeout (still wrong when the clock ran
// out) share this single construction site. `row.preconditions` is the one
// source for the named preconditions; `pollCount` is included only on the wait
// path (timeout), omitted on the immediate no-wait refusal.
function wrongStateResult(
  exitCode: number,
  outcome: GateOutcome,
  phase: WorkflowPhase,
  fm: FrontMatter,
  row: TransitionRow,
  pollCount?: number,
): GateResult {
  const result: GateResult = {
    exitCode,
    outcome,
    phase,
    state: fm.state,
    requiredPreconditions: row.preconditions,
  };
  if (pollCount !== undefined) {
    result.pollCount = pollCount;
  }
  return result;
}

export function gate(
  phase: WorkflowPhase,
  opts: GateOptions,
  deps: GateDeps,
): GateResult {
  const row = rowFor(phase);

  // (0) Divergence — checked EXACTLY ONCE at entry, before the three steps and
  // never inside the wait loop (spec §6).
  if (deps.checkDivergence()) {
    const fm = deps.readState();
    // Spec-silent inference (producer verdict, to be confirmed by a spec/ADR
    // amendment): divergence-refusal returns EXIT_NEEDS_HUMAN (13) with a
    // DISTINCT `divergence` outcome. Rationale: §2.7 reserves EXIT_FAILURE (1)
    // for gh/git/network infra failures plus the one CI-red case, so 1 is wrong
    // for a clean state-mismatch; of the gate outcomes only NEEDS_HUMAN means
    // "stop, a human must intervene first", which is exactly "run recover".
    return {
      exitCode: EXIT_NEEDS_HUMAN,
      outcome: 'divergence',
      phase,
      state: fm.state,
      message:
        'front matter diverges from the HEAD Workflow-Phase trailer; run `workflow recover` before proceeding',
    };
  }

  // First evaluation (poll #1).
  let fm = deps.readState();
  let pollCount = 1;
  let verdict = classify(phase, row, fm);

  // Terminal / already-done / proceed are final immediately: never forced,
  // never waited out.
  if (verdict.outcome !== 'wrong-state') {
    return toResult(verdict, phase, fm, pollCount, opts.wait === true);
  }

  // From here the immediate verdict is WRONG_STATE.

  // force overrides ONLY wrong-state, never a terminal state (handled above),
  // and never `ship-feature`. It takes precedence over --wait: force means
  // "override the wrong state now", not "wait for it to become right".
  if (opts.force === true && phase !== 'ship-feature') {
    deps.recordForcedAction({
      phase,
      loop: fm.loopback_count,
      from_state: fm.state,
      reason: opts.reason ?? '',
      at: new Date(deps.now()).toISOString(),
      claimed_by: opts.claimedBy ?? '',
    });
    return { exitCode: EXIT_OK, outcome: 'forced-proceed', phase, state: fm.state };
  }

  // No --wait: refuse and name the required precondition(s).
  if (opts.wait !== true) {
    return wrongStateResult(EXIT_WRONG_STATE, 'wrong-state', phase, fm, row);
  }

  // --wait: observe-only poll loop bounded by waitSeconds. It re-reads state and
  // re-runs the three-step evaluation each poll; it NEVER mutates state and
  // NEVER auto-promotes to needs-human (a slow producer is not a dead one —
  // death is the explicit <phase>-failed terminal state).
  const start = deps.now();
  const deadlineMs = opts.waitSeconds * 1000;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    if (deps.now() - start >= deadlineMs) {
      return wrongStateResult(EXIT_TIMEOUT, 'timeout', phase, fm, row, pollCount);
    }
    deps.sleep(pollMs);
    fm = deps.readState();
    pollCount += 1;
    verdict = classify(phase, row, fm);
    if (verdict.outcome !== 'wrong-state') {
      return toResult(verdict, phase, fm, pollCount, true);
    }
  }
}
