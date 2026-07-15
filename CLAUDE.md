# dev-standards — core rules

Quality tooling vendored into consumer repos as a git submodule at
`vendor/dev-standards` (pinned by SHA; consumers build `dist/` locally via
their bootstrap script and run a thin `verify` shim). Pilot consumer:
`ai-prompter`.

- Solo repo: `main` only, auto-commit after verified tasks.
- **Tag after every meaningful batch pushed to `main`**: annotated
  `git tag -a vX.Y.Z -m "<what's in the batch>"` + push the tag. No CHANGELOG —
  history lives in tag messages; consumer pins should land on tags where
  possible.
- **Promotions inbox** (`inbox/review-promotions.md`): entries are processed
  HERE, never from a consumer session — promote into a guide/template/schema/
  validator or reject; either way move the line from Pending to Promoted with
  the outcome.
- **ADR discipline**: referencing a new ADR id in code, a skill body, or a plan
  requires a matching entry in the canonical log `docs/ADR.md`. ADR entries are
  the *facts of decisions*, not a retelling of the code.
- **Seed parity**: a batch that changes a consumer-facing standard (a gate, a
  default, a preset, a config shape) updates the SEEDS in the SAME batch —
  `templates/consumer/**` and `eslint/consumer-template.eslint.config.js` — so
  a NEW consumer gets the standard from day one. The pilot consumer's own
  config is an adopter, never the source of truth; decisions live HERE
  (docs/ADR.md), the consumer journal records only its adoption + a pointer
  (miss caught by the owner, 2026-07-15: constants-home/naming landed in the
  pilot while the template still seeded the old behavior).
- **Skill bodies are canonical — no per-project fork**: a skill's body has one
  source for all projects (ADR-003/010). Per-project specificity goes through the
  three legal tuning surfaces (`quality.json`, additive `.claude/review-guides/`
  overlays, `.claude/project-facts.md` — see `docs/ADOPTION.md`), never a forked
  skill body; behavior none of them can express goes upstream via the fix-upstream
  loop.
- **`workflow/` (L3) has been removed** (BACKLOG, 2026-07-10): engine, tests,
  schema block, and validator checks are all gone. Do not reintroduce it or
  build anything on top of it.
- **Post-removal roadmap**: `docs/post-workflow-removal-plan.md` — execute
  after the `workflow/` removal lands; each phase gets its own low-level plan
  + Gate P before dispatch.
- **AI-quality adoption plan**: `docs/ai-quality-adoption-plan.md`
  (Gate P passed 2026-07-14) — research-born deltas layered on the roadmap:
  Block 0 roadmap-staleness fixes, N1 `check-new-deps` gate, N2/N3 = execute
  roadmap Phases 3-4, N4 platform/doctrine cheap wins. Same execution rule.
