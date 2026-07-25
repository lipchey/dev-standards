---
name: deep-review-refactor-codex
description: Run a repo-local, consent-gated deep code and architecture review through Codex workers, then fix confirmed behavior-preserving findings by default. Use when the user explicitly invokes $deep-review-refactor-codex, asks Codex for a deep review/refactor against this repository's review guides, or accepts the one-time post-feature review-and-fix offer. Use review-only mode only when the user explicitly requests no edits. Never edit protected executable or policy surfaces and never land changes to the base branch.
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
