# dev-standards backlog

Non-blocking, dated. Newest first.

## 2026-07-14 — diff-coverage: CI push `event.before` base-ref wiring (N3, parked)

`diff-cover.mjs` defaults to `origin/main` (pre-push semantics; PR CI is
correct at fetch-depth 0). A CI push-to-main run measures an empty range →
N/A: the same commits were already measured by the local pre-push full tier.
Wiring `event.before` (workflow env → `--base-ref`) only matters once CI
becomes an enforcement surface — decide TOGETHER WITH the blocking flip per
`docs/CALIBRATION.md`, not before (edge cases: all-zero `before` on a new
branch, force-push history loss). (N3 low-level plan D3; mirrors the N1
PR-CI index bridge parking.)

## 2026-07-14 — PR-CI index bridge for check-new-deps (N1 Gate P, parked)

`check-new-deps` reads git index-blobs only, so in PR CI (clean checkout,
index == HEAD) its `git_staged`-sourced `skip_if_empty` fileset is empty and
the check is `skipped` — core CI contributes zero coverage and zero
calibration telemetry for it; the enforcement surface is local
`./verify --fast` (core) and the pre-commit `--staged` hook (consumers). A
bridge — `git reset --soft $(git merge-base origin/<base> HEAD)` before
`./verify --fast` in the PR job, plus non-shallow fetch-depth — would present
the PR delta as a staged index without crossing the index-blob invariant.
Decide TOGETHER WITH the blocking flip per `docs/CALIBRATION.md`, not before:
report-only telemetry comes from local runs; a CI bridge only matters once
the gate blocks. (N1 low-level plan D1; Gate P finding, Codex P1/PARTIAL.)

## 2026-07-14 — Hermetic installer/updater test suite (Gate P F13) — DONE (2026-07-14)

**Status: DONE (2026-07-14).** `tests/e2e-adoption-kit.sh` is the hermetic suite
(local file:// bare upstream, `protocol.file.allow` scoped via `GIT_CONFIG_*` env,
no GitHub). It now covers, end-to-end (`RESULT: 56 passed, 0 failed`): fresh
non-Node install + idempotent re-run + gitlink-at-latest-tag, dirty-tree abort,
bad `--ref` abort, predates-kit reject + `--rollback` clean, pin bump
(gitlink-only commit, clean tree), forced-red bump **auto**-rollback (old pin +
stamps restored), `--keep-on-failure` + manual restore, dirty-consumer skip, plus
the two added closers — **F** mid-seed install fault (a PATH-shadowed `npm` that
passes the existence-only preflight but fails at the submodule `npm ci`: state
LEFT under `.git/ds-install.{state,journal}`, NO auto-rollback, `--rollback`
cleans) and **G** SIGINT mid-seed (foreground wrapper so the INT trap is
trappable — an async process would inherit `SIGINT=SIG_IGN`; exit 130, state
LEFT, `--rollback` cleans). Both pin the fault to the intended vendor `npm ci`.
Run via `npm run test:adoption` (kept out of `npm test`: the happy path needs
network + ~10 min). Post-v0.9.1 rollback semantics (install = manual-undo-only;
update-pins = auto-rollback default) are locked in. Effort M.

## 2026-07-14 — Template-migration policy for consumer-owned shims (Gate P F11)

Pin updates rebuild bundles but never re-sync the consumer-owned shims/hooks/CI
that `seed-consumer.sh` laid down copy-if-absent (`scripts/verify`,
`scripts/deep-review`, `.githooks/*`, `.github/workflows/verify.yml`,
`ds-bootstrap.sh`, `install-gitleaks.sh`, `tools/run-gitleaks`). When a newer pin
changes a shim's expected contract, an old consumer copy silently drifts. Define
a policy: version/stamp the templates, detect drift on `--check`, and offer an
opt-in re-seed that respects consumer edits. Effort M.

## 2026-07-14 — Non-Node worktree create/reuse test (Gate P F4) — DONE (2026-07-14)

**Status: DONE (2026-07-14).** `tests/deep-review-e2e/worktree.test.ts` gains a
non-Node consumer (empty `node_modules/`, no `package-lock.json`)
create-then-reuse test: select-worktree twice reuses the same worktree (asserted
by an unchanged run-descriptor `run_id`, so a silent remove-and-recreate can't
masquerade as reuse) with the `node_modules` symlink resolving both times; a
negative third run (main `node_modules` removed) must refuse with
`EXIT_WRONG_STATE` + stale-tooling — so the unconditional-symlink contract can't
regress. Effort S.

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

## Deep-review hardening backlog (2026-07-14 systemic-gaps Gate C, non-blocking)

- **Bake policy sources into the engine no-touch baseline.** `no-touch.ts`
  protects the executable surface but not the policy the new self-review gate
  judges by (`.claude/code-conventions.md`, `.claude/project-facts.md`, the
  `deep_review.guides_dir` overlays): a fix slice could weaken policy before
  judging itself. Interim: consumers list those paths in their project-facts
  No-Touch Zones (pilot does as of the v0.14.0 adoption). Fix: add them to the
  skill-owned baseline + attempted-policy-edit slice tests.
- **Same-pin rebuild window in the dist snapshot.** `snapshotDist` stamps are
  `rev-parse HEAD`; a concurrent re-bootstrap at the SAME pin (e.g. dirty-tree
  rebuild) can swap bundle content mid-copy without moving the stamp. Needs a
  bootstrap/copy lock or a content fingerprint (same mechanism as the core
  verify freshness item above). Documented ceiling in `snapshotDist`.
- **Persist the fix-diff self-review verdict.** The skill's final self-review
  is orchestrator prose; a standing violation has no engine state, so nothing
  mechanically blocks a later `verify`+`handoff`. Fix: a self-review verdict
  bound to HEAD in the findings file, required green by `verify`/`handoff`.
- **node_modules/.tools symlinks are a shared-mutation window.** Root `npm ci`
  in a concurrent bootstrap rebuilds them under a running worktree. Accepted
  trade-off (documented at `SYMLINK_TARGETS`); per-worktree install if it bites.
