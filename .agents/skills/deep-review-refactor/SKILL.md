---
name: deep-review-refactor
description: Repo-local deep code/architecture review (review-only) and behavior-preserving review-driven refactor (review-and-refactor); judges by repo-local review guides, never edits the executable surface, never lands to base itself. Runs only with explicit user consent, but OFFER it automatically when feature work completes - ask once whether to review that branch's changes (scope = diff vs base, not the whole repo).
runtime: codex
canonical_source: agents/skill-sources/deep-review-refactor.md
---

# deep-review-refactor (static wrapper)

STATIC — edit alongside the canonical body; `tests/runner/skill-wrappers-static.test.ts` guards drift. Do NOT regenerate; the generator was retired in Phase 2 (2026-07-10).

Thin per-runtime wrapper: metadata plus a pointer. The phase behavior — judgment steps and the contract block — lives once in the canonical body and is NOT duplicated here (ADR-003 / ADR-010).

## Canonical body

Read and follow the canonical `deep-review-refactor` skill body:

```text
agents/skill-sources/deep-review-refactor.md
```
