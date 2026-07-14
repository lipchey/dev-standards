# Adopting dev-standards

> **Onboarding gate.** The `Onboarding gate` bullet in this repo's `CLAUDE.md`
> must be cleared **by the user** before onboarding any new consumer. This
> document describes the mechanics; it does not by itself lift that gate.

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
  commit. On any failure it rolls the target back to its clean starting state.
- Idempotent: re-running re-pins/re-seeds without clobbering repo-owned files.
  `scripts/ds-install.sh /path/to/consumer --check` verifies an install.

## What lands where

| Path | Purpose |
|---|---|
| `vendor/dev-standards` | Submodule gitlink (the pin). |
| `scripts/ds-bootstrap.sh`, `scripts/verify`, `scripts/deep-review`, `scripts/install-gitleaks.sh`, `tools/run-gitleaks` | Bootstrap + guarded shims + pinned scanner. |
| `.githooks/{pre-commit,pre-push}`, `.github/workflows/verify.yml` | Local + CI gate wiring. |
| `quality.json` | Your gate manifest (starts minimal — see below). |
| `.claude/{CHECKLIST,code-conventions,gate-misses,project-facts}.md` | Instance docs (copy-if-absent; fill them in). |
| `.claude/review-guides/` | Optional additive overlays (empty by default). |
| `.claude/skills/deep-review-refactor/SKILL.md` | Static pointer to the canonical skill body. |

Copy-if-absent everywhere: a filled consumer file is never overwritten. The
managed `CLAUDE.md` section and the `.gitignore` entries are appended only when
missing.

## After install — make the gates real

The starter `quality.json` ships with `stack: "meta-docs"` and only the seeded
`instance-docs-seeded` check (in the `fast` and `full` tiers); the
project-specific gates start empty, so `./scripts/verify` passes immediately.

1. Switch `stack` (and each workspace `stack`) from `meta-docs` to your real
   stack, then add your project's checks (typecheck, tests, lint, …) to the
   `staged` / `fast` / `full` tiers — **keep** the seeded `instance-docs-seeded`
   check in `fast` and `full`. `./scripts/verify --doctor` explains the
   manifest; the validator runs on every `verify`.
2. Fill the four `.claude/` instance docs (layer DAG, no-touch zones,
   conventions, checklist, gate-miss ledger).
3. Extend, don't override, via `.claude/review-guides/` — see tuning below.

## Per-project tuning — three legal surfaces

1. **`quality.json`** — tiers, checks, budgets, filesets, `deep_review`.
2. **`.claude/review-guides/`** — the seven canonical guides are read in place
   from the package; a same-named overlay may only **add/extend** a guide, and
   an extra `.md` adds a project-only guide. Overlays never override or delete a
   canonical rule.
3. **`.claude/project-facts.md`** — repo type / no-touch zones that make the
   generic guides conditional.

Skill bodies are **not** a tuning surface — never fork them; behavior a guide
can't express goes upstream (fix-upstream loop below).

## Deep review is opt-in

`deep-review-refactor` reviews a completed feature branch's diff (not the whole
repo). The agent OFFERS it when feature work finishes and runs it **only with
explicit user consent** — never automatically.

## Updating the pin

Bump one or all local consumers to a newer pin (one atomic transaction each;
rolls that consumer back on any failure; no pushes):

```sh
scripts/ds-update-pins.sh [--ref vX.Y.Z] [--dry-run] [roots...]
```

Each bump re-runs the consumer's `ds-bootstrap.sh` (rebuild + re-stamp) and
`./scripts/verify --fast` before committing only the gitlink with message
`chore(dev-standards): bump submodule pin <old7> -> <new7>`.

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
- The **seven generic guides** are read in place from the package; the consumer
  owns only additive overlays, and `.claude/review-guides/` may be empty.
