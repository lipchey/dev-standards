---
name: deep-review-refactor
description: Repo-local deep code/architecture review (review-only) and behavior-preserving review-driven refactor (review-and-refactor); judges by repo-local review guides, never edits the executable surface, never lands to base itself. Runs only with explicit user consent, but OFFER it automatically when feature work completes - ask once whether to review that branch's changes (scope = diff vs base, not the whole repo).
---

# deep-review-refactor - Claude runtime adapter

Canonical Claude-runtime body (single source per ADR-003) for the repo-local
`deep-review-refactor` skill. The runtime skill wrappers under `.agents/skills/`
and `.claude/skills/` are thin static pointers at this file; do not duplicate it
into them (ADR-010). The shared, runtime-agnostic process rules live in the core
body; this file adds ONLY the Claude-runtime mechanics on top of it.

## FIRST - read the shared core (fail closed)

Before any other action - before the Run-setup asks, before any read, dispatch,
or edit - resolve the dev-standards root (`vendor/dev-standards` in a consumer,
`.` when running inside the dev-standards package) and Read the shared process
body at `<dev-standards-root>/agents/skill-sources/deep-review-core.md`. If that
file is missing or unreadable, **fail closed**: stop and report the blocker; do
NOT proceed on this adapter alone, since the core carries the consent, scope,
fan-out, matrix, fix-lifecycle, no-touch, and landing rules this adapter assumes.
The ADR-016 Stop gate does not enforce this core read (it anchors only
`review-contract.md` + the project required reads, below), so this instruction
is the enforcement.

The core defines WHAT the process does. This adapter defines HOW the Claude
runtime does it: the run-setup staffing asks, the profile-fan-out hosting and its
worker-route floor, the ADR-016 transcript gate, the external-Codex route
mechanics, and the main-session fix-phase mechanics. Claude default mode is
`review-only`; fix requires an explicit ask (`/deep-review --fix`) or upfront
Run-setup fix consent. Under the two-stage doctrine (ADR-019) this pass IS the
standard quality stage for feature work; consent decides WHEN it happens, not
WHETHER it is part of the work.

## Orchestration - the main session delegates the direct work, keeps the judgment

The main session runs this pass as an ORCHESTRATOR and strategic decision-maker,
not the worker that reads and edits itself: context is the scarce resource. It
offloads the heavy DIRECT work to subagents/workers and keeps only the decisions.

- **Delegated, to keep context lean:** per-finding code exploration and
  evidence-gathering (the CodeGraph/read fan-out), the profile fan-out (core C2,
  Opus- and/or Codex-staffed per Run setup), and - in fix mode - the mechanical
  slice authoring.
