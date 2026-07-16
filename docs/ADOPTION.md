# Adopting dev-standards

dev-standards is vendored into a consumer as a git submodule at
`vendor/dev-standards` (pinned by SHA). The consumer builds the runner bundles
locally and runs thin `scripts/verify` / `scripts/deep-review` shims over them.

## Prerequisites

- The target is a **git repository root** with a **clean working tree**.
- `node` and `npm` on `PATH` — required even for non-Node repos (the submodule
  build and the deep-review worktree need them).
- Network access to this repo's origin (the submodule clones from it).

## Install — one command

Run from a checkout of dev-standards, pointing at the target repo:

```sh
scripts/ds-install.sh /path/to/consumer [--ref vX.Y.Z] [--eslint]
```

- `--ref` selects the pin (tag or SHA); default = the latest `vX.Y.Z` tag on
  origin. A ref that predates the adoption kit (no `scripts/seed-consumer.sh`,
  i.e. before v0.9.0) is rejected.
- `--eslint` also seeds the shared ESLint presets (requires a root
  `package.json`).
- The installer **stages the gitlink but does not commit** — review, then
  commit. On failure it **leaves the half-applied state in place** for debugging
  (the transaction journal lands in the repo's git dir — `.git/ds-install.journal` for a normal checkout; `git rev-parse --absolute-git-dir` for a linked worktree); undo it on demand
  with `scripts/ds-install.sh /path/to/consumer --rollback`.
- Idempotent: re-running re-pins/re-seeds without clobbering repo-owned files.
  `scripts/ds-install.sh /path/to/consumer --check` verifies an install.

## What lands where

| Path | Purpose |
|---|---|
| `vendor/dev-standards` | Submodule gitlink (the pin). |
| `scripts/ds-bootstrap.sh`, `scripts/verify`, `scripts/deep-review`, `scripts/install-gitleaks.sh`, `tools/run-gitleaks` | Bootstrap + guarded shims + pinned scanner. |
| `.githooks/{pre-commit,pre-push}`, `.github/workflows/verify.yml` | Local + CI gate wiring. |
| `.github/dependabot.yml` | Weekly grouped npm version-update PRs (platform-side; deliberate replacement for an npm-audit tier check). Consumer-owned: non-npm consumers swap the ecosystem entry for their stack (e.g. `github-actions`). |
| `quality.json` | Your gate manifest (starts minimal — see below). |
| `.claude/{CHECKLIST,code-conventions,gate-misses,project-facts}.md` | Instance docs (copy-if-absent; fill them in). |
| `.claude/two-stage-dev.marker` | ADR-019 two-stage marker (copy-if-absent; needs no filling): write-time guide injectors (editor pre-tool hooks, delegate-launcher preambles) stay silent in repos carrying it — guides bind at Stage-2 review. Standard instance doc: `--check` requires it and bootstrap re-seeds it; two-stage is the package default (ADR-019). NOTE for pre-marker consumers: the first pin bump seeds it via bootstrap — commit it together with that pin (a gitlink-only pin commit leaves it untracked). |
| `.claude/review-guides/` | Optional additive overlays (empty by default). |
| `.claude/skills/deep-review-refactor/SKILL.md` | Static pointer to the canonical skill body. |
| `.claude/settings.json` | Guides-read gate wiring (ADR-016): the `Stop` + `SubagentStop` hooks. Structurally MERGED, not copy-if-absent — a consumer's existing settings survive. |
| `AGENTS.md` | Pointer to `CLAUDE.md` for agents that read only AGENTS.md (never a second source of truth). |

Copy-if-absent everywhere EXCEPT `.claude/settings.json`, which is merged
structurally (the guides-read hooks are added; existing keys/hooks are kept). The
managed `CLAUDE.md` section and the `.gitignore` entries are appended only when
missing.

## After install — make the gates real

The starter `quality.json` ships with `stack: "meta-docs"` and only the seeded
`instance-docs-seeded` check (in the `fast` and `full` tiers); the
project-specific gates start empty, so `./scripts/verify` passes immediately.

1. Switch `stack` (and each workspace `stack`) from `meta-docs` to your real
   stack, then add your project's checks (typecheck, tests, lint, …) to the
   `staged` / `fast` / `full` tiers — **keep** the seeded `instance-docs-seeded`
   check in `fast` and `full`. Dead code has an owning gate — add `knip` (devDep +
   `knip.json`) as a `full`-tier check with `mode: report-only` until the
   `CALIBRATION.md` flip rule is met; the review guides already defer dead-code
   findings to it. `./scripts/verify --doctor` explains the
   manifest; the validator runs on every `verify`.
2. Fill the four `.claude/` instance docs (layer DAG, no-touch zones,
   conventions, checklist, gate-miss ledger). The seeded `two-stage-dev.marker`
   needs no filling.
3. Extend, don't override, via `.claude/review-guides/` — see tuning below.
4. Wire the two-stage process (ADR-019) into the consumer's `CLAUDE.md`: a
   compact Stage-1 core (placement map, no-touch zones, secrets, security
   boundaries, lazy-read triggers) instead of mandated pre-code reads; the
   Stage-2 offer after a feature is a READY PROMPT for a fresh session
   (`deep-review-refactor` + scope = diff vs base + branch/worktree) — never a
   review run inside the build session, whose context is already spent; a
   declined/postponed Stage 2 leaves a `stage-2 pending: <feature>` debt entry
   in the repo's status doc.

## GitHub platform settings

Configured in the GitHub repo UI, not in `quality.json` or the verify gates —
platform-managed protections and signals that complement the repo-owned gates
(of the three, only Push Protection actually blocks anything).

- **Secret Scanning Push Protection** (repo Settings → Code security) — a
  server-side layer complementary to the repo-owned gitleaks gate in CI
  (`verify.yml`), not a replacement. Free for public repos; private repos need
  GitHub Secret Protection.
- **CodeQL default setup** for GitHub-hosted consumers — requires Actions, and
  public visibility or a GitHub Code Security license.
- **Dependabot alerts + security updates** — the seeded `dependabot.yml` covers
  version updates only; vulnerability alerts and security-fix PRs are separate
  settings-side features — enable both.

## Per-project tuning — three legal surfaces

1. **`quality.json`** — tiers, checks, budgets, filesets, `deep_review`.
2. **`.claude/review-guides/`** — the nine-file corpus (`review-contract.md` +
   eight `profile-*.md`) is read in place
   from the package; a same-named overlay may only **add/extend** a guide, and
   an extra `.md` adds a project-only guide. Overlays never override or delete a
   canonical rule. When a project rule genuinely diverges from a core guide,
   mark the project line `> deviates-from-core: <reason>`. This is
   **documentation of a human reconciliation decision** — so a later
   promotion session does not silently merge the deviation back into core — not
   a rule-override mechanism: the additive-only model still holds, and a true
   contradiction is reconciled by a human via `inbox/review-promotions.md`.
3. **`.claude/project-facts.md`** — repo type + no-touch zones that make the
   generic guides conditional. No-touch is an **extend-only union**: a project
   may *add* zones, never *narrow* the shipped BASELINE.

Skill bodies are **not** a tuning surface — never fork them; behavior a guide
can't express goes upstream (fix-upstream loop below).

## Deep review is opt-in

`deep-review-refactor` reviews a completed feature branch's diff (not the whole
repo). The agent OFFERS it when feature work finishes and runs it **only with
explicit user consent** — never automatically.

