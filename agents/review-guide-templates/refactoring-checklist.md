# Refactoring Checklist (review guide template)

Seed template. Adapted as short, paraphrased excerpts from
`ramziddin/solid-skills` (MIT) and the `wshobson/commands` refactor-clean /
tech-debt sources recorded in `agents/skill-catalog.json`. STARTING template:
each adopting repo copies it into `.agents/review-guides/` and then owns its
final body. The prompts below are review-only JUDGMENT PROMPTS - they gate
whether a refactor is safe and worth it, never an instruction to edit. In
`deep-review-refactor`'s review-and-refactor mode they also define the
discipline each fix slice must follow.

## How to apply this guide (conditional by repo type)

- Strongest for code with real callers and real tests: a service, a shared
  module, a runner primitive - where a behavior change slipped in under the name
  "refactor" is a production risk.
- Lighter for script-style glue: prefer readability; do not manufacture seams or
  abstractions a single caller will ever use.
- The refactor that is not worth its risk is itself a finding - record it as
  "leave it" with the reason, not as a P3 to churn.

## Behavior preservation is the contract

A refactor changes structure, never observable behavior. That is the whole
definition; everything below serves it.

Judgment prompts:

- Would the existing tests still pass, unmodified, after this change? If a test
  had to change to make the refactor green, the behavior changed - that is a
  feature/fix, not a refactor, and must be reviewed as one.
- Are inputs -> outputs and effects at every boundary identical before and after
  (including error paths, return types, thrown errors, log/side-effect shape)?
- Did any "while I was in here" behavior change ride along? Split it out; a mixed
  behavior-change-plus-refactor diff is un-reviewable and is a finding.

## Test-cover before you refactor

Judgment prompts:

- Is the code being refactored covered by a test that would FAIL if behavior
  regressed? If not, the correct first slice is to ADD that characterization test
  against current behavior, then refactor under its protection.
- For a legacy or untested seam, is there a pinning test capturing today's actual
  (even if quirky) behavior before the structure moves?
- Refactoring untested code with no net added coverage is a P2 risk finding.

## Small, atomic steps

Judgment prompts:

- Is the change decomposed into the smallest independently-verifiable slices, each
  one green on its own tests before the next? A large all-at-once structural diff
  is a finding even when correct - it defeats bisecting and review.
- Can each slice be reverted alone without breaking the others? Slices that must
  land together are really one slice; slices that need not are over-batched.
- Does each slice carry its own justification (which prompt triggered it)? A
  refactor slice with no finding behind it is churn.

## Seams and dependency injection

Judgment prompts:

- To test or replace a dependency (clock, filesystem, network, git, a subprocess),
  is there a seam - a parameter, an injected function, an interface at the edge -
  or is the dependency hard-wired so the unit can only be tested end-to-end?
- Would introducing a seam here cut real coupling, or just add indirection? Only
  the first is a finding; a needless seam is over-engineering (weigh it down per
  `architecture-deepening.md`'s deletion test).
- Does a proposed seam preserve behavior for the existing caller (default wiring
  identical to today)? A seam that changes the default is a behavior change.

## Dead code and duplication

Judgment prompts:

- Is there unreachable code, an unused export, a parameter no caller passes, a
  feature-flag branch that can never be taken? Prefer deletion; note if a
  deterministic tool (Knip, tsc, dependency-cruiser) already owns the finding so
  the review does not duplicate a gate.
- Is duplicated logic drifting - two copies that must change together and will
  eventually not? Name the single home it should collapse to, and the smallest
  slice to get there.
- Is a "just in case" abstraction, config knob, or generality carrying no live
  caller? Speculative flexibility is debt; record it as a P3 deletion candidate.

## Output expectations

Emit findings in the shape defined by `review-output-format.md`. For each
refactor finding record: location, which prompt triggered it, whether behavior
is provably preserved (and by which test), the risk, and the smallest atomic
slice. A refactor that needs a redesign or touches many call sites is emitted as
a PLAN, never an inline edit in a review pass.
