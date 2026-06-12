// §6 locked transactions — the state-mutating verbs of the workflow state machine
// (`start`, `complete`, `request-changes`). Each runs inside the §2.10 worktree
// mutex (withLock) and each commits the planning file with a matching
// `Workflow-Phase: <resulting-state>` trailer, so the durable record (HEAD's last
// reachable trailer) NEVER diverges from the runtime front-matter `state` — the
// invariant recover.ts/trailers.ts depend on. ADR-009 §2.9 conditional
// consolidate auto-advance folds `plan-reviewed -> plan-consolidated` into the
// SAME `complete review-plan --approved` lock-held transaction.
//
// The pure decision logic (transition lookup, owner/precondition checks, the
// auto-advance rule, budget accumulation) is kept separate from the git/fs EDGE
// (commits, sha capture, file writes), reached only through injected seams
// (TransactionDeps). Behaviour is unit-tested against real ephemeral git repos
// with a deterministic injected clock.
//
// SHAPES (frozen contract §6):
//   - `start <phase>`  — claims the phase, advances `state` to the phase's
//     in-progress state, records start_sha + bumps attempts, ONE trailered commit.
//   - `complete <planning-phase>` — folds the front-matter mutation into the SAME
//     commit as the `Workflow-Phase` trailer (single commit).
//   - `complete implement-plan` — TWO commits in one held lock: (1) the code
//     commit (code only, NO trailer; complete_sha anchors here), (2) the planning
//     commit (planning only, WITH trailer).
//   - `request-changes <producer-phase>` — sets the producer's changes_requested
//     state, increments loopback_count, accumulates the rejected pass's budget,
//     ONE trailered commit.
//
// complete_sha: for a planning-phase `complete`, complete_sha is the sha of the
// very commit being made (knowable only post-commit) and is NOT consumed by
// gate/transitions/recover, so it is recorded as null — the trailered transaction
// commit itself stands as the phase's completion, and the worktree is left CLEAN
// (the dirty-refusing `ship` must not trip on the helper's own metadata).
// implement-plan records complete_sha = the code commit (commit 1) in commit 2.
// recover deliberately ignores complete_sha; `state` is NEVER advanced outside a
// trailered commit.

import {
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_WRONG_STATE,
} from './types.ts';
import type {
  FrontMatter,
  NeedsHumanReason,
  PhaseRecord,
  WorkflowPhase,
  WorkflowState,
} from './types.ts';
import { validateReason } from './front-matter.ts';
import { withWorkflowPhaseTrailer } from './trailers.ts';
import { withLock } from './lock.ts';
import { TRANSITION_TABLE } from './transitions.ts';
import type { TransitionRow } from './transitions.ts';
import {
  assertCodeCommitShape,
  CommitScopeError,
  planningRelPath,
  stagedPaths,
  worktreeChangesExcept,
} from './commit-scope.ts';
import {
  assertNoForeignStaged,
  commitMutation,
  entryDivergence,
  loadPlanning,
  nowIso,
} from './planning-io.ts';
import type { MutatingDeps } from './planning-io.ts';

// ── Table lookups (derived from the frozen TRANSITION_TABLE; never name-derived) ─

const ROW_BY_PHASE = new Map<WorkflowPhase, TransitionRow>(
  TRANSITION_TABLE.map((row) => [row.phase, row]),
);

// Producer phase -> the loopback it owns: the changes_requested state that routes
// changes back to it, plus the review row that emits it (its `start` state is the
// `request-changes` precondition). Derived structurally from the table: a review
// row's non-loopback input precondition is its producer's success state.
interface Loopback {
  state: WorkflowState;
  reviewRow: TransitionRow;
}

const LOOPBACK_BY_PRODUCER = buildLoopbackByProducer();

