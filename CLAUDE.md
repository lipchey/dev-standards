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
- **ADR discipline**: referencing a new ADR id in code requires a matching
  entry in `docs/ADR.md` (create the file on the first entry — known debt, see
  BACKLOG).
- **`workflow/` (L3) is slated for removal** (BACKLOG; execution plan in local
  gitignored `.handoff/workflow-removal-plan.md`). Do not build anything new
  on top of `workflow/`.
- **Onboarding gate**: no new consumer repos until (1) L2 is finished in
  ai-prompter, (2) `workflow/` is removed, (3) `DEEP_REVIEW_FINDINGS.md` is
  triaged into BACKLOG or committed. When all three are done, write
  `docs/ADOPTION.md` and delete this bullet.
- **Post-removal roadmap**: `docs/post-workflow-removal-plan.md` — execute
  after the `workflow/` removal lands; each phase gets its own low-level plan
  + Gate P before dispatch.
