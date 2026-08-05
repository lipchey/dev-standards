---
name: deep-review-refactor-codex
description: Use only when the user explicitly invokes `/deep-review-refactor-codex`.
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
