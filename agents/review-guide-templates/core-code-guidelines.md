# Core Code Guidelines (review guide template)

Seed template. This is the always-on review baseline - the cheap rules every
coding task applies, the short list that `deep-review-refactor` loads first
(per ADR-003, review guides are loaded by explicit brief, not auto-discovered).
Unlike the other
seeds it is NOT adapted from an upstream source; it is the repo's own baseline,
kept deliberately short and noise-free so the on-demand deep guides own the long
tail. STARTING template: each adopting repo copies it into
`.claude/review-guides/` and then owns its final body. The prompts below are
review-only JUDGMENT PROMPTS for a human or reviewing agent - they say what to
look for and how to weigh it, never an instruction to edit.

## How to apply this guide (conditional by repo type)

These are the rules that pay off on almost any surface, but weight them by what
the code actually is:

- Full strength on production code paths: anything a user, another service, or a
  scheduled job depends on.
- Lighter on one-off scripts and throwaway glue: correctness and safety still
  apply; naming polish and test-depth prompts relax.
- The point is a short baseline. If a finding needs SOLID, module-depth, or
  security depth, that is the job of `clean-architecture.md`,
  `architecture-deepening.md`, or `security-review.md` - do not reproduce them
  here.

## Correctness

Judgment prompts:

- Does the change do what the plan/PR says, and only that? Scope creep beyond the
  stated intent is a finding even when each extra edit is individually harmless.
- Are the boundary and empty cases handled - empty input, zero/one/many, missing
  optional, first/last element, integer overflow, timezone/locale edges?
- Is every branch reachable and correct, or is there a dead branch, an inverted
  condition, or an off-by-one? Trace the non-happy path, not just the happy one.
- Does concurrent or async code have an ordering, race, or await-missing bug?
  Flag an unawaited promise, a shared mutable read-modify-write, or a check that
  can go stale before the act it guards.

## Boundaries and inputs

Judgment prompts:

- Is external input (argv, env, files, network, user data) validated at the trust
  boundary before use, or does raw input flow into logic that assumes it is
  well-formed? Deep validation is `security-review.md`'s job; the baseline flags
  the *absence* of any validation at the edge.
- Are public function contracts honored - types, nullability, documented
  pre/postconditions - or does a caller quietly rely on an undocumented shape?
- Does the change cross a module boundary in a way that leaks internals a caller
  should not need? (Depth judgment escalates to `architecture-deepening.md`.)

## Error handling

Judgment prompts:

- Is every fallible operation's failure handled, or is an error swallowed,
  logged-and-ignored, or caught too broadly (a bare `catch {}` that hides real
  faults)?
- On failure, does the code fail safe - no partial write left committed, no
  half-updated state, no resource leaked (file handle, lock, connection)? Prefer
  fail-closed on the paths that guard data or access.
- Are error messages actionable and free of secrets/PII? A message that leaks a
  token or a full internal path is a finding.
- Is `only ENOENT means absent` (and similar) respected - i.e. is a specific
  expected error distinguished from every other errno, rather than treating all
  errors as the benign case?

## Naming and readability

Judgment prompts:

- Does each name say what the thing is/does in the repo's ubiquitous language, or
  does it mislead (a `get` that mutates, a `list` that returns one, a boolean
  named for the false case)?
- Is intent obvious without a comment, or does non-trivial logic go unexplained
  where a one-line why-comment would save the next reader? (More comments is not
  better; the missing *why* on a surprising line is the finding.)
- Is there needless duplication that will drift out of sync, or needless
  indirection that adds a name but no behavior? Weigh both directions - do not
  manufacture an abstraction a single caller will ever use.

## Comments

Judgment prompts:

- Does each comment carry information the code cannot - a non-obvious why, a
  constraint, an external gotcha, a deliberate trade-off? Boilerplate is a
  finding to delete, not keep: file-header banners restating the module name,
  section dividers, play-by-play narration of the next line, notes addressed
  to the reviewer ("changed this to fix X"), and commented-out code.
- Does every file-header line name a constraint rather than summarize? A
  header line survives only if deleting it invites a concrete bug or wrong
  fix. Retellings of what the file does, usage examples reproducible from the
  code or configuration, and specification text restated without adding a
  local constraint or concrete failure consequence are findings even when
  accurate. Use the delete test as the tie-breaker: a specification-derived
  line that names one concrete constraint stays, as do markers carrying
  non-derivable state.
- Are all comments (doc comments included) written in English? A non-English
  comment is a finding regardless of the team's working language.
- Do comments use block form `/* */` (`/** */` for doc comments) in languages
  that support it? Line form is acceptable only where a tool or the language
  itself mandates it - directives (`// eslint-disable-next-line`,
  `/// <reference>`, `//go:build`), shebangs, and languages whose comment or
  doc syntax is line-based by spec (Python/shell/YAML `#`, Rust `///`, Go doc
  comments).

## Tests

Judgment prompts:

- Does new or changed behavior have a test that would FAIL if the behavior
  regressed? Coverage of lines is not coverage of behavior. If you cannot name a
  plausible bug a test would catch, it earns nothing - do not write it.
- Do tests assert observable behavior (inputs -> outputs, effects at the
  boundary) rather than internal implementation details that break on a harmless
  refactor? Mocks that mirror the internal call sequence are the specific
  anti-pattern - they pin the implementation and make refactoring expensive.
- Is at least the primary failure/edge case tested, not only the happy path?
- For a bug fix: is there a regression test that reproduces the original bug and
  now passes - red before the fix, green after? A fix without a guarding test is
  a P2 finding.
- Is the suite testing the right things? Types are the compiler's job, style the
  linter's, third-party libraries their maintainers'; a test that re-checks any
  of these, or a trivial getter/passthrough/constant, is noise to delete.
- Are there fewer, deeper tests rather than many shallow ones? A snapshot large
  enough that no reader would notice a wrong line needs an explicit reason to
  exist.
- Before a refactor, is current behavior pinned by characterization tests?
  Conversely, a test that fails when behavior did NOT change is itself a finding
  - it asserts an implementation detail and is a candidate to rewrite or delete.
  Deleting a test is only justified once evidence shows the coverage is truly
  redundant: for every invariant the test guarded, a concrete mutation must
  still be caught by the surviving gate (a type check, a lint rule, another
  test). "Never failed" alone is not that evidence - a test can guard a
  regression that simply has not happened yet.

## Output expectations

Emit findings in the shape defined by `review-output-format.md`: a priority
(P1 breaks adoption/safety/behavior; P2 concrete correctness or
maintainability; P3 clarity/improvement), `file:line`, a one-line claim, the
evidence, and the smallest behavior-preserving fix. When the baseline is clean,
say so explicitly rather than inventing P3 noise.
