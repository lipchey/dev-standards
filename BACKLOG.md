# dev-standards backlog

Non-blocking, dated. Newest first.

## 2026-07-10 — Remove the workflow (L3) subsystem entirely

**Decision (owner):** drop the workflow feature from dev-standards altogether.

**Why.** The workflow engine is built around an autonomous, **write-capable
Codex "reviewer seat"** (ADR-008): a second-model agent that reviews, commits
trailers, and drives the feature state machine forward on its own. That is the
opposite trust model from how these standards are actually used — **Codex is a
read-only advisor; a human/Claude producer verifies and commits** (the
Cross-Check Gates). The subsystem is therefore adopted-disabled by the first
pilot (ai-prompter sets `workflow.enabled:false`) and is expected to stay off.
Meanwhile it carries the largest defect + maintenance surface in the repo
(the deep review found 21 P1s concentrated in `workflow/`: STATE-across-worktrees,
lock split-brain, git option-injection, secret-in-history, fail-open scanners),
none of which is worth fixing for a feature no one runs. Removing it also
realigns the code with the README's stated "Phase 1a Scope" (runner +
disabled-workflow manifest only), which the built-out workflow silently
contradicts (INT-05).

**Scope of removal (do at execution time, not now):**
- Delete `workflow/src/**`, `workflow/dist/`, `tests/workflow/**` (~261 tests),
  the `build:workflow` esbuild target, and the workflow globs in the `test`
  script (`package.json`).
- Remove the `workflow` block from `schemas/quality.schema.json` (ADR-012) and
  `validateWorkflow` + reviewer-independence checks from `runner/src/validate.ts`.
- Drop workflow-only config fields (`cmux_mode`, `loopback_mode`,
  `reviewer_independence`, ship/notify, workflow timeouts/budget).
- Prune workflow references from `agents/` (skill-catalog, skill-sources) and
  fix/retire ADR-008 / ADR-012.
- **Verify deep-review does not import from `workflow/`** before deletion; if it
  shares a util, lift the util into `runner/` or `deep-review/` first.
- Update README to match (it already claims workflow is unimplemented).

**Effort:** L (large deletion + schema/validator surgery + doc realignment).
**Blocks nothing.** Does not affect the runner (L1) or deep-review adoption.
Independent of the in-flight core-hardening batch (which already leaves
`workflow/` untouched).

## Related core-backlog (from ai-prompter pilot, non-blocking)

- Commit an ADR decision log — ADR ids/§ currently hang inline in code with no
  canonical record.
- Resolve ADR-011 "review-chain" naming collision with the downstream
  `codex-chain` skill.
