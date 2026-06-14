---
name: deep-review-refactor
description: Manual-only repo-local deep code/architecture review (review-only) and behavior-preserving review-driven refactor (review-and-refactor); judges by repo-local review guides, never edits the executable surface, never lands to base itself.
---

# deep-review-refactor - canonical skill body

Canonical body (single source per ADR-003) for the repo-local
`deep-review-refactor` skill. The runtime skill wrappers under `.agents/skills/`
and `.claude/skills/` are thin pointers at this file; do not duplicate this body
into them (ADR-010).

## When to use / trigger

Manual-only. A human explicitly asks for a deep pass; the skill never fires on
every diff, and never on ordinary implementation or verification work. Two modes
only:

- `review-only` (default) - prioritized findings, change nothing.
- `review-and-refactor` (explicit ask, e.g. `/deep-review --fix`) - find the
  issues and immediately fix the fixable ones in one command.

This is the on-demand, deep layer. It pairs with the always-on
`core-code-guidelines.md` baseline - the cheap rules every coding task applies -
and owns the long tail beyond it: the edge cases the baseline deliberately defers
so it can stay short and noise-free. The baseline handles routine work; breadth
is this skill's job, on request only.

## Mode: review-only (default)

Produce findings; change nothing. The runtime is six steps, in order:

1. Context. Read `project-facts.md` (layer DAG, domain terms, sensitive and
   no-touch zones, known false positives), then `AGENTS.md` and `CLAUDE.md`.
2. Deterministic first. Run or inspect the existing deterministic reports -
   `./verify --fast` or `reports/quality/` - and never repeat a finding ESLint,
   `tsc`, Knip, dependency-cruiser, or gitleaks already owns. This skill is
   judgment-only; it does not duplicate a gate.
3. CodeGraph first for architecture, navigation, and impact questions.
4. Judge against the repo-local guides - `architecture-deepening.md`,
   `clean-architecture.md`, `refactoring-checklist.md`, and
   `language-review-sources.md` - applied only to judgment areas: boundaries,
   dependency direction, naming, cohesion, duplication, test design, behavior
   preservation, and needless complexity. Rules are conditional: SOLID strong for
   class-heavy TS, light for script-style TS pipelines, not for Bash or n8n glue.
5. Output per `review-output-format.md`: prioritized findings - P1 breaks
   adoption, safety, or behavior; P2 is concrete correctness or maintainability;
   P3 is improvement or clarity - each with file/line, impact, risk level, and a
   recommended smallest refactor slice. A finding that needs redesign is described
   as a plan, not an edit.
6. Stop after findings. No edits, no commits.

## Mode: review-and-refactor (explicit ask)

One command, run inside a git worktree: an internal review (phase 1, the
`review-only` steps above) followed by a fix phase (phase 2).

Worktree selection. If the skill runs inside an active workflow-feature worktree
(detected by a `workflow-session-planning.md` marker at the worktree root), it
reuses that worktree and hands the branch back to that session's ship cycle.
Otherwise it creates a dedicated `deep-review/<slug>` worktree from the current
base, commits there, and leaves it for human review.

Classify each finding into `fixable-now`, `no-touch`, or `needs-plan`.

Slice by slice (atomic), fixable-now only:

1. Make one smallest behavior-preserving slice.
2. Run focused tests for the touched area.
3. Green: commit that slice alone, carrying a `Deep-Review-Slice: <finding-id>`
   trailer.
4. Red: revert that slice only, mark the finding `fix-failed`, and move it to the
   plan. Never carry a broken slice forward.

Final verification. Run `./verify --fast` across the applied slices in the
worktree - the skill's own changes only, no base integration. Red means the whole
refactor is `needs-human`; nothing is merged.

Report to `reports/quality/deep-review-<date>.md`, metadata-only and
secret-scanned: the fixed slices with their SHAs, the rejected buckets (no-touch,
needs-plan, fix-failed), and the plan for the latter two.

## No-touch set

The no-touch set is the UNION of two parts:

1. A fixed, skill-owned baseline a repo cannot remove - the executable surface:
   `.githooks/`, `.github/workflows/`, `./verify`, `tools/`, `auth/**`, and
   `credentials/**`.
2. The repo's own additions, listed in the `## No-Touch Zones` section of
   `project-facts.md`.

A path in either set is never edited - it is emitted as a plan instead.
`project-facts.md` can only extend the baseline, never shrink it.

## Landing is not the skill's job (ADR-012)

The skill never merges to base itself. Its autonomy ends at a committed worktree
branch.

- Inside a workflow session: it hands the committed branch to the ADR-012 PR ship
  cycle - `workflow ship`, then human PR review, then `process-review`, then
  merge, then `cleanup`. The skill does not drive that cycle; it hands off to it.
- Standalone: it leaves a committed branch for a human to open and review as a PR.

There is no local merge verb and no local merge gate for this skill to call -
ADR-012 replaced those with the GitHub PR ship cycle. Landing always goes through
that cycle or a human.

## Why this preserves "self-monitoring, not self-healing"

- The trigger is always manual.
- Edits are behavior-preserving and individually verified.
- The executable surface is never edited autonomously.
- Landing to base is always behind the PR ship cycle or a human.
- Autonomy is bounded to "propose and prepare a verified diff", never "silently
  change the base branch".

## Budget

One pass per request, governed by the `deep_review` block in `quality.json`. The
`seconds` ceiling is the enforced control; the `tokens` ceiling is optional, and
`null` means unbounded. On exhaustion, record what was and was not reviewed, then
stop - do not spawn another pass.
