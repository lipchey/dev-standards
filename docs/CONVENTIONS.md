# Documentation conventions

The goal is a small set of current sources, with history available without making it
look executable.

## Placement

| Information | Canonical home |
| --- | --- |
| Repository overview and public capability map | `README.md` |
| Adoption and update workflow | `docs/ADOPTION.md` |
| Architecture decisions | `docs/ADR.md` |
| Effectiveness calibration | `docs/CALIBRATION.md` |
| Open implementation work | `docs/plans/backlog.md` or a named active plan in `docs/plans/` |
| Completed or superseded plans | `docs/plans/archive/` |
| Point-in-time reviews and evidence | `docs/research/` |
| Promotion candidates | `inbox/review-promotions.md` |
| Component-specific reference | Beside the component, for example `eslint/README.md` |

Do not create a new category for one document unless it has a credible second member.
Use `git mv` for moves.

## Lifecycle

Actionable plans and point-in-time reports carry a status line near the title:
`draft`, `active`, `done`, `superseded → <path>`, or
`historical (implemented/deferred: ...)`. A completed plan moves to
`docs/plans/archive/` only after each unfinished item has another live owner.

The live backlog contains open work only. Remove completed entries; Git history is the
completion log. Research is historical by nature and is not rewritten as current
architecture, except for a short disposition banner or broken-link repair.

## One owner per fact

- Code and schemas own implemented behavior.
- `docs/ADR.md` owns decision rationale and status.
- `docs/ADOPTION.md` owns the consumer workflow.
- `docs/CALIBRATION.md` owns metric definitions and the human decision loop.
- An active plan owns unfinished scope and acceptance criteria.

Other documents link to the owner instead of copying more than a short summary. When
documentation and code disagree, fix the live owner; do not add a second explanation
beside the stale one.

## Map and links

Every document under `docs/` has one entry in `docs/README.md` or the nearest
collection README. Use repository-relative paths in backticks or resolving Markdown
links. After moving documents:

1. update all tracked references in the same commit;
2. scan for the old path and require zero matches;
3. validate local Markdown links;
4. run `./verify --full`.

## Synchronization triggers

Update the owning documentation in the same batch when a change alters a public
export, manifest/schema contract, CLI flag, generated/seeded artifact, required
adoption step, telemetry field, or lifecycle state. Internal refactors that preserve
those contracts do not require documentation churn.
