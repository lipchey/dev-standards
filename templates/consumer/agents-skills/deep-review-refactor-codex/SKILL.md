---
name: deep-review-refactor-codex
description: Run a repo-local, consent-gated deep code and architecture review through Codex workers, then fix confirmed behavior-preserving findings by default. Use when the user explicitly invokes $deep-review-refactor-codex, asks Codex for a deep review/refactor against this repository's review guides, or accepts the one-time post-feature review-and-fix offer. Use review-only mode only when the user explicitly requests no edits. Never edit protected executable or policy surfaces and never land changes to the base branch.
---

# deep-review-refactor-codex (consumer pointer)

The package-owned workflow lives in the installed `dev-standards` submodule.
Keep project-specific policy in `quality.json`, `.claude/review-guides/`, and
`.claude/project-facts.md`; do not fork the skill body in the consumer.

## Canonical body

Read and follow the canonical `deep-review-refactor-codex` skill body:

```text
../../../vendor/dev-standards/agents/skill-sources/deep-review-refactor-codex.md
```
