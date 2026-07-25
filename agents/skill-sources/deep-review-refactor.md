---
name: deep-review-refactor
description: Repo-local deep code/architecture review (review-only) and behavior-preserving review-driven refactor (review-and-refactor); judges by repo-local review guides, never edits the executable surface, never lands to base itself. Runs only with explicit user consent, but OFFER it automatically when feature work completes - ask once whether to review that branch's changes (scope = diff vs base, not the whole repo).
---

# deep-review-refactor - Claude runtime adapter

Canonical Claude-runtime body (single source per ADR-003) for the repo-local
`deep-review-refactor` skill. The runtime skill wrappers under `.agents/skills/`
and `.claude/skills/` are thin static pointers at this file; do not duplicate it
into them (ADR-010) - wrapper generation is retired and
`tests/runner/skill-wrappers-static.test.ts` guards the drift. The shared, runtime-agnostic process rules live in the core
body; this file adds ONLY the Claude-runtime mechanics on top of it.

## FIRST - read the shared core (fail closed)

Before any other action - before the Run-setup asks, before any read, dispatch,
or edit - resolve the dev-standards root (`vendor/dev-standards` in a consumer,
`.` when running inside the dev-standards package) and Read the shared process
body at `<dev-standards-root>/agents/skill-sources/deep-review-core.md`. If that
file is missing or unreadable, **fail closed**: stop and report the blocker; do
NOT proceed on this adapter alone - the core carries the consent, tiering, Stage-0
preflight, adaptive-discovery, triage/matrix, fix-lifecycle, no-touch, caps, and
landing rules this adapter assumes. The ADR-016 Stop gate does not enforce this
core read (it anchors only `review-contract.md` + the project required reads), so
this instruction is the enforcement.

The core defines WHAT the process does. This adapter defines HOW the Claude
runtime does it: the tier+mode run-setup asks, the discovery-route hosting and its
worker-route floor, the ADR-016 transcript gate, the external-Codex mechanics, the
effort-ladder mapping, and the main-session fix mechanics. Claude default mode is
`review-only`; fix requires an explicit ask (`/deep-review --fix`) or upfront
Run-setup fix consent. Under the two-stage doctrine (ADR-019) this pass IS the
standard quality stage for feature work; consent decides WHEN, not WHETHER.

## Orchestration - the main session delegates the direct work, keeps the judgment

The main session runs this pass as an ORCHESTRATOR, not the worker that reads and
edits itself: context is the scarce resource.

- **Delegated, to keep context lean:** per-finding code exploration and evidence
  gathering, the adaptive discovery routes (core C2, Opus-staffed by default), and
  - in fix mode - the thematic-chunk slice authoring (core C4).
