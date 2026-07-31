<!-- dev-standards:managed-section — do not edit this marker; seed-consumer.sh keys idempotency on it -->
## dev-standards quality gate

This repo vendors [dev-standards](https://github.com/lipchey/dev-standards) as a
git submodule at `vendor/dev-standards` (pinned by SHA). Setup / refresh after a
clone or a pin bump: `scripts/ds-bootstrap.sh`.

- **Verify tiers.** `./scripts/verify --staged` (pre-commit), `--fast` (local
  loop), `--full` (pre-push / CI). The gates live in root `quality.json`.
- **Deep review is owner-invoked.** The runtime-specific skill —
  `/deep-review-refactor` in Claude, `/deep-review-refactor-codex` in Codex —
  runs only when the owner enters that literal slash command, and at no other
  time. Never offer or infer either skill. Default scope is the branch diff, not
  the whole repo. The Codex skill fixes confirmed safe findings by default;
  `review-only` must be explicit.
- **Overlays are additive-only.** The seven canonical review guides are read in
  place from the submodule; `.claude/review-guides/` may only ADD or EXTEND a
  guide, never override or delete a canonical rule.
- **Fix upstream, don't work around.** A bug or gap in `vendor/dev-standards` is
  fixed in the submodule and the pin bumped — see `docs/ADOPTION.md` in
  dev-standards for the fix-upstream loop.