function buildLoopbackByProducer(): Map<WorkflowPhase, Loopback> {
  const successToPhase = new Map<WorkflowState, WorkflowPhase>();
  const loopbackStates = new Set<WorkflowState>();
  for (const row of TRANSITION_TABLE) {
    successToPhase.set(row.success, row.phase);
    if (row.changes_requested !== null) loopbackStates.add(row.changes_requested);
  }
  const map = new Map<WorkflowPhase, Loopback>();
  for (const reviewRow of TRANSITION_TABLE) {
    if (reviewRow.changes_requested === null) continue;
    const producerSuccess = reviewRow.preconditions.find((s) => !loopbackStates.has(s));
    const producer = producerSuccess === undefined ? undefined : successToPhase.get(producerSuccess);
    if (producer === undefined) continue;
    map.set(producer, { state: reviewRow.changes_requested, reviewRow });
  }
  return map;
}

function rowFor(phase: WorkflowPhase): TransitionRow {
  const row = ROW_BY_PHASE.get(phase);
  if (row === undefined) {
    throw new Error(`no transition-table row for phase "${phase}"`);
  }
  return row;
}

// ── Injected edge + result ───────────────────────────────────────────────────

export interface TransactionDeps extends MutatingDeps {
  // (planningFile, worktree, readFile, writeFile, run, lockSeams, now, claimedBy
  // are the shared MutatingDeps seam; `now` here also drives the budget clock.)
  // §8 budget ceilings (Task 11.5), injected by the CLI edge from the §2.8
  // `workflow.budget` config so the needs-human TRIGGERS are unit-testable with
  // explicit ceilings. ABSENT => no total/per-pass trigger fires (the loopback
  // proceeds normally); the loopback-cap trigger is independent of this and uses
  // the front-matter `loopback_cap` (hard-coded at 2). `totalSeconds` is the
  // §8 `budget.workflow_total_seconds` total; `perPassSeconds` is the OPTIONAL,
  // sparse per-pass ceiling (§2.8) checked ONLY when configured.
  budget?: { totalSeconds: number; perPassSeconds?: number };
}

export type TransactionOutcome =
  | 'started'
  | 'completed'
  | 'changes-requested'
  | 'needs-human'
  | 'wrong-state'
  | 'wrong-owner'
  | 'divergence';

export interface TransactionResult {
  exitCode: number;
  outcome: TransactionOutcome;
  phase: WorkflowPhase;
  fromState: WorkflowState;
  toState: WorkflowState;
  autoAdvanced?: boolean; // true only on the §2.9 review-plan --approved auto-advance
  message?: string;
}

// ── Transaction-only edge helpers ────────────────────────────────────────────
// (loadPlanning/nowIso/entryDivergence/commitMutation/assertNoForeignStaged are
// the shared mutating-verb edge in planning-io.ts; only the sha-capture helpers
// below are specific to the §6 verbs.)

function planningRel(deps: TransactionDeps): string {
  return planningRelPath(deps.worktree, deps.planningFile);
}

function headSha(deps: TransactionDeps): string {
  return deps.run(['rev-parse', 'HEAD'], deps.worktree).trim();
}

function headShaOrNull(deps: TransactionDeps): string | null {
  try {
    return headSha(deps);
  } catch {
    return null; // unborn HEAD (pre-first-commit) — no base sha to record
  }
}

// ── Refusal builders ─────────────────────────────────────────────────────────

function divergenceResult(phase: WorkflowPhase, state: WorkflowState): TransactionResult {
  return {
    exitCode: EXIT_NEEDS_HUMAN,
    outcome: 'divergence',
    phase,
    fromState: state,
    toState: state,
    message:
      'front matter diverges from the HEAD Workflow-Phase trailer; run `workflow recover` before proceeding',
  };
}

// Wrong-`claimed_by` is an ownership/precondition refusal -> EXIT_WRONG_STATE
// (§2.7): the caller does not own the phase, so the transition's precondition is
// unmet. It is not an infra failure (1), nor needs-human (13).
function wrongOwnerResult(
  phase: WorkflowPhase,
  state: WorkflowState,
  fm: FrontMatter,
  deps: TransactionDeps,
): TransactionResult {
  return {
    exitCode: EXIT_WRONG_STATE,
    outcome: 'wrong-owner',
    phase,
    fromState: state,
    toState: state,
    message: `phase "${phase}" is claimed by "${fm.claimed_by}", not "${deps.claimedBy}"`,
  };
}

