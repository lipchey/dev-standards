---
name: implement-plan
description: Use when the workflow reaches the implement-plan phase (state plan-consolidated or impl-changes-requested) to turn the consolidated plan into code test-driven and record it with the two-commit implement shape.
---

# implement-plan - canonical skill body

Canonical body (single source per ADR-003) for the `implement-plan` phase. The
runtime skill wrappers under `.agents/skills/` and `.claude/skills/` are thin
pointers at this file; do not duplicate this body into them (ADR-010).

Producer seat: Claude (ADR-008). `implement-plan` turns the consolidated plan
into code, test-driven, and records it with the two-commit implement shape.

## What kind of phase this is

A planning-file phase (frozen transition-table row, order 4) with a gate, a
`start`, and a TWO-COMMIT `complete`. Unlike the single-commit phases,
`complete implement-plan` makes two commits inside ONE held lock: a code commit
(no trailer), then the planning commit (with the trailer). It is
slash-syntax-agnostic: the contract is the `workflow` CLI below; any runtime
drives the same verbs directly.

## Trigger

- An armed pane runs `workflow await-and-launch implement-plan` (ADR-009):
  blocks until the gate opens, then launches the Claude seat. `await-and-launch`
  runs only the gate and launch, not `start` - this phase does. May also be run
  manually in the producer seat.
- Precondition (frozen table): state is one of `plan-consolidated`,
  `impl-changes-requested`. `plan-consolidated` is the first round;
  `impl-changes-requested` is a re-implement after `review-implementation`
  looped it back.

## Judgment steps (in order)

1. Claim the phase with `workflow start implement-plan`. It REQUIRES a clean
   tree (any pre-existing dirty change is refused, exit 11) and records
   `phases[implement-plan].start_sha` - the base the code commit is scoped from.
2. Implement STRICTLY to the consolidated plan, test-driven: write the failing
   test first, make it pass, then refactor. Add nothing beyond the plan's scope.
3. On a re-implement (`impl-changes-requested`), address every reviewer finding
   recorded in the loopback before re-completing.
4. Leave the implementation in the working tree. Do NOT hand-commit the code and
   do NOT stage the planning file: `complete implement-plan` performs BOTH
   commits. (Staging in-scope code paths is allowed; staging the planning file
   or any foreign path is refused, exit 11.)
5. The helper-owned front matter is transaction-written only; never hand-edit it
   (a front-matter vs HEAD-trailer mismatch is divergence, refused until
   `workflow recover` runs). Finish with `workflow complete implement-plan`.

## Contract block

```text
# 1. Gate
workflow gate implement-plan
#   -> proceed [plan-consolidated]        first round
#   -> proceed [impl-changes-requested]   re-implement after a review loopback
#   else wrong-state (11), naming: plan-consolidated, impl-changes-requested

# 2. Start - clean tree REQUIRED; records start_sha. ONE trailered commit.
workflow start implement-plan
#   plan-consolidated | impl-changes-requested  ->  implement-inprogress
#   trailer: Workflow-Phase: implement-inprogress
#   records phases[implement-plan].start_sha (base for the code-commit scope)

# 3. (implement to the plan, TDD; leave changes in the working tree)

# 4. Complete - TWO commits in ONE held lock:
workflow complete implement-plan
#   (1) CODE commit: all changes since start_sha EXCEPT the planning file, the
#       lock file, and the commit_exclude globs (quality.json
#       workflow.commit_exclude, e.g. reports/**, *.log, .DS_Store, tmp/**).
#       Staged one path at a time (never `git add -A` / `git add .`); must be
#       NON-empty (an empty code commit is refused, exit 11).
#       commit msg: "workflow(implement-plan): implementation"   (NO trailer)
#       complete_sha anchors on THIS commit.
#   (2) PLANNING commit: the planning file only, WITH the trailer.
#       implement-inprogress  ->  implemented        (resting state)
#       commit msg: "workflow(implement-plan): complete -> implemented"
#       trailer:    Workflow-Phase: implemented
#       sets phases[implement-plan].last_success_loop = loopback_count,
#            complete_sha = the code commit (1)
```

Transition fields (frozen table, order 4): preconditions
`{plan-consolidated, impl-changes-requested}`; start `implement-inprogress`;
success `implemented`; failure `implement-failed`. The durable authority is the
most-recent `Workflow-Phase` trailer reachable from HEAD, so the untrailed code
commit on top is read past to the `implemented` trailer on the planning commit -
no false divergence. The resting `implemented` state is
`review-implementation`'s precondition.
