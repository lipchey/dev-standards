---
name: deep-review-refactor-codex
description: Run a repo-local, consent-gated deep code and architecture review through Codex workers, then fix confirmed behavior-preserving findings by default. Use when the user explicitly invokes $deep-review-refactor-codex, asks Codex for a deep review/refactor against this repository's review guides, or accepts the one-time post-feature review-and-fix offer. Use review-only mode only when the user explicitly requests no edits. Never edit protected executable or policy surfaces and never land changes to the base branch.
---

# Deep review and refactor

Run the repository's deep review through Codex workers. Keep the main session as a
thin orchestrator: workers read the large inputs, produce durable artifacts,
implement changes, and review the result. The main session carries only consent,
compact status, blocking decisions, and the final user-facing summary.

This file is the Codex-runtime adapter over the shared process core. The Claude
skill remains separate at `agents/skill-sources/deep-review-refactor.md`. Do not
run this workflow when the user only asks to create, inspect, install, or update
the skill.

## First — read the shared core (fail closed)

Before creating the run workspace, reading review profiles, or dispatching any
stage, resolve `<dev-standards-root>` (`vendor/dev-standards` in a consumer, `.`
inside the package) and read the shared process body at
`<dev-standards-root>/agents/skill-sources/deep-review-core.md`. If that file is
missing or unreadable, **fail closed**: stop and report the blocker; do not
proceed on this adapter alone. The core carries the consent, tiering, Stage-0
preflight (including the conflict preflight), adaptive-discovery, triage/matrix,
fix-lifecycle, no-touch, caps, and landing rules this adapter assumes, and no
transcript gate enforces this read, so this instruction is the enforcement. This
adapter adds only the Codex-runtime mechanics: Codex-only workers, the durable
`run.json`/stage-owner workspace, the four-line worker response, the main-lean
prohibitions, the conflict-worker binding, and the cross-family final reviewer.

## Default behavior and consent

- Default to `review-and-refactor` at `STANDARD` tier: a direct
  `$deep-review-refactor-codex` invocation consents to the default review-and-fix
  workflow over the requested scope.
- Enter `review-only` only when the user explicitly asks for a report without
  edits. The automatic post-feature offer defaults to `LIGHT` review-only (core
  C0): accepting it consents to a report, NOT to edits - a fix run requires an
  explicit `STANDARD`/fix upgrade, and the offer itself is not consent even for
  that. `DEEP` is explicit opt-in only.
- Offer once per completed feature, scoped to its branch diff plus new untracked
  feature files. Do not re-ask after a decline or postponement, and do not create
  or update repository documentation solely to record that the review was not run.
- Except for the Stage-0 conflict preflight (core C1), never merge, rebase, push,
  open a PR, or land changes to the base branch.

## Use only Codex workers

- Use Codex workers exclusively for discovery, triage, implementation, and repair;
  the final reviewer is the named exception (below). Never ask the user to choose a
  worker model.
- From a Codex main session, use collaboration subagents and do not start nested
  `codex exec` processes. Run workers in batches when routes exceed concurrency.
- Prefer a fresh worker per stage or independent packet (`fork:none`, core C2); do
  not reuse a context-heavy review worker for planning, implementation, or review.
- If no Codex-worker route is available, stop and report the blocker; do not pull
  the full workflow into the main session.

## Keep the main session lean

The main session may establish/relay consent and scope, create the high-level plan,
run the Stage-0 deterministic gates as host commands (outputs to run files),
dispatch/wait/retry/stop workers, open the mandatory anchor files when a host
transcript gate requires proof (never the eight profile bodies for that gate), read
compact stage summaries and `run.json`, resolve a blocker needing user authority,
and deliver the final compact result. While worker routes are available it MUST
NOT read the full profile corpus, raw route reports, consolidated findings,
patches, or full review reports; paste large worker outputs into prompts; or
consolidate, estimate, author fixes, integrate, or review the final diff itself.
Pass file paths between stages, not copied content. Require every worker's final
message to contain only:

