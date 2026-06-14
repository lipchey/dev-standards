---
name: plan
description: Use when the workflow reaches the plan phase (state created or plan-changes-requested) to author or re-author the implementation plan in the planning file before review-plan critiques it.
---

# plan - canonical skill body

Canonical body (single source per ADR-003) for the `plan` phase. The runtime
skill wrappers under `.agents/skills/` and `.claude/skills/` are thin pointers
at this file; do not duplicate this body into them (ADR-010).

Producer seat: Claude (ADR-008). `plan` is the first build-pipeline producer
phase: it authors the implementation plan that `review-plan` then critiques.

## What kind of phase this is

Unlike `process-review`, `plan` IS a planning-file phase. It has a frozen
transition-table row (order 1), a gate, and `start` / `complete` transactions.
Its contract is therefore a gate invocation, a `start` claim, and a `complete`
call, all documented in the Contract block at the end of this file.

The phase is slash-syntax-agnostic: a runtime may surface it as a slash command,
but the contract is the `workflow` CLI described below. Any runtime without
slash commands drives the same verbs directly.

## Trigger

- An armed pane runs `workflow await-and-launch plan` (ADR-009): it blocks at
  zero token cost until the gate opens, then launches the Claude seat for this
  phase. `await-and-launch` runs only the gate and the launch; it does NOT call
  `start` - this phase does (step 2 below). The phase may also be run manually
  in the producer seat.
- Precondition (frozen table): state is one of `created`,
  `plan-changes-requested`. `created` is the first round;
  `plan-changes-requested` is a re-plan after `review-plan` looped the plan back.

## Judgment steps (in order)

1. Read the feature brief/intent, the planning-file body, and - on a re-plan -
   the reviewer's findings recorded in the loopback commit body and the plan.
2. Claim the phase with `workflow start plan` before writing. It advances the
   state to `plan-inprogress`, records the base sha, and claims the seat;
   `complete` later refuses unless the state is `plan-inprogress`.
3. Author the implementation plan in the planning-file body. Pin contracts and
   interfaces as code; describe all other logic in prose. Make it
   implementation-ready and test-driven (each unit independently testable).
4. On a re-plan, resolve every blocking finding from the prior review. Do not
   silently drop one: address it or explicitly rebut it in the plan.
5. The helper-owned workflow front matter (state, phases, counters, claimed_by)
   is written ONLY by the transactions. Never hand-edit it: a front-matter vs
   HEAD-trailer mismatch is divergence, which the gate and every transaction
   refuse (exit 13) until `workflow recover` runs. Edit only the plan content.
6. Keep the working change set to the planning file. The `complete` commit must
   contain exactly the planning file; a foreign staged/dirty path is refused
   (commit-scope, exit 11).
7. Finish with `workflow complete plan`.

## Contract block

```text
# 1. Gate - confirm it is this phase's turn (await-and-launch runs this; the
#    seat may re-check). PROCEED (exit 0) only at a plan precondition.
workflow gate plan
#   -> proceed [created]                 first round
#   -> proceed [plan-changes-requested]  re-plan after a review loopback
#   else wrong-state (11), naming: created, plan-changes-requested

# 2. Start - claim the seat and open the working state. ONE trailered commit.
workflow start plan
#   created | plan-changes-requested  ->  plan-inprogress
#   commit msg: "workflow(plan): start -> plan-inprogress"
#   trailer:    Workflow-Phase: plan-inprogress
#   records phases[plan].start_sha, +1 attempt, claimed_by = caller

# 3. (author / refine the Plan in the planning-file body)

# 4. Complete - ONE trailered commit (planning file only); worktree left clean.
workflow complete plan
#   plan-inprogress  ->  plan-ready          (resting state)
#   commit msg: "workflow(plan): complete -> plan-ready"
#   trailer:    Workflow-Phase: plan-ready
#   sets phases[plan].last_success_loop = loopback_count
```

Transition fields written (frozen table, order 1): preconditions
`{created, plan-changes-requested}`; start `plan-inprogress`; success
`plan-ready`; failure `plan-failed` (written only if a repo hook rejects the
transition commit). The resting `plan-ready` state is exactly `review-plan`'s
precondition.
