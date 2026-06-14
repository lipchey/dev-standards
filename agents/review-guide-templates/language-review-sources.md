# Language Review Sources (review guide template)

Seed template. Adapted as short, paraphrased excerpts from
`awesome-skills/code-review-skill` recorded in `agents/skill-catalog.json`.
STARTING template: each adopting repo copies it into `.agents/review-guides/`
and then owns its final body. The prompts below are review-only JUDGMENT
PROMPTS, never edit instructions.

## Purpose: a router, not a checklist

This guide is a DISPATCH TABLE, not an exhaustive per-language review list. It
maps the repo's stack to the one language-specific review lens to load. Load
ONLY the section that matches the surface under review and ignore the rest.
Loading every lens at once produces noise and cross-language false positives.

Conditionality is the whole point: the right lens depends on what the file
actually is. A TypeScript service, a React/Next UI, and Bash/n8n glue each get a
different lens - never the same blanket checklist.

## Dispatch table

| Repo / surface                      | Load this lens                                                   | Skip or downgrade when                                         |
| ----------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| TypeScript service or shared module | `clean-architecture.md` + `architecture-deepening.md` (strong)   | the file is really a one-off script (use the script-style row) |
| Script-style TS pipeline            | `architecture-deepening.md` (light) + `refactoring-checklist.md` | a rule would force needless structure onto simple functions    |
| React / Next                        | component-boundary + data-fetching lens                          | reviewing server-only or CLI code                              |
| Bash/n8n glue                       | glue lens: shell safety + idempotence                            | tempted to judge module depth or SOLID                         |

Adopting repos add rows for their own stacks; keep each row pointing at exactly
one lens to load.

## Per-lens dispatch notes

- TypeScript service (class-heavy): load the architecture and clean-architecture
  lenses at full strength; ports/adapters and dependency-direction prompts apply.
- Script-style TS pipeline: load architecture prompts lightly; favor readability
  and the refactoring checklist over abstraction. Do not import class-design
  rules here.
- React / Next: focus the lens on component boundaries, data fetching, and state
  co-location - not on backend layering rules.
- Bash/n8n glue: focus the lens on shell safety, error handling, and idempotence.
  Do NOT apply module-depth, SOLID, or DDD prompts to glue; those are not
  findings here.

## How to use this router

1. Identify the surface under review (one file or one slice at a time).
2. Pick the single matching row and load only that lens.
3. If a file mixes stacks (e.g. a TS wrapper around a shell call), review each
   part with its own lens; do not blanket-apply one.
4. Record, with each finding, which lens you loaded - so a reviewer can see the
   conditional choice was deliberate.