function wrongStateResult(
  phase: WorkflowPhase,
  state: WorkflowState,
  expected: string,
): TransactionResult {
  return {
    exitCode: EXIT_WRONG_STATE,
    outcome: 'wrong-state',
    phase,
    fromState: state,
    toState: state,
    message: `current state "${state}" does not permit ${phase} here (expected ${expected})`,
  };
}

// ── Phase-record helpers ─────────────────────────────────────────────────────

// Marks a phase as succeeded in the CURRENT round: last_success_loop = the round
// (loopback_count). attempts/start_sha are preserved from the matching `start`;
// complete_sha is set inline when known (implement: the code commit) or null and
// recorded post-commit (planning-phase complete). A prior auto_advanced flag is
// preserved.
function markPhaseSuccess(
  fm: FrontMatter,
  phase: WorkflowPhase,
  loop: number,
  completeSha: string | null,
): void {
  const prev = fm.phases[phase];
  const record: PhaseRecord = {
    last_success_loop: loop,
    attempts: prev?.attempts ?? 0,
    start_sha: prev?.start_sha ?? null,
    complete_sha: completeSha,
  };
  if (prev?.auto_advanced !== undefined) {
    record.auto_advanced = prev.auto_advanced;
  }
  fm.phases[phase] = record;
}

// ── start ────────────────────────────────────────────────────────────────────

// `start <phase>`: claims the phase for the caller and advances `state` to the
// phase's in-progress state, in ONE trailered commit (so the durable trailer
// matches the advanced state — no false-positive divergence on the next entry).
export function start(phase: WorkflowPhase, deps: TransactionDeps): TransactionResult {
  return withLock(deps.worktree, deps.lockSeams, () => startInner(phase, deps));
}

function startInner(phase: WorkflowPhase, deps: TransactionDeps): TransactionResult {
  const row = rowFor(phase);
  const { fm, body, text } = loadPlanning(deps);
  const fromState = fm.state;
  if (entryDivergence(deps)) return divergenceResult(phase, fromState);
  if (row.start === null) {
    return wrongStateResult(phase, fromState, 'a phase with an in-progress state');
  }
  if (!row.preconditions.includes(fromState)) {
    return wrongStateResult(phase, fromState, `one of: ${row.preconditions.join(', ')}`);
  }
  // Atomicity: pre-flight the commit-shape refusal BEFORE mutating/saving, so a
  // foreign staged file refuses with the tree untouched (never advances `state`).
  assertNoForeignStaged(deps);

  const startSha = headShaOrNull(deps); // base of this attempt (the prior resting commit)
  const prev = fm.phases[phase];
  const toState = row.start;
  fm.state = toState;
  fm.claimed_by = deps.claimedBy;
  fm.updated = nowIso(deps);
  fm.phases[phase] = {
    last_success_loop: prev?.last_success_loop ?? null,
    attempts: (prev?.attempts ?? 0) + 1,
    start_sha: startSha,
    complete_sha: null,
  };
  commitMutation(deps, text, fm, body, withWorkflowPhaseTrailer(`workflow(${phase}): start -> ${toState}`, toState));
  return { exitCode: EXIT_OK, outcome: 'started', phase, fromState, toState };
}

// ── complete ─────────────────────────────────────────────────────────────────

export interface CompleteOptions {
  approved?: boolean;
}

// `complete <phase>`: the producer/reviewer finishes the phase. Refuses on
// divergence, wrong owner, or a state that is not the phase's in-progress state.
// implement-plan uses the two-commit shape; every other phase folds the mutation
// into a single trailered commit. review-plan --approved auto-advances (§2.9).
export function complete(
  phase: WorkflowPhase,
  opts: CompleteOptions,
  deps: TransactionDeps,
): TransactionResult {
  return withLock(deps.worktree, deps.lockSeams, () => completeInner(phase, opts, deps));
}