- **Never delegated, main-owned:** the Run-setup asks; every adversarial
  `VALID`/`INVALID`/`PARTIAL` verdict, the provenance-labeled merge, and the
  coverage matrix (core C3); the `classify` and `verify` gate calls; the fix-mode
  self-reviews (slice and whole-diff); and the `handoff` emit (landing stays a
  human's job, ADR-012).
- **The anchor carve-out (ADR-016, amended 2026-07-16):** only the ANCHOR reads
  stay gated on the main session - `review-contract.md` + the
  `deep_review.required_reads` docs - because the Stop hook is fail-closed on the
  MAIN session's transcript for that set. The eight profile bodies are NOT
  main-gated: each is read by its route, and the main session separately reads the
  profiles its OWN role needs (the fix-mode self-reviews and any main-hosted route).

The Stage-0 conflict worker (core C1) is hosted as an Opus subagent, or the main
session itself under the worker-route floor.

## Mandatory guide reads - the ADR-016 transcript gate

Every pass MUST actually open (with the Read tool) each mandated ANCHOR guide
before it concludes. A `Stop`/`SubagentStop` hook parses the session transcript
and BLOCKS the pass from ending until it shows a successful Read of every required
ANCHOR file:

- the corpus CONTRACT `review-contract.md` under
  `<dev-standards-root>/agents/review-guide-templates/` (read in place); the
  `profile-*.md` lenses there are NOT main-gated (each read by its route),
  `TRACEABILITY.md` is the loader-excluded canary registry, never a mandated read;
- the `review-contract.md` overlay in `deep_review.guides_dir` (default
  `.claude/review-guides/`) if present - other overlays are route material, NOT
  main-gated, but the AVAILABILITY of every listed overlay stays fail-closed;
- every `deep_review.required_reads` entry in `quality.json` (typically
  `.claude/project-facts.md`, `.claude/code-conventions.md`, `.claude/CHECKLIST.md`).

The full nine-file corpus is still LOADED as a deployment-integrity check (a
missing/blank profile fails preflight), just no longer a main-session required
READ. Honest limits: detection needs a readable, flushed transcript, and Claude
Code force-continues after 8 consecutive Stop-blocks, so a determined skip becomes
LOUD (8 blocks naming the unread files) rather than impossible. A Codex-staffed
route reads its corpus files IN-BAND (outside the gate), but the MAIN transcript
must still show the ANCHOR reads. **Escape hatch:** `DEEP_REVIEW_GUARD_OFF=1`
disables the gate unconditionally - use it only to unblock a broken gate, never to
skip guides.

## Run setup (both modes) - tier + mode, single-ecosystem staffing

Runs FIRST after the core read, interactive sessions only. In a delegated-worker
or headless context skip this section and run at the defaults - discovery on
MAIN-SESSION lens passes under the worker-route floor (single-model, no external
Codex), report-only - and say so in the report.

1. ONE user prompt (AskUserQuestion or equivalent) carrying BOTH questions:
   - **Tier** (core C0): `LIGHT` / `STANDARD` / `DEEP`. Default to the context -
     `LIGHT` when arriving from the automatic post-feature offer, `STANDARD` for a
     direct invocation; `DEEP` is explicit-only, never a default and never
     auto-escalated mid-run.
   - **Mode**: `report only` (default) or `fix all confirmed fixable findings` -
     "all" means every severity, not only P1 (see `classify`, ADR-024);
     high-effort/low-benefit findings escalate to you for a go/no-go. An explicit
     `--fix` already answers this.
2. Staff the TRIGGERED discovery routes (core C2) SINGLE-ECOSYSTEM by default - N
   Opus workers, one per triggered route - dispatched in the BACKGROUND. Dual
   fleets (Opus AND Codex over the same routes, the main session consolidating
   both per route) run ONLY on explicit request; the Codex half is read-only via
   the snippet below. Set each worker's reasoning effort per the core-C8 ladder
   (top effort for security/correctness discovery and final review; medium for the
   structural/hygiene route and mechanical chunks; `ultra` only on explicit
   per-run request) - the ladder deliberately supersedes the former fixed-xhigh
   pin for dual-fleet Codex routes (ADR-026). Every review route is read-only
   regardless of the fix answer.
   FIRST action, both modes: `TodoWrite` one item per mandated anchor read PLUS one
   per TRIGGERED route and one for the coverage-matrix merge, each done only after
   the Read / that route returns - materializing discovery as tracked todos is what
   stops it collapsing under budget pressure.
3. A Codex process (a dual-fleet route OR the cross-family final reviewer) runs one
   task per process, read-only:

   ```bash
   PONYTAIL_DEFAULT_MODE=off codex exec -c sandbox_mode="read-only" \
     -c model_reasoning_effort="<laddered>" \
     -o <out-file> - < <prompt-file> > <run-log> 2>&1
   ```

   Give EACH concurrent process its OWN unique `-o` and log path (never shared or
   hard-coded `/tmp`). Codex is outside the ADR-016 gate, so its prompt MUST carry
   that task's core-C2 reads IN-BAND, by path (for a route: the contract + its
   assigned profile + overlays + project must-reads, skipping `TRACEABILITY.md`),
   and require Codex to actually OPEN and apply each. Feed the prompt on stdin from
   a file (never a shell-quoted arg); redirect stdout straight to the log (never
   through a pipe filter - it buffers to EOF and reads as a hang).
4. Liveness: watch each background route's log grow; ~3 min of silence → check the
   process; stalled → kill and retry that ONE route once; dead again → fall back to
   a main-session lens pass under the worker-route floor; record a `GAP` only when
   even that fallback is impossible.
5. Consolidate (core C3): adversarially verify EVERY finding against the code; the
   merged report is the union of survivors, deduped, each labeled with its route(s)
   (`opus`/`codex`/`both`) and verdict, INVALID last with reasons; assemble the
   required coverage matrix. When a route is dual-staffed, verify the Opus and
   Codex findings independently before merging so neither fleet anchors the other.
6. Branch on the mode: report-only → stop after the merged report (the core-C5
   final review governs a PRODUCED fix diff; a report-only pass has none). Fix
   consent → continue into `review-and-refactor` on the merged set - a finding
   enters the fix phase ONLY with a `VALID` verdict, and `classify` still
   decides fixable-now vs no-touch vs needs-plan - then run the core-C5 final
   review over the produced diff from `initial_head_sha`: ONE fresh read-only
   Codex reviewer (the snippet above - cross-family, since the main runtime is
   Claude; no Codex route → core C5's disclosed same-family fallback); a SECOND
   reviewer only on the core-C5 trigger.

## Fix phase - main-side authoring and the serialized commit

`review-and-refactor` runs the core-C4 lifecycle; the Claude mechanics on top:

- **Delegated authoring, serialized commit.** The main session dispatches fresh
  thematic-chunk workers (core C4, 2-4 related findings on one seam), each
  authoring IN ISOLATION (own worktree/branch or produce-only patch) with a
  PREFLIGHT focused-test run and returning the diff; a worker NEVER commits and
  never mutates the shared `deep-review/<slug>` worktree. The main session (or a
  user-approved bypass mode) then invokes the serialized `commit-slice` ONE finding
  at a time - apply, self-review, commit through the CLI - never committing
  directly. Overlapping findings are ordered and re-based on the updated HEAD.
- **Worker-route floor:** fix mode with no worker route (headless `--fix`, no
  launcher, or workers declined) → the main session authors the slices itself, one
  finding at a time.
- The whole-diff self-review (core C5, vs `initial_head_sha`) and its
  `self-review --verdict` record are main-owned; a violation routes the refactor to
  `needs-human`. Any Codex Gate-C prompt over a produced FIX diff carries the same
  architecture/placement/conventions lens (cite `code-conventions.md`), never
  behavior-only.
