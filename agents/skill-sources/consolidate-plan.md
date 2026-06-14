---
name: consolidate-plan
description: Use when the workflow reaches the consolidate-plan phase (state plan-reviewed) to fold approved review feedback into a single implementation-ready plan; usually skipped when review-plan approved with --approved.
---

# consolidate-plan - canonical skill body

Canonical body (single source per ADR-003) for the `consolidate-plan` phase.
The runtime skill wrappers under `.agents/skills/` and `.claude/skills/` are
thin pointers at this file; do not duplicate this body into them (ADR-010).

Producer seat: Claude (ADR-008). `consolidate-plan` folds approved review
feedback into a single implementation-ready plan. It is the one build-pipeline
phase that is FREQUENTLY SKIPPED.

## What kind of phase this is

A planning-file phase (frozen transition-table row, order 3) with a gate and
`start` / `complete` - but §2.9 / ADR-009 makes it conditional. When
`review-plan` is approved with `--approved` (zero blocking findings), the helper
auto-advances straight to `plan-consolidated` and marks THIS phase done in the
current round (`phases[consolidate-plan].auto_advanced = true`,
`last_success_loop = <loopback_count>`). Its `await-and-launch` then observes
the gate as ALREADY_DONE (exit 10) and exits WITHOUT launching an agent. The
phase runs as a real turn ONLY when `review-plan` completed WITHOUT `--approved`
(state rested at `plan-reviewed`).

It is slash-syntax-agnostic: the contract is the `workflow` CLI below; any
runtime drives the same verbs directly.

## Trigger

- An armed pane runs `workflow await-and-launch consolidate-plan` (ADR-009). In
  the common (approved) case it exits ALREADY_DONE immediately and launches
  nothing. It launches the Claude seat only when the state is `plan-reviewed`.
- Precondition (frozen table): state == `plan-reviewed`.

## Judgment steps (when run manually)

1. Claim the phase with `workflow start consolidate-plan`.
2. Read the review feedback (the `complete review-plan` / loopback commit body
   and the planning file) and fold every non-blocking finding into the plan,
   leaving a SINGLE implementation-ready plan. No new scope is introduced here.
3. The helper-owned front matter is transaction-written only; edit only the plan
   content (a front-matter vs HEAD-trailer mismatch is divergence, refused until
   `workflow recover` runs).
4. Keep the working change set to the planning file (a foreign STAGED path is
   refused, exit 11; unrelated UNSTAGED dirty files are left untouched, so keep
   them out of the index). Finish with `workflow complete consolidate-plan`.

## Contract block

```text
# 0. USUALLY SKIPPED: when review-plan was approved (--approved), the gate is
#    ALREADY_DONE (10) here and await-and-launch exits without launching.
workflow gate consolidate-plan
#   -> already-done [plan-consolidated]   auto-advanced; pane exits, no launch
#   -> proceed [plan-reviewed]            manual run: feedback to fold in
#   else wrong-state (11), naming: plan-reviewed

# 1. Start - ONE trailered commit.
workflow start consolidate-plan
#   plan-reviewed  ->  consolidate-inprogress
#   trailer: Workflow-Phase: consolidate-inprogress

# 2. (fold the review feedback into an implementation-ready plan)

# 3. Complete - ONE trailered commit (planning file only).
workflow complete consolidate-plan
#   consolidate-inprogress  ->  plan-consolidated     (resting state)
#   commit msg: "workflow(consolidate-plan): complete -> plan-consolidated"
#   trailer:    Workflow-Phase: plan-consolidated
#   sets phases[consolidate-plan].last_success_loop = loopback_count
```

Transition fields (frozen table, order 3): preconditions `{plan-reviewed}`;
start `consolidate-inprogress`; success `plan-consolidated`; failure
`consolidate-failed`. The resting `plan-consolidated` state is `implement-plan`'s
precondition - reached either by this phase (manual run) or by the
`review-plan --approved` auto-advance (the skipped case).