```text
STATUS: complete | blocked | failed
ARTIFACT: <path>
COUNTS: <compact stage-specific counts>
BLOCKER: <none or one concise blocker>
```

## Durable run workspace

Resolve `paths.reports` and the `deep_review` config from `quality.json`. Create
one unique run directory `<reports-dir>/deep-review-runs/<run-id>/` holding
`run.json` (run id, mode, tier, base/head SHA, scope path, budget deadline, current
stage, artifact paths, counts, status - kept small), `scope.txt`, and per-stage
artifacts named below. Workers update their own uniquely named artifacts; only the
stage owner updates shared stage outputs; never let concurrent workers write the
same file. Designate one Codex worker as each of Stages 1-4's owner; in fan-out
stages, route workers write unique files and the owner updates `run.json` after
checking them. The MAIN session populates `scope.txt`/`run.json` from its
host-run Stage-0 outputs per core C0/C1 (base resolution, tracked+staged+
untracked changes, preserve unrelated work, no widening, `quality.json`
fail-closed); model stage owners begin at Stage 1 and consume those artifacts.

## Stages 0-4

Stages 1-4 are executed by fresh Codex worker(s); Stage 0 is host-run. The main
session tracks only these plan items and reads only compact summaries plus
`run.json`:

1. **Stage 0 preflight (core C1)** — the MAIN session runs the deterministic
   gates itself as host commands with outputs to run files (they are cheap and
   non-model; delegating them to a worker is what core C1 forbids). When the
   non-mutating merge-tree check finds conflicts in a fix-capable run, the core
   C1 conflict-resolution worker is a Codex worker: **dispatch exactly one
   fresh, separate Codex worker dedicated only to conflict resolution**, with
   the exclusive isolated worktree, merge-not-rebase, and re-check semantics
   core C1 mandates. Do not dispatch any other worker concurrently with it.
2. **Stage 1 discovery (core C2)** — one read-only Codex worker per TRIGGERED route
   (the three risk routes plus the one combined structural route), each writing a
   unique `discovery/<route>.md` with the core-C2 output shape.
3. **Stage 2 triage + plan (core C3)** — ONE fresh Codex worker consolidates and
   plans in one pass, writing schema-valid `consolidated-findings.json`,
   `execution-plan.json` (each thematic packet records its immutable finding
   IDs, owned files, dependency order, execution wave, overlap notes, expected
   behavior preservation, focused tests, placement, and risk/effort - the proof
   core C4's chunking and any parallel claim rests on),
   and a compact `plan-summary.md` with the coverage matrix. A `classify`
   outcome that changes a packet's contents forces a re-plan of the affected
   packets. In `review-only` mode, stop after this stage and present the
   summary plus matrix.
4. **Stage 3 implementation (core C4)** — the stage owner runs `select-worktree`
   then `classify`; fresh thematic-chunk workers implement per core C4 in the
   canonical worktree, and each chunk worker EXECUTES its own `commit-slice`
   calls (the core-C4 actor binding for this runtime).
5. **Stage 4 final review + repair + verify + handoff (core C5)** — the final
   reviewer (below), repair, the final verify, then `report` and `handoff` per
   core C5, writing `final-summary.md` (counts, commit SHAs, verification
   status, residual risks, artifact paths). The main session reads only
   `final-summary.md` and `run.json`.

## The final reviewer — the named cross-family exception

Codex workers own discovery, triage, implementation, and repair; the final reviewer
is the named exception — one fresh read-only **Claude** reviewer over the diff from
`initial_head_sha` (no Claude route → core C5's disclosed same-family fallback). A
second reviewer is added only on the core-C5 trigger.

## No-touch and budget

The no-touch set is the shared safety floor in core C6; findings on protected paths
become plans only. Share one configured `deep_review` budget across all stages
(core C8): on exhaustion stop dispatching, preserve artifacts, mark unfinished
routes/packets as explicit `GAP`s, have the current stage owner write a compact
partial summary, and do not silently start a second pass.
