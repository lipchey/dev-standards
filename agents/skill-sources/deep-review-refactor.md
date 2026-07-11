---
name: deep-review-refactor
description: Manual-only repo-local deep code/architecture review (review-only) and behavior-preserving review-driven refactor (review-and-refactor); judges by repo-local review guides, never edits the executable surface, never lands to base itself.
---

# deep-review-refactor - canonical skill body

Canonical body (single source per ADR-003) for the repo-local
`deep-review-refactor` skill. The runtime skill wrappers under `.agents/skills/`
and `.claude/skills/` are thin static pointers at this file; do not duplicate this
body into them (ADR-010). Generation was retired in Phase 2 (2026-07-10): the
wrappers are committed statically and guarded by `tests/runner/skill-wrappers-static.test.ts`.

## When to use / trigger

Manual-only. A human explicitly asks for a deep pass; the skill never fires on
every diff, and never on ordinary implementation or verification work. Two modes
only:

- `review-only` (default) - prioritized findings, change nothing.
- `review-and-refactor` (explicit ask, e.g. `/deep-review --fix`) - find the
  issues and immediately fix the fixable ones in one command.

This is the on-demand, deep layer. It pairs with the always-on
`core-code-guidelines.md` baseline but does not assume it satisfied: the deep
pass SUBSUMES the baseline - it re-checks the baseline's rules on the code under
review (code can be written before the baseline existed, or slip past it) - and
above that re-check owns the long tail: the edge cases the baseline deliberately
defers so it can stay short and noise-free. The baseline handles routine work;
this pass re-applies it and adds breadth, on request only.

## Mode: review-only (default)

Produce findings; change nothing. The runtime is six steps, in order:

1. Context. Read `.agents/project-facts.md` (layer DAG, domain terms, sensitive
   and no-touch zones, known false positives), then `AGENTS.md` and `CLAUDE.md`.
2. Deterministic first. Run or inspect the existing deterministic reports -
   `./verify --fast` or `reports/quality/` - and never repeat a finding ESLint,
   `tsc`, Knip, dependency-cruiser, or gitleaks already owns. This skill is
   judgment-only; it does not duplicate a gate.
3. CodeGraph first for architecture, navigation, and impact questions.
4. Judge against the repo-local review guides. The guides live in the guides dir
   - `deep_review.guides_dir` in `quality.json`, default `.agents/review-guides/`
   - seeded on bootstrap (copy-if-absent) and owned by the repo. Confirm the set
   is complete BEFORE judging: run
   `vendor/dev-standards/scripts/seed-review-guides.sh . --check` (the submodule
   mounts at `vendor/dev-standards` by convention). Each canonical guide it
   reports missing is itself a P1 finding ("review guides not seeded - run
   `vendor/dev-standards/scripts/seed-review-guides.sh .`"); review-only proceeds
   on whatever guides are present. (In `review-and-refactor`, an incomplete set
   stops the run before `select-worktree`; the engine preflight enforces the same
   fail-closed.) Apply the present guides in this order:
   - (a) the baseline `core-code-guidelines.md` - ALWAYS, and explicitly: the
     deep pass re-applies its rules on the code under review, it does not treat
     them as already met.
   - (b) `language-review-sources.md` - a router: load only the section for the
     surface's stack, not the whole file.
   - (c) the area guides (`clean-architecture.md`, `architecture-deepening.md`,
     `refactoring-checklist.md`, `security-review.md`) - each per its own
     conditionality banner.
   - (d) any additional repo-owned `.md` in the guides dir - also judgment
     sources.
   - (e) `review-output-format.md` - output shape only (step 5), never a review
     lens.
   Apply them only to judgment areas: boundaries, dependency direction, naming,
   cohesion, duplication, test design, behavior preservation, and needless
   complexity. Rules are conditional: SOLID strong for class-heavy TS, light for
   script-style TS pipelines, not for Bash or n8n glue.
5. Output per `review-output-format.md`: prioritized findings - P1 breaks
   adoption, safety, or behavior; P2 is concrete correctness or maintainability;
   P3 is improvement or clarity - each with file/line, impact, risk level, and a
   recommended smallest refactor slice. A finding that needs redesign is described
   as a plan, not an edit.
6. Stop after findings. No edits, no commits.

## Mode: review-and-refactor (explicit ask)

One command, run inside a git worktree: an internal review (phase 1, the
`review-only` steps above) followed by a fix phase (phase 2), driven by the
engine's own CLI verbs, in this order:

`select-worktree -> classify -> commit-slice -> verify -> report -> handoff`

Every verb after `select-worktree` takes `--findings <path>`, a findings JSON
file under `reports/quality/` that carries the running state (id,
classification, status, sha) across the whole run.

1. `select-worktree` creates a dedicated `deep-review/<slug>` worktree from the
   current base and prints it; every later verb runs inside that worktree.
2. `classify` assigns each finding a classification (`fixable-now`, `no-touch`,
   `needs-plan`) against the §2.5 no-touch floor and writes it back to the
   findings file. **Fail-closed**: in fix mode, a missing, unreadable, or
   unparseable `.agents/project-facts.md` makes the engine refuse outright
   instead of silently classifying against the baseline floor alone - a false
   "editable" verdict here would risk auto-editing a path the repo meant to
   protect.
3. `commit-slice <finding-id>` runs the atomic fix loop, `fixable-now` findings
   only:
   - Make one smallest behavior-preserving slice.
   - Run focused tests for the touched area.
   - Green: commit that slice alone, carrying a
     `Deep-Review-Slice: <finding-id>` trailer.
   - Red: revert that slice only, mark the finding `fix-failed`, and move it to
     the plan. Never carry a broken slice forward.
4. `verify` runs the final `./verify --fast`/`--full` gate across the applied
   slices in the worktree - the skill's own changes only, no base integration.
   Red means the whole refactor is `needs-human`; nothing proceeds to handoff.
5. `report` writes `reports/quality/deep-review-<date>.md`, metadata-only and
   secret-scanned: the fixed slices with their SHAs, the rejected buckets
   (no-touch, needs-plan, fix-failed), and the plan for the latter two.
6. `handoff` emits the ADR-012 landing instruction once verify is green and no
   blocking findings remain - it lands nothing itself (see below); a human
   opens the PR from there.

## No-touch set

The no-touch set is the UNION of two parts:

1. A fixed, skill-owned baseline a repo cannot remove - the executable surface:
   `.githooks/`, `.github/workflows/`, `./verify`, `tools/`, `auth/**`, and
   `credentials/**`.
2. The repo's own additions, listed in the `## No-Touch Zones` section of
   `.agents/project-facts.md`.

A path in either set is never edited - it is emitted as a plan instead.
`.agents/project-facts.md` can only extend the baseline, never shrink it.

## Landing is not the skill's job (ADR-012)

The skill never merges to base itself. Its autonomy ends at a committed worktree
branch: it leaves a committed `deep-review/<slug>` branch for a human to open and
review as a PR. It does not land, and it names no automated ship cycle.

There is no local merge verb and no local merge gate for this skill to call -
ADR-012 replaced those with the GitHub PR ship cycle. Landing always goes through
a human opening that PR.

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
