# dev-standards backlog

Non-blocking, dated. Newest first.

## 2026-07-10 — Descriptor-relative confinement for skill-wrapper generation — MOOT (Phase 2, 2026-07-10)

The confinement TOCTOU this tracked lived entirely in `generate-skill-wrappers.ts`,
which was **deleted in Phase 2** (the single surviving skill now ships static
wrappers guarded by `tests/runner/skill-wrappers-static.test.ts`; no runtime writes
wrapper files). No code path remains to harden — closed as moot.

## 2026-07-10 — Remove the workflow (L3) subsystem entirely — DONE (2026-07-10)

**Status: DONE (2026-07-10).** The workflow (L3) subsystem is removed: engine,
tests, the `build:workflow` esbuild target, the schema `workflow` block,
`validateWorkflow` + reviewer-independence checks, and the workflow-only config
fields are all gone; deep-review was decoupled from `workflow/` first. All gates
(test / typecheck / build / verify --full / standards-sync) green.

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

**Scope removed (completed 2026-07-10):**
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
- **Core `verify` shim lacks a build-freshness guard** (Gate P, Phase 1,
  2026-07-10). The core `verify` shim checks only
  bundle *existence*, not freshness; a stale gitignored `runner/dist/` runs
  blindly — violates guide rule quality-gates.md "build-on-demand artifacts
  need a build stamp + freshness check". CI is unaffected (bootstrap rebuilds
  every run); the footgun is local core dev. NB: the consumer's SHA-based
  `.built-from` stamp is **insufficient** for core — active core dev changes
  HEAD on every commit and leaves uncommitted edits, so a content-fingerprint
  of build inputs is needed, not a revision stamp. Owned by Phase 6 §5.