### Guides-read enforcement (ADR-016)

Adoption wires a hard gate: a `Stop` + `SubagentStop` hook in
`.claude/settings.json` runs `scripts/deep-review guides-read --hook-stdin`, which
BLOCKS a deep-review pass from concluding until the session transcript proves every
mandated ANCHOR guide was actually opened with a `Read`. Since the 2026-07-16
rescope (ADR-016 Amendment) the main-session anchor set is: the corpus contract
`review-contract.md`, its `.claude/review-guides/` overlay if present, and every
`deep_review.required_reads` entry — the eight `profile-*` lens bodies are read by
the mandatory fan-out's profile routes, not gated on the main transcript (though
the AVAILABILITY of every listed overlay stays fail-closed, and the full nine-file
corpus still loads as a deployment check). The starter sets `required_reads` to the
three seeded instance docs. `seed-consumer.sh --check` fails if the hooks are not wired.

- The gate only fires for real deep-review sessions (the harness stamps the skill
  attribution); ordinary coding sessions are never blocked. Detection in v1 relies
  on a readable, sufficiently-flushed transcript (the session's own file, written
  asynchronously); an unreadable transcript, or one whose attribution line has not
  yet flushed at Stop time, is treated as non-review and skipped — a
  designed-but-unwired activation marker would make activation deterministic
  regardless of flush timing (ADR-016).
