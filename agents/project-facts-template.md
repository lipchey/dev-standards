# Project Facts (template)

Per-repo knowledge the `deep-review-refactor` skill reads before every pass —
layer DAG, domain terms, no-touch zones, repo shape. STARTING template: an
adopting repo copies this into the canonical path `.claude/project-facts.md`
and fills in the four sections below; delete this intro paragraph once
populated.

## Layer map

Fill in: the source-tree layer DAG (what depends on what), one line or a short
list, so a reviewer judges dependency-direction violations without re-deriving
it from the code.

## Domain terms

Fill in: the handful of domain nouns/verbs (and their meaning) that recur
across the codebase, so a reviewer reads intent instead of guessing jargon.

## No-Touch Zones

Fill in: one bullet per repo-specific path the skill must never auto-edit, as
a backticked glob, e.g. `- \`.claude/**\` — agent-owned knowledge, never
auto-edited`. This list only EXTENDS the skill's built-in baseline
(`.githooks/**`, `.github/workflows/**`, `verify`, `tools/**`, `auth/**`,
`credentials/**`) — it can never shrink it.

## Repo type

Fill in: one line — repo shape and team size (e.g. "node-service, solo") — so
the skill calibrates which review guides apply at full strength.
