# dev-standards backlog

Non-blocking, dated. Newest first.

## 2026-07-15 — Supply-chain: detect a source SWAP on an EXISTING dep — DONE (v0.21.0, ADR-017)

Shipped: `isSourceSpec` vendored classifier (no npm-package-arg dep; 0 false-neg
vs npm-package-arg@14), manifest-side + three lock-only signals (source root spec,
non-https `resolved`, registry-identity drift vs base lock), precedence
effective-map, report-only. Design + Gate P/C: `docs/source-swap-detection-plan.md`;
decision: ADR-017. Original spec kept below for provenance.

`check-new-deps` enforces its positive spec grammar and lockfile pinning only on
NEW deps (D3 lets any EXISTING-dep spec change pass once a lockfile is staged).
The original inbox entry (2026-07-14) asked to extend the positive GRAMMAR to
spec-CHANGED deps — which also rejects a changed dep going to `>=1.0.0`/`latest`/
`*`, NOT only a source swap. That grammar tightening DIRECTLY conflicts with D3 (a
lockfile-proven registry range change intentionally passes; see the D3 test), so
the core, undecided question is grammar-strictness-vs-D3; the security-critical
slice within it is the source swap (`"a":"^1.2.3"` → git/URL/tarball/alias/local),
which D3 today lets through unflagged. Promoting this was attempted in the v0.20.x
inbox batch and BACKED OUT after Gate P + Gate C found even the source-swap slice
needs a real design, not a regex:

- **Robust spec classification, not a hand-rolled regex.** npm accepts source
  forms a `://`/prefix regex misses — scp-style git (`git@host:u/r.git`), bare
  GitHub shorthand (`user/repo`), relative/absolute-path and scheme-less specs.
  Use `npm-package-arg` (allow ONLY `version`/`range`/`tag` + the sanctioned
  `file:vendor/dev-standards`; treat every other type / parse-failure as a
  source) — but that adds a runtime dep to a tool that today imports only `node:`
  builtins and runs from `vendor/` in every consumer, so settle the
  dependency-availability story first.
- **Lockfile-only vector.** An attacker can change a lockfile entry's `resolved`
  to a tarball/git source with NO package.json change; the manifest-spec path
  never sees it (evaluate returns early when the manifest is unstaged). Needs
  staged-lock resolution inspection for existing deps too.
- **Section precedence.** A first-match-across-sections base lookup is wrong: npm
  gives `optionalDependencies` precedence over `dependencies`, so it can both hide
  and fabricate swaps. Reject duplicate cross-section names or build an effective
  map by npm precedence.
- **Blocking vs report-only.** `check-new-deps` is `mode: "report-only"` in
  `quality.json` + the seed, so ANY finding (new-dep or source-swap) is currently
  non-blocking — decide whether the supply-chain gate should block before adding a
  finding that assumes it does.

Its own focused change + Gate P/C, not a batch drive-by. Effort M–L, security.

## 2026-07-15 — Core comment-form sweep to block form (inbox #7, dogfooding)

`core-code-guidelines.md §Comments` requires block form `/* */` in TS and does
NOT exempt ordinary `//` (line form is legal only for directives/shebangs/
line-based langs). Core's own `runner/src` + `deep-review/src` carry many
non-directive `//` comments (added across the 70ade5a→add5420 range, inbox #7).
The rule already exists; this is a bounded dogfooding sweep of the ACTUAL
surviving violations (convert non-directive `//` → block, prune dividers/
narration per the guide), NOT a new rule and not urgent. Scope by reading, not
`git grep -c //` (which massively overcounts URLs/trailing/directive comments).
Effort M.

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

## Related core-backlog (from ai-prompter pilot) — ALL DONE (2026-07-15, Phase 6)

- **Commit an ADR decision log** — **DONE (2026-07-15).** `docs/ADR.md` is the
  canonical log; Phase 6.1 backfilled every code-referenced id (ADR-003/007/008/
  010/011/012) alongside the full-template ADR-013/014 entries.
- **Resolve ADR-011 "review-chain" naming collision** — **DONE (2026-07-15).**
  ADR-011 (retired with the workflow) is recorded as *"automatic review-chain
  gating"* in `docs/ADR.md`, deliberately not the bare "review-chain" name, ending
  the collision with the `codex-chain` Gate-C skill (Phase 6.2).
- **Core `verify` shim build-freshness guard** — **DONE (2026-07-15, Phase 6.5).**
  `tools/build-fingerprint.mjs` (Node `crypto`) content-fingerprints the runner build
  inputs (`runner/src/**/*.ts` + the `build:runner` recipe); it is wired directly into
  the `build:runner` npm script (`… && node tools/build-fingerprint.mjs --write`), which
  atomically stamps `runner/dist/.build-fingerprint`; the core `./verify` shim recomputes
  (print mode) and refuses a stale/missing stamp. Node, not a shell/shasum script, so it
  imposes no new dependency on consumer bootstrap (which builds this submodule).
  Content-fingerprint (not the consumer's SHA `.built-from` stamp) because active core dev
  moves HEAD every commit + leaves uncommitted source edits. Test:
  `tests/runner/build-freshness.test.ts`.

## 2026-07-15 — Phase 6.3 disposition residuals (non-blocking)

From the full disposition of `DEEP_REVIEW_FINDINGS.md` (58 findings; see its
"Диспозиція (Фаза 6)" section). Everything else is `fixed` or
`obsolete-after-removal`; these are the genuinely-open remainders:

- **DR-14** — findings schema does not enforce 4 slice invariants (`line ≤ 0`,
  empty/duplicate `slice_files`, a `file` not in `slice_files`). Belongs with the
  Phase 5 §5.4 schema-v2 work; low risk (review-only until fix-mode ships).
- **DR-16** — ✅ DONE (v0.20.2, 2026-07-15). `check-path` now runs
  `assertSafeRepoPath` argv-first (before config load, mirroring the
  select-worktree slug gate): an escaping/absolute/glob/magic-pathspec operand
  is EXIT_USAGE instead of a misleading `editable`. Regression + argv-first
  ordering tests in `tests/deep-review/cli.test.ts`.
- **DEP-02 (auto-update half)** — ✅ DONE (v0.20.2, 2026-07-15). Core
  `.github/dependabot.yml` now bumps the SHA-pinned GitHub Actions weekly
  (github-actions ecosystem, minor+patch grouped). Distinct from the npm
  consumer seed — this is the *core repo's own* CI.
- **Nits (optional):** a core-side coverage/format gate (INT-07 — core has
  eslint+knip but coverage/companion-tests are pilot-side only); narrow
  `RunnerReport.scope` from `string` to `TierName` (RUN-04 — the traversal exploit
  is already dead via `writeConfined`).
- **INT-01 branch protection** — a GitHub repo-settings/API toggle, not an in-repo
  artifact; enable server-side (ops), not a code change.

## Deep-review hardening backlog (2026-07-14 systemic-gaps Gate C, non-blocking)

- **Bake policy sources into the engine no-touch baseline.** ✅ DONE (ADR-016,
  2026-07-15). `NO_TOUCH_BASELINE` now protects the enforcement MECHANISM
  (`.claude/settings.json`, `.claude/hooks/**`, `scripts/deep-review`), and the
  FIX-mode set unions the POLICY via `policyProtectedPaths` (every
  `deep_review.required_reads` entry + the `guides_dir` overlay). `project-facts.md`
  stays protected via `selfProtectedPaths`. Covered by
  `no-touch.test.ts` (baseline + `policyProtectedPaths`).
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
