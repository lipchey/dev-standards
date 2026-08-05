---
name: deep-review-refactor-codex
description: Use only when the user explicitly invokes `/deep-review-refactor-codex`.
runtime: codex
canonical_source: ../../../agents/skill-sources/deep-review-refactor-codex.md
---

# deep-review-refactor-codex (static wrapper)

STATIC — edit alongside the canonical body; `tests/runner/skill-wrappers-static.test.ts` guards drift. Do NOT regenerate; the generator was retired in Phase 2 (2026-07-10).

Thin per-runtime wrapper: metadata plus a pointer. The phase behavior — judgment steps and the contract block — lives once in the canonical body and is NOT duplicated here (ADR-003 / ADR-010).

## Canonical body

Read and follow the canonical `deep-review-refactor-codex` skill body:

```text
../../../agents/skill-sources/deep-review-refactor-codex.md
```