function completeInner(
  phase: WorkflowPhase,
  opts: CompleteOptions,
  deps: TransactionDeps,
): TransactionResult {
  const row = rowFor(phase);
  const { fm, body, text } = loadPlanning(deps);
  const fromState = fm.state;
  if (entryDivergence(deps)) return divergenceResult(phase, fromState);
  if (fm.claimed_by !== deps.claimedBy) return wrongOwnerResult(phase, fromState, fm, deps);
  if (row.start === null || fromState !== row.start) {
    return wrongStateResult(phase, fromState, `${row.start ?? '(no in-progress state)'}`);
  }
  if (phase === 'implement-plan') {
    // implement-plan intentionally stages code paths for commit 1; its pre-flight
    // shape check (CHECK B / no planning in the code commit) lives in
    // completeImplement, and commit 2 (planning) is made atomically there.
    return completeImplement(phase, row, fromState, fm, body, text, deps);
  }
  // Atomicity: pre-flight the planning-only commit-shape refusal BEFORE mutating.
  assertNoForeignStaged(deps);
  return completePlanning(phase, row, opts, fromState, fm, body, text, deps);
}

// Single-commit completion: the front-matter mutation rides in the SAME commit as
// the Workflow-Phase trailer. review-plan --approved additionally auto-advances to
// plan-consolidated within this one commit (§2.9), writing the consolidate phase's
// auto-advance record so its gate observes ALREADY_DONE.
function completePlanning(
  phase: WorkflowPhase,
  row: TransitionRow,
  opts: CompleteOptions,
  fromState: WorkflowState,
  fm: FrontMatter,
  body: string,
  text: string,
  deps: TransactionDeps,
): TransactionResult {
  const loop = fm.loopback_count;
  const autoAdvance = phase === 'review-plan' && opts.approved === true;

  markPhaseSuccess(fm, phase, loop, null); // complete_sha set post-commit (the commit being made)

  let toState: WorkflowState = row.success;
  if (autoAdvance) {
    toState = 'plan-consolidated';
    // §2.9 pinned auto-advance write: consolidate is marked done in this round so
    // the consolidate pane's gate returns ALREADY_DONE without launching an agent.
    const prevConsolidate = fm.phases['consolidate-plan'];
    fm.phases['consolidate-plan'] = {
      last_success_loop: loop,
      attempts: (prevConsolidate?.attempts ?? 0) + 1,
      start_sha: null,
      complete_sha: null, // set post-commit (same commit as the review-plan trailer)
      auto_advanced: true,
    };
  }

  fm.state = toState;
  fm.updated = nowIso(deps);
  // withWorkflowPhaseTrailer normalizes to ONE value = the final resting state.
  // commitMutation restores `text` (the pre-transaction file) on ANY throw, so a
  // refused/failed planning commit leaves `state` unchanged and the tree clean.
  commitMutation(
    deps,
    text,
    fm,
    body,
    withWorkflowPhaseTrailer(`workflow(${phase}): complete -> ${toState}`, toState),
  );

  // Fix 3 (P2): no post-commit complete_sha rewrite for planning/review phases.
  // complete_sha for these phases is the trailer commit itself (knowable only
  // post-commit, and NOT consumed by gate/transitions/recover), so it stays null
  // and the worktree is left CLEAN — the contracted dirty-refusing `ship` (after
  // `complete review-implementation`) must not trip on the helper's own metadata.
  // (implement-plan keeps complete_sha = the code commit, recorded in its commit 2.)

  const result: TransactionResult = {
    exitCode: EXIT_OK,
    outcome: 'completed',
    phase,
    fromState,
    toState,
  };
  if (autoAdvance) result.autoAdvanced = true;
  return result;
}

