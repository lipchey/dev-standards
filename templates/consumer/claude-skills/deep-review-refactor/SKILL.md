---
name: deep-review-refactor
description: Repo-local deep code/architecture review (review-only) and behavior-preserving review-driven refactor (review-and-refactor); judges by repo-local review guides, never edits the executable surface, never lands to base itself. Runs only with explicit user consent, but OFFER it automatically when feature work completes - ask once whether to review that branch's changes (scope = diff vs base, not the whole repo).
runtime: claude
canonical_source: vendor/dev-standards/agents/skill-sources/deep-review-refactor.md
---

# deep-review-refactor (static wrapper, consumer copy)

STATIC consumer-side pointer — the canonical body lives in the
`vendor/dev-standards` submodule; edit it there (fix-upstream), never here.
Kept in sync by hand with the submodule wrapper (`vendor/dev-standards/
.claude/skills/deep-review-refactor/SKILL.md`); no generator (retired in
Phase 2, ADR-003 / ADR-010).

## Canonical body

Read and follow the canonical `deep-review-refactor` skill body:

```text
vendor/dev-standards/agents/skill-sources/deep-review-refactor.md
```
