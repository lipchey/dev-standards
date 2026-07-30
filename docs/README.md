# Documentation map

This is the repository-wide map. Every file under `docs/` is listed here directly or
belongs to a collection with its own README.

Follow [`docs/CONVENTIONS.md`](CONVENTIONS.md) when creating, moving, completing, or
superseding documentation.

## Live sources

| Document | Owns |
| --- | --- |
| [`docs/ADOPTION.md`](ADOPTION.md) | Consumer installation, updates, tuning surfaces, and integration checklist |
| [`docs/ADR.md`](ADR.md) | Accepted and retired architecture decisions referenced by code, skills, and plans |
| [`docs/CALIBRATION.md`](CALIBRATION.md) | Effectiveness-metric definitions, calibration procedure, and session log |
| [`docs/plans/`](plans/README.md) | Open repository work and the index of completed plans |
| [`docs/research/`](research/README.md) | Point-in-time reviews and evidence reports |

## Component documentation outside `docs/`

| Document | Owns |
| --- | --- |
| [`README.md`](../README.md) | Product boundary, capability map, build, verification, and telemetry entry points |
| [`eslint/README.md`](../eslint/README.md) | ESLint exports, presets, custom rules, and composition examples |
| [`inbox/review-promotions.md`](../inbox/review-promotions.md) | Pending and resolved review-rule promotion candidates |
| [`agents/review-guide-templates/TRACEABILITY.md`](../agents/review-guide-templates/TRACEABILITY.md) | Review-profile ownership and blinded canary registry |

`CLAUDE.md` and `AGENTS.md` are repository instructions, not duplicate documentation
maps. Templates and skill bodies document the artifact they ship and are indexed by
their owning directory rather than repeated here file by file.