- **Ceiling (not absolute):** Claude Code force-continues after 8 consecutive
  `Stop`-blocks, so the gate makes a determined skip LOUD (up to 8 recorded blocks
  naming the unread guides) rather than strictly impossible; a single accidental
  skip is caught on the first block.
- **Escape hatch:** set `DEEP_REVIEW_GUARD_OFF=1` in the environment to disable the
  gate unconditionally — the pressure valve if a gate bug ever blocks a session.
- **Removing the gate entirely** (out-of-band, if needed): delete the `Stop` and
  `SubagentStop` entries whose command contains `guides-read --hook-stdin` from
  `.claude/settings.json`. Re-running the seeder re-adds them.

**Migrating consumers seeded before this gate:** a pin bump touches only the
gitlink, so it does not back-fill `.claude/settings.json` or `required_reads`. Run
`scripts/seed-consumer.sh <root>` once (or
`node vendor/dev-standards/scripts/merge-deep-review-hooks.mjs <root>`) to wire the
hooks, and add `deep_review.required_reads` to `quality.json` by hand.

## Updating the pin

Bump one or all local consumers to a newer pin (one atomic transaction each;
rolls that consumer back on any failure; no pushes):

```sh
scripts/ds-update-pins.sh [--ref vX.Y.Z] [--dry-run] [--keep-on-failure] [roots...]
```

Each bump re-runs the consumer's `ds-bootstrap.sh` (rebuild + re-stamp) and
`./scripts/verify --fast` before committing only the gitlink with message
`chore(dev-standards): bump submodule pin <old7> -> <new7>`. A failed bump rolls
that consumer back to its old pin by default; `--keep-on-failure` instead leaves
the failed state in place for debugging (the run still exits non-zero and prints
a manual restore recipe).

**Migrating consumers seeded before v0.10.0:** copy-if-absent seeds new files
only on a fresh install — a pin bump touches only the gitlink, so it never
back-fills `.github/dependabot.yml` or `AGENTS.md` (and `--check` fails until
the dependabot file exists). After bumping the pin, run the seeder once from the
consumer root to create whatever is missing:

```sh
vendor/dev-standards/scripts/seed-consumer.sh .
```

Then review and commit both new files — the seeder never commits, and the pin
bump commits only the gitlink.

## Fix-upstream loop

A bug or gap found in `vendor/dev-standards` from a consumer is fixed **in the
submodule** (a full checkout), pushed to its `main`, then the pin is bumped —
never worked around in consumer code. Shared rules/guides are proposed via
`inbox/review-promotions.md`, never edited from a consumer session.

## Content contract (Phase 6)

- Bundles are **built on demand**, not committed; `ds-bootstrap.sh` builds them
  and stamps `runner/dist/.built-from` + `deep-review/dist/.built-from` with the
  submodule SHA. The shims refuse to run a stale or mismatched bundle.
- **Order is fixed:** submodule update → build → seed. The seeder runs after the
  build so the fast-tier `seed-review-guides.sh . --check` gate has real docs.
- The **nine corpus files** (`review-contract.md` + eight `profile-*.md`) are read
  in place from the package; the consumer owns only additive overlays, and
  `.claude/review-guides/` may be empty.
