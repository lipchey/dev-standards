# Tests Quality Review Profile

You review ONLY through this lens: whether tests detect real behavioral
regressions, use independent oracles, cover failure and boundary cases, remain
useful through refactors, and stay discoverable from the source they exercise
(the placement/traceability lens below). Do not turn production correctness,
architecture, typing, naming, or security concerns into findings from this
profile except where they make a test vacuous or coupled to implementation.

Template-Version: 3 (review-recall 2026-07-15)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

This profile carries the tests share of the repo-owned
`core-code-guidelines.md` baseline; the boundary-test material paraphrased from
the MIT sources attributed in `clean-architecture.md` (`ramziddin/solid-skills`
@ `b113ce6`, `wondelai/skills` clean-architecture @ `326b380`, and
`affaan-m/everything-claude-code` hexagonal-architecture @ `4092795`); and the
test/refactor material distilled as short paraphrased excerpts from
`ramziddin/solid-skills` (MIT, pinned `b113ce68`) `code-smells.md` and
`complexity.md`. The old tech-debt classification and execution-order sections
are own material over industry-standard Fowler vocabulary.

Stack-routing structure is inherited from `language-review-sources.md`. Its
lenses were distilled as paraphrased excerpts from
`awesome-skills/code-review-skill` (MIT, pinned `f2fd4e57`) - the per-language
guides, `code-quality-universal.md`, `common-bugs-checklist.md`, and
cross-cutting async/error notes. The Node lens was written from that universal
material plus repo experience; upstream has no dedicated lens for it.

## Conditionality

- Apply at full strength on production code paths and on code with real callers
  and real tests: a service, shared module, or runner primitive.
- Relax test depth for one-off scripts and throwaway glue; correctness and
  safety still apply. Do not manufacture seams, value objects, or abstractions
  a single caller will ever use.
- Boundary-test rules are strong where ports exist and light for pipelines.
- A refactor that is not worth its risk is itself a structural judgment, owned
  by → see `profile-refactoring-and-smells.md` §Tech-debt classification.

## Behavioral value and oracle strength

Judgment prompts:

- Does new or changed behavior have a test that would FAIL if the behavior
  regressed? Coverage of lines is not coverage of behavior. If you cannot name
  a plausible bug a test would catch, it earns nothing - do not write it.
- Do tests assert observable behavior (inputs -> outputs, effects at the
  boundary) rather than internal implementation details that break on a
  harmless refactor? Mocks that mirror the internal call sequence are the
  specific anti-pattern - they pin the implementation and make refactoring
  expensive.
- Is the test's oracle independent of the implementation? Independence is about
  derivation, not authorship: an expected value captured from the output of the
  implementation under test (snapshot, logged result) is a tautology - it pins
  whatever the code happens to do, not the spec - no matter who recorded it. An
  oracle derived from the specification, hand computation, or an independent
  source is legitimate even within the same run. Tautology signal: high line
  coverage paired with a low mutation score.
- For parser/serializer/round-trip/money paths: would a property-based test
  (fast-check in JS/TS, for example) state the invariant better than hand-picked
  examples? A complement to a spec/golden oracle, not a replacement - a parser
  and serializer can share the same misreading of the spec and still round-trip
  green. Optional lens: suggest it where it pays off, never mandate the
  dependency or gate on it.
- Is at least the primary failure/edge case tested, not only the happy path?
- For a bug fix: is there a regression test that reproduces the original bug
  and now passes - red before the fix, green after? A fix without a guarding
  test is a P2 finding.
- Is the suite testing the right things? Types are the compiler's job, style the
  linter's, third-party libraries their maintainers'; a test that re-checks any
  of these, or a trivial getter/passthrough/constant, or a config literal
  already enforced by a schema or validator, is noise to delete.
- Are there fewer, deeper tests rather than many shallow ones? A snapshot large
  enough that no reader would notice a wrong line needs an explicit reason to
  exist.
- Before a refactor, is current behavior pinned by characterization tests?
  Conversely, a test that fails when behavior did NOT change is itself a
  finding - it asserts an implementation detail and is a candidate to rewrite
  or delete. Deleting a test is only justified once evidence shows the coverage
  is truly redundant: for every invariant the test guarded, a concrete mutation
  must still be caught by the surviving gate (a type check, a lint rule, another
  test). "Never failed" alone is not that evidence - a test can guard a
  regression that simply has not happened yet. Once that mutation evidence
  exists, deletion is legitimate cleanup, not lost coverage.
- Does every async assertion sit on an awaited path - an `await`, a returned
  promise, or `await expect(...).resolves`? A test whose assertions run after an
  unawaited promise, or inside a `.then`/async callback the runner never awaits,
  passes regardless of behavior: the assertion may run after the test is already
  reported green, or never run at all. The code-side floating-promise and
  missing-`await` rules do not cover the test body itself. Would this test still
  pass if the assertion never ran?
- Does a test that pins an ORDER (guard-before-config, validate-before-mutate)
  use a fixture where the step the guard must PRECEDE would produce a DIFFERENT
  observable outcome - a missing or throwing config yielding a distinct exit
  code - so that reordering the guard past it turns the test RED? A happy-path
  fixture pins the guard's EXISTENCE, not its ordering, and survives the reorder
  silently. If the two steps were swapped, would this test fail?

Inclusive/exclusive boundary behavior is defined by
→ see `profile-correctness-and-lifecycle.md` §Cross-cutting correctness checks.
This profile owns whether tests exercise those boundaries.

Fixture/helper duplication → see `profile-refactoring-and-smells.md`
§Duplication, dead code, and speculative flexibility.

## Test-to-source traceability and placement

Weighting: full where the repo keeps a settled test layout; lighter for one-off
scripts; none where no convention exists.