- **Never delegated, owned by the main session:** the Run-setup asks; every
  adversarial `VALID`/`INVALID`/`PARTIAL` verdict, the provenance-labeled merge
  (core C3), and the final report; the `classify` and `verify` gate calls; the
  fix-mode self-reviews (slice diff and whole fix-diff); and the `handoff` emit
  (landing stays a human's job, ADR-012).
- **The anchor carve-out (ADR-016, amended 2026-07-16):** only the ANCHOR reads
  stay gated on the main session - `review-contract.md` + the
  `deep_review.required_reads` project docs - because the Stop hook is
  fail-closed on the MAIN session's transcript for that set. The eight profile
  bodies are NOT main-gated: each is read by its profile route, and the main
  session separately reads the profiles its OWN role needs (the fix-mode
  self-reviews and any main-hosted route).

**Profile-fan-out hosting (ADR-018, amended ADR-020).** The mandatory,
non-collapsible fan-out (core C2) is hosted per profile as EITHER a dedicated
worker route (the default host) OR, under the **worker-route floor** (no external
worker route: headless, no delegation launcher, or workers declined), a
main-session lens pass over that ONE profile applied to saturation, one profile
at a time - still per-profile and differentiated, never a single all-profiles
sweep. Delegation is the default HOST for a route; it is not what makes the
fan-out required. Which MODEL staffs worker routes is the Run-setup Q1 choice.
The main session MERGES per-profile findings with `opus`/`codex`/`both`
provenance, adversarially verifies them, and assembles the coverage matrix (core
C3) from the routes' `COVERAGE` sections - the skill imposes a `COVERAGE` section
on ALL routes, so a main-hosted route is bound too. Overlay routing, the skip
banner, and the corpus roster are the core's (C2).

FIRST action of the review phase, both modes: the pass's initial `TodoWrite`
(below) additionally carries **one item per CORPUS profile route** AND one for
the coverage-matrix merge, each marked done only after that route returns / the
matrix is assembled - materializing the fan-out as tracked todos is what stops it
being silently collapsed under laziness or budget pressure.

## Mandatory guide reads - the ADR-016 transcript gate

Every pass MUST actually open (with the Read tool) each mandated ANCHOR guide
before it concludes. A `Stop`/`SubagentStop` hook parses the session transcript
and BLOCKS the pass from ending until the transcript shows a successful Read of
every required ANCHOR file (amended 2026-07-16 - the eight profile bodies moved
to their routes, so the main session no longer carries the whole corpus):

- the corpus CONTRACT `review-contract.md` under
  `<dev-standards-root>/agents/review-guide-templates/` (read in place). The
  `profile-*.md` lenses there are NOT main-gated (each is read by its route);
  `TRACEABILITY.md` is the loader-excluded canary registry, never a mandated read;
- the `review-contract.md` overlay in `deep_review.guides_dir` (default
  `.claude/review-guides/`) if present - other overlays are profile-route
  material, NOT main-gated, but the AVAILABILITY of every listed overlay stays
  fail-closed (an unreadable one blocks the pass);
- every `deep_review.required_reads` entry in `quality.json` (typically
  `.claude/project-facts.md`, `.claude/code-conventions.md`, `.claude/CHECKLIST.md`).

(The full nine-file corpus is still LOADED as a deployment-integrity check - a
missing or blank profile fails preflight - it is just no longer a main-session
required READ.)

FIRST action of any pass, both modes: `TodoWrite` one item per mandated anchor
file above PLUS the per-CORPUS-profile route and coverage-matrix items
(Orchestration), and mark each done ONLY after the Read / that route returns.
Only the ANCHOR is gated, so a partial Read of `review-contract.md` satisfies the
gate for that file; profile-route reads are discharged via the per-profile todos
and the coverage matrix, not the Stop hook.

**The guarantee, honestly.** Activation is model-independent: the harness stamps
`attributionSkill` on the transcript, not the model. Once a pass is detected
active the gate is fail-closed - an unloadable config, an un-establishable
required set, or any uncovered anchor blocks. Two honest limits: (1) detection in
v1 relies on a READABLE, sufficiently-FLUSHED transcript; the designed-but-unwired
`.artifacts/deep-review/active-<session>` marker would make activation
deterministic (deferred, ADR-016); (2) Claude Code force-continues after 8
consecutive Stop-blocks, so a determined skip becomes LOUD (8 recorded blocks
with the unread files named) rather than impossible. A Codex-staffed route reads
its two corpus files IN-BAND (it is outside the ADR-016 gate), but the MAIN
session's own transcript must still show the ANCHOR reads even when routes are
delegated, or the main `Stop` hook blocks.

**Escape hatch.** `DEEP_REVIEW_GUARD_OFF=1` disables the gate unconditionally
(the pressure valve for a gate bug that would otherwise brick sessions); ADOPTION
documents the out-of-band removal. Use it only to unblock a broken gate, never to
skip guides.

## Run setup (both modes) - two upfront asks + the profile-fan-out staffing

Runs FIRST after the core read, immediately on invocation, interactive sessions
only. In a delegated-worker or headless context (no user to ask; workers never
call external agents) skip this section, run at the defaults - the fan-out on
MAIN-SESSION lens passes under the worker-route floor (single-model, no external
Codex), report-only - and say so in the report.

1. ONE user prompt (AskUserQuestion or the harness equivalent) carrying BOTH
   questions, before any other work:
   - **Profile-worker mode** - how the core-C2 fan-out is staffed over the N
     applicable profiles: (a) N **Opus** workers, one per profile; (b) N
     **Codex** workers, one per profile; (c) BOTH - N Opus AND N Codex over the
     same profiles in parallel, the main session consolidating the two fleets per
     profile. Default `c`: it preserves the cross-model recall diversity (ADR-020)
     and the Codex half is flat-rate. Codex-staffed routes ALWAYS run read-only at
     FIXED `xhigh`; `ultra` is never auto-selected - only if the user explicitly
     asks in the moment (the per-run ultra confirmation the global Codex gates
     require). This choice governs ONLY the worker MODEL; it NEVER collapses the
     fan-out.
   - **After findings**: `report only` (default) or `fix all confirmed fixable
     findings` - "all" means every severity, not only P1 (see `classify`, ADR-024);
     high-effort/low-benefit findings escalate to you for a go/no-go. Consent here
     continues straight into `review-and-refactor` after the merged report with no
     second ask. An explicit `--fix` invocation already answers this - ask only
     the mode question.
2. Staff the fan-out per the chosen mode, dispatched IN THE BACKGROUND, then run
   the mode steps in parallel. Every review route is read-only regardless of the
   fix answer. A Codex-staffed route (modes b, c) runs ONE profile per process:

   ```bash
   PONYTAIL_DEFAULT_MODE=off codex exec -c sandbox_mode="read-only" \
     -c model_reasoning_effort="xhigh" \
     -o <profile-findings-file> - < <profile-prompt-file> > <profile-run-log> 2>&1
   ```

   Give EACH concurrent route its OWN unique `-o` findings path and run-log path
   (never a shared or hard-coded `/tmp` name). Codex is NOT reached by the ADR-016
   Stop gate (a separate runtime), so each route's prompt MUST carry that route's
   obligation IN-BAND: enumerate EXPLICITLY, by path, the two corpus files that
   route owns - `review-contract.md` and its assigned `profile-<lens>.md` - EACH
   with its same-named `.claude/review-guides/` overlay if it exists, PLUS any
   unmatched/legacy overlay broadcast to every route, and require Codex to
   actually OPEN and read each (never reason from memory) AND apply it. The route
   also reads the project must-reads (every `deep_review.required_reads` entry) but
   NOT the full corpus, and SKIPS `TRACEABILITY.md`. Then Codex applies its profile
   at the main pass's scope, cites the specific profile rule per finding, formats
   per `review-contract.md` (file:line + evidence + `COVERAGE`), and reports only -
   modifies no files. Feed the prompt on stdin from a file (never a shell-quoted
   arg); redirect stdout straight to the log (never through a pipe filter - it
   buffers to EOF and reads as a hang).
3. Independence + liveness. Verify each route's findings against the CODE with
   your own evidence (core C3), not a redundant per-profile pre-read; when a
   profile is dual-staffed (mode c), verify the Opus-route and Codex-route
   findings independently before merging so neither fleet anchors the other. Watch
   each background route's liveness = its log grows; ~3 min of silence → check the
   process; stalled → kill and retry that ONE route once; if it dies again, fall
   back to a main-session lens pass under the worker-route floor - record the
   profile as a `GAP` only when even that fallback is impossible (a growing ultra
   log means alive, not hung).
4. Consolidate (core C3). Adversarially verify EVERY delegated finding; the merged
   report is the union of survivors, deduped, each labeled with the route(s) that
   surfaced it (`opus`/`codex`/`both`) and its verdict, INVALID ones listed last
   with reasons. Assemble the required coverage matrix from the routes' `COVERAGE`
   sections.
5. Branch on the fix answer: report-only → stop after the merged report. Fix
   consent → continue into `review-and-refactor` on the merged set; a delegated
   finding enters the fix phase ONLY with a `VALID` verdict, and `classify` still
   decides fixable-now vs no-touch vs needs-plan. Codex unavailable → that route
   falls back to a main-session lens pass under the worker-route floor; if Opus
   workers are also unavailable the whole fan-out runs on main-session lens
   passes, single-model.

One PROFILE-REVIEW fan-out per request - it shares the run's budget (core C8); no
second staffing round of review routes inside the same invocation. (The fix-phase
fixer workers below are a DISTINCT, later fan-out - slice diffs, not findings -
not the "staffing round" barred here.)

## Fix phase - main-side authoring and the serialized apply/commit

`review-and-refactor` runs the core-C4 lifecycle
(`select-worktree → classify → commit-slice → self-review → verify → report → handoff`);
the Claude-runtime mechanics on top:

- **Delegated authoring, serialized apply + commit.** Once findings are validated
  the main session does NOT write fix code inline (worker-route floor aside): it
  dispatches ONE fixer subagent per `fixable-now` finding, several in parallel
  across findings with DISJOINT file sets. Each worker AUTHORS its slice IN
  ISOLATION (its own worktree/branch or a produce-only patch) with a PREFLIGHT
  focused-test run and returns the diff; it NEVER commits and never concurrently
  mutates the shared `deep-review/<slug>` worktree (`commit-slice`'s scope gate
  refuses when any out-of-slice path is dirty). The main session then processes
  the returned diffs ONE AT A TIME: apply to the review worktree, self-review, and
  invoke the serialized `commit-slice` (which runs the BINDING focused tests,
  stages exactly the slice, and commits) - never committing directly. Overlapping
  findings are ordered and re-based on the updated HEAD.
- **Worker-route floor:** fix mode active but no worker route exists (headless
  `--fix`, no delegation launcher, or workers declined) → the main session authors
  the slices itself, one finding at a time - the same floor the fan-out falls back
  to.
- The whole-diff self-review (core C5, vs `initial_head_sha`) and its
  `self-review --verdict` record are main-session-owned; a violation routes the
  refactor to `needs-human`. Any Codex Gate-C prompt over a produced FIX diff
  carries the same architecture/placement/conventions lens (cite
  `code-conventions.md`), never behavior-only.