// Two-commit completion for implement-plan, inside the one held lock:
//   (1) the CODE commit — every worktree change except the planning file, NO
//       trailer. complete_sha anchors HERE (the durable implementation work).
//   (2) the planning commit — the planning file only, WITH the `implemented`
//       trailer and the front-matter mutation (incl. complete_sha = commit 1).
function completeImplement(
  phase: WorkflowPhase,
  row: TransitionRow,
  fromState: WorkflowState,
  fm: FrontMatter,
  body: string,
  text: string,
  deps: TransactionDeps,
): TransactionResult {
  const rel = planningRel(deps);

  // (1) code commit — enumerate + stage code paths one at a time (never add -A).
  const codePaths = worktreeChangesExcept(deps.worktree, rel, deps.run);
  assertCodeCommitShape(codePaths);
  for (const p of codePaths) deps.run(['add', '--', p], deps.worktree);
  // Defense in depth: the planning file must never ride in the code commit.
  if (stagedPaths(deps.worktree, deps.run).includes(rel)) {
    throw new CommitScopeError(
      `the implement-plan code commit must not include the planning file "${rel}"`,
    );
  }
  deps.run(['commit', '-q', '-m', `workflow(${phase}): implementation`], deps.worktree); // NO trailer
  const codeSha = headSha(deps);

  // (2) planning commit — complete_sha = the code commit, durably recorded here.
  // commitMutation restores the pre-transaction planning file on ANY throw in
  // commit 2, so a failed planning commit leaves `state` unchanged and the tree
  // non-divergent. The already-made code commit (commit 1) STAYS: an untrailed
  // code commit is durable and `recover` handles it — we never undo commit 1.
  markPhaseSuccess(fm, phase, fm.loopback_count, codeSha);
  fm.state = row.success; // 'implemented'
  fm.updated = nowIso(deps);
  commitMutation(
    deps,
    text,
    fm,
    body,
    withWorkflowPhaseTrailer(`workflow(${phase}): complete -> ${row.success}`, row.success),
  );
  return { exitCode: EXIT_OK, outcome: 'completed', phase, fromState, toState: row.success };
}

// ── request-changes ──────────────────────────────────────────────────────────

export interface RequestChangesOptions {
  reason: string;
}

// `request-changes <producer-phase> --reason <text>`: the reviewer bounces the
// reviewed artifact back to its producer. Sets the producer's changes_requested
// state, increments loopback_count, accumulates the rejected pass's budget, and
// commits the planning file (reason in the commit body) with the loopback-state
// trailer. The gate's self-completion check keys on
// phases[P].last_success_loop == loopback_count, so the bumped loopback_count
// re-opens every phase's gate for the new round (re-review is never skipped).
export function requestChanges(
  producer: WorkflowPhase,
  opts: RequestChangesOptions,
  deps: TransactionDeps,
): TransactionResult {
  return withLock(deps.worktree, deps.lockSeams, () => requestChangesInner(producer, opts, deps));
}