A reader must be able to go from any source file to the test that exercises it,
and back, without searching. The repo picks the convention - a parallel test
tree that mirrors the source tree (`tests/<path>/foo.test.ts` for
`<path>/foo.ts`) or a test co-located beside its subject (`foo.test.ts` next to
`foo.ts`). This lens does not pick the convention; it judges whether the code
under review follows the one the repo already has.

Conditionality: apply only where a test-layout convention is visible in the
existing layout or declared in `.claude/code-conventions.md` §Tests ("how source
areas map to their tests"). A repo with no settled layout, or a documented
exception, is out of scope - do not invent a mirror tree a repo does not keep.
Files with no behavior to exercise (type-only modules, barrels, generated code)
need no companion test and no mirrored location; the companion-tests gate
already exempts `.d.ts`.

Judgment prompts:

- Does each new or moved test sit at the location its subject's path dictates
  under the repo's convention, replicating every intermediate subfolder? A test
  dropped in a flat `tests/` root, or under the wrong subfolder, when the
  convention nests by source path is a finding - its subject is no longer
  locatable from the path. The fix is to move the file to the mirrored path, not
  to add a comment pointing at its subject.
- Can the test's subject be identified from its location and name alone? An
  orphan-looking test with no discoverable subject, or a name that maps to
  several source files ambiguously, is a finding.
- Is one subject's coverage kept together rather than scattered across unrelated
  locations without a stated reason? Fragmenting a file's tests across the tree
  defeats the mapping as surely as misplacing one.

Whether a changed source file ships with any test at all is owned by the
`check-companion-tests` gate, not this lens - do not re-report a missing test as
a placement finding. This lens owns only whether the test that DOES exist sits
in the right, mirrored, discoverable place. Where a repo wires the report-only
`check-test-placement` gate, that gate mechanically catches a test under a mapped
root whose mirrored source path (every subfolder included) is absent; this lens
still owns what a path-map cannot resolve - an ambiguous or descriptively-named
subject, coverage fragmented across the tree, and whether the chosen convention
is right at all. The wording of a test's title or description is out of this
section's scope; it owns only file location and the path-to-subject mapping.

## Behavior-first tests at boundaries

Weighting: strong where ports exist; light for pipelines; none for glue.

- **Use cases are tested through the port with fakes.** **Check:** are use-case
  tests written against in-memory fake ports asserting business outcomes at the
  boundary? Here check specifically that the fake stands at the PORT, not
  deeper.
- **A port contract gets one shared contract test run against every adapter.**
  Each adapter must satisfy the same port behavior. **Check:** is there a
  per-adapter contract suite, or does each adapter get ad-hoc, divergent tests?
  Absence on a multi-adapter port is a finding.
- **Critical behavior is tested at the port, not only through a brittle E2E.**
  **Check:** is a core rule covered only by an end-to-end path that breaks on any
  wiring change? Finding - pull the assertion down to the port boundary.

The definition, ownership, and construction of ports remain in
→ see `profile-architecture-and-boundaries.md` §Ports and adapters.

## Test-cover before a refactor

- **Cover the target with a behavior test before moving it.** Structure moved
  blind can regress silently. **Check:** is there a test that would FAIL if
  behavior regressed? If not, the first slice is to ADD a characterization test
  against today's behavior, then refactor under it.
- **Pin quirky legacy behavior exactly as it is.** Characterization tests
  capture what the code does, not what it should do. **Check:** for an untested
  seam, is current (even wrong-looking) behavior pinned before the structure
  moves? Fix the quirk in a separate, reviewed change.
- **Treat coverage-free structural moves as risk.** **Check:** does the refactor
  add net-new coverage or ride on existing tests? Refactoring untested code with
  no net added coverage is a P2 risk finding.
- **In fix mode, prove the pinning test has teeth.** A characterization test
  stays green through the whole refactor - so its sensitivity must be shown,
  not assumed. **Check:** is the test green before AND after the slice, and was
  its sensitivity demonstrated once (mutate or temporarily break the moved
  logic -> the test goes red -> revert)? A slice whose test never exercised the
  moved code proves nothing.

Observable behavior preservation, ride-along changes, atomic slices, and the
refactor sequence are owned by
→ see `profile-correctness-and-lifecycle.md` §Behavior preservation during
refactors and `profile-refactoring-and-smells.md` §Small atomic refactor
steps.

## Stack routing

Identify the surface by what the code actually is, one file or slice at a time;
a `.ts` file may be a service or a throwaway script. If a file mixes stacks,
route each part separately. Record the selected row with each finding.
Adopting repos may add rows for their own stacks; every row points to exactly
one matching section or weighting.

| Surface | Test-quality weighting |
| --- | --- |
| TypeScript service / shared module | full behavioral and boundary depth |
| Script-style TS / one-off pipeline | lighter depth; still require a regression-catching test for changed behavior where the repo tests the surface |
| React / UI TS | judge observable UI/effect behavior without pinning hook call sequences |
| Node / backend TS | judge startup, shutdown, stream, and async behavior through observable boundaries |

The old language router contains no additional stack-specific test-quality
prompts. Its runtime async and hook checks are owned by the correctness, types,
or security profiles; do not restate them here as invented test mandates.

## Output

Follow `review-contract.md` exactly. For each finding, name the mutation or
plausible regression the test fails to catch and the smallest test change that
would catch it. A placement/traceability finding is the exception to that shape:
a misplaced-but-working test catches no less than before, so cite the expected
mirrored path and the actual path, and give the remedy as the file move (not a
test change). Report every applicable instance and include the required per-file
`COVERAGE`/`CLEAN` claims. When tests are clean, say so explicitly.
