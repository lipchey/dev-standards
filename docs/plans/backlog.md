# dev-standards backlog

Status: **active**. Open, non-blocking work only; newest evidence first.

Completed work is removed instead of retained as checked-off history. Git history and
`docs/plans/archive/` preserve provenance. Cross-repository work remains owned by the
consumer plan that discovered it until it is explicitly accepted here; do not copy a
consumer checklist into this file.

## Correctness and integrity

### Validate review-guide cross-references

The `→ see profile-<x>.md §<Section>` grammar is not checked. Add a focused test that
resolves every target file and heading in `agents/review-guide-templates/`. This is a
`check-missing` escape found on 2026-07-17.

### Inspect dirty dev-standards submodules instead of exempting them

`deep-review/src/worktree.ts` treats the whole `vendor/dev-standards` gitlink as
tooling dirt. A consumer can therefore hide tracked or unexpected untracked source
changes inside the submodule. Inspect the nested repository and ignore only exact
generated artifacts. Cover every caller of `nonToolingDirtyPaths` plus the slice
guard with clean, generated-only, tracked-source, and unexpected-untracked fixtures.

### Publish build artifacts atomically

The content-hash snapshot detects a changing tree but cannot detect a stable partial
build. Make the writer authoritative: invalidate the build stamp before `build:*`,
publish a content digest only after a complete build, or use one lock shared by
bootstrap and direct builds. The same mechanism should close the same-pin rebuild
window seen by deep-review worktrees.

### Enforce findings slice invariants in the schema

The findings schema still accepts non-positive lines, empty or duplicate
`slice_files`, and a finding file outside its `slice_files`. Add schema and mutation
tests before changing fix-mode behavior.

### Make shared path confinement fail closed and race-safe

`realpathOfDeepestExisting` treats non-`ENOENT` failures such as `EACCES` as absence,
while resolve-then-use remains raceable through mutable ancestors. Replace it with a
fail-closed, race-safe primitive shared by installer rollback and group-artifact
handling, covered by permission-failure and ancestor-swap fixtures.

### Make pin-bump seeding transactional

`ds-update-pins.sh` commits only the gitlink. If bootstrap seeds a missing instance
document, the new file is left untracked and rollback does not remove it. Track files
created during the transaction, include them in the pin commit, and remove them on
rollback. Add a pre-marker-to-new-pin end-to-end case.

## Adoption and template drift

### Define migrations for consumer-owned templates

Pin updates rebuild package-owned bundles but intentionally do not overwrite seeded
consumer shims, hooks, CI, or bootstrap scripts. Version the seeded contract, detect
missing or stale package-owned files, and offer an explicit migration path that never
clobbers consumer-owned customizations.

### Cover marker seeding in the installer journal

Extend `tests/e2e-adoption-kit.sh` to assert the `created:` record for the two-stage
marker, no duplicate record on rerun, and rollback after a fault injected after
instance-document seeding.

### Exercise the seeded ESLint config as a consumer

Factory tests prove the five custom-rule presets, while template tests mostly prove
wiring. Add one consumer-style lint fixture that loads the seeded config and asserts
each gate reports at severity 2.

## Maintainability and quality floor

### Share the custom-rule preset entry builder

The custom rule modules repeat the same plugin/rules/files/ignores entry shape.
Extract one internal builder without changing the named public factories;
`tests/eslint/presets-compose.test.mjs` remains the behavior contract.

### Dogfood the block-comment convention

Perform a bounded review of surviving non-directive `//` comments in `runner/src`
and `deep-review/src`. Convert only genuine violations and prune narration/dividers;
do not use a raw line-count sweep.

### Decide whether core needs coverage and formatting gates

The core repository self-checks with typecheck, lint, tests, build, and Knip, but has
no coverage or formatting gate. Add one only with a measured failure mode and an
explicit owner; do not copy the consumer pipeline by default.

## Parked until their enforcement surface changes

- Wire `event.before` into diff coverage for push-to-main CI only if CI becomes an
  enforcement surface. Local pre-push verification already measures the same commits.
- Build a PR-CI index bridge for `check-new-deps` only if that gate becomes blocking in
  CI. It intentionally evaluates staged index blobs, while a clean PR checkout has no
  staged delta.
- Enable branch protection through repository settings; this is an external operation,
  not a code or documentation change.