function requestChangesInner(
  producer: WorkflowPhase,
  opts: RequestChangesOptions,
  deps: TransactionDeps,
): TransactionResult {
  const loopback = LOOPBACK_BY_PRODUCER.get(producer);
  if (loopback === undefined) {
    // Not a producer that owns a changes_requested loopback (e.g. a review phase).
    const { fm } = loadPlanning(deps);
    return wrongStateResult(producer, fm.state, 'a producer phase with a changes-requested loopback');
  }
  validateReason(opts.reason); // ASCII, <=200, no control chars (front-matter.ts)

  const { fm, body, text } = loadPlanning(deps);
  const fromState = fm.state;
  if (entryDivergence(deps)) return divergenceResult(producer, fromState);
  if (fm.claimed_by !== deps.claimedBy) return wrongOwnerResult(producer, fromState, fm, deps);
  // Precondition: the review that produced the rejection is in progress.
  if (fromState !== loopback.reviewRow.start) {
    return wrongStateResult(producer, fromState, `${loopback.reviewRow.start}`);
  }
  // Atomicity: pre-flight the planning-only commit-shape refusal BEFORE mutating.
  assertNoForeignStaged(deps);

  // Budget accumulation + needs-human TRIGGERS (Task 11.5).
  // SEAM: ACCUMULATE first (the rejected pass happened — it counts), THEN evaluate
  // the triggers on the updated counters. The rejected review pass's duration is
  // measured from the last state change via the injected clock.
  const elapsed = passDurationSeconds(fm.updated, deps.now());
  fm.budget_spent = { total_seconds: fm.budget_spent.total_seconds + elapsed };
  fm.loopback_count += 1;

  // Evaluate the needs-human triggers on the UPDATED counters. A trigger routes to
  // the needs-human record (consumed by resume.ts) instead of the normal loopback
  // commit; absent a trigger the loopback proceeds. The return state for resume is
  // ALWAYS the producer's changes_requested loop state (`loopback.state`), so
  // resume returns to the right place for another round / a fresh budget.
  const trigger = evaluateNeedsHumanTrigger(fm, elapsed, deps.budget);
  if (trigger !== null) {
    fm.state = 'needs-human';
    fm.needs_human_reason = trigger;
    fm.needs_human_from = loopback.state;
    fm.updated = nowIso(deps);
    // The divergence invariant holds: the resting state is needs-human, so the
    // commit carries a `Workflow-Phase: needs-human` trailer. The reason rides the
    // commit body (same shape as the loopback commit) for the durable record.
    // commitMutation restores the pre-transaction file on any throw.
    commitMutation(
      deps,
      text,
      fm,
      body,
      withWorkflowPhaseTrailer(
        `workflow(${producer}): ${trigger} -> needs-human\n\n${opts.reason}`,
        'needs-human',
      ),
    );
    return {
      exitCode: EXIT_NEEDS_HUMAN,
      outcome: 'needs-human',
      phase: producer,
      fromState,
      toState: 'needs-human',
      message: `${trigger}: routed to needs-human (resume returns to ${loopback.state})`,
    };
  }

  fm.state = loopback.state;
  fm.updated = nowIso(deps);
  const message = withWorkflowPhaseTrailer(
    `workflow(${producer}): changes requested -> ${loopback.state}\n\n${opts.reason}`,
    loopback.state,
  );
  commitMutation(deps, text, fm, body, message);
  return { exitCode: EXIT_OK, outcome: 'changes-requested', phase: producer, fromState, toState: loopback.state };
}

// The §8 needs-human trigger decision — PURE over the already-accumulated front
// matter, the just-elapsed pass duration, and the injected budget ceilings.
// Returns the firing reason, or null when no trigger fires (loopback proceeds).
//
// Precedence (deterministic, DOCUMENTED): loopback-cap BEFORE total-budget BEFORE
// per-pass-ceiling. The cap is the operator's hard structural limit on rounds, so
// it is reported first; total budget is the global wall-clock limit; the per-pass
// ceiling is the narrowest (and optional/sparse) signal, so it is reported last.
// Both budget breaches map to the §2.1 `budget-exhausted` reason (there is no
// separate per-pass reason in the vocabulary — a per-pass ceiling is a budget
// exhaustion of the per-pass kind).
function evaluateNeedsHumanTrigger(
  fm: FrontMatter,
  passSeconds: number,
  budget: { totalSeconds: number; perPassSeconds?: number } | undefined,
): NeedsHumanReason | null {
  // (1) loopback-cap — independent of the injected budget; uses the front-matter
  // cap (hard-coded at 2; resume raises it via the extend-cap waiver). Fires when
  // the just-incremented round count exceeds the cap.
  if (fm.loopback_count > fm.loopback_cap) {
    return 'loopback-cap';
  }
  if (budget === undefined) {
    return null; // no total/per-pass ceiling configured => no budget trigger
  }
  // (2) total-budget — the accumulated spend reaches the configured total.
  if (fm.budget_spent.total_seconds >= budget.totalSeconds) {
    return 'budget-exhausted';
  }
  // (3) per-pass-ceiling — OPTIONAL/sparse: checked ONLY when configured. A single
  // pass exceeding the ceiling is a per-pass budget exhaustion.
  if (budget.perPassSeconds !== undefined && passSeconds > budget.perPassSeconds) {
    return 'budget-exhausted';
  }
  return null;
}

// Whole-second duration between the previous `updated` timestamp and now, clamped
// to >= 0 (an unparseable timestamp or a non-monotonic clock contributes 0).
function passDurationSeconds(prevUpdatedIso: string, nowMs: number): number {
  const prev = Date.parse(prevUpdatedIso);
  if (!Number.isFinite(prev)) return 0;
  const delta = Math.floor((nowMs - prev) / 1000);
  return delta > 0 ? delta : 0;
}
