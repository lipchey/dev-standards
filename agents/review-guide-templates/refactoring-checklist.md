# Refactoring Checklist (review guide template)

Seed template. Distilled as short, paraphrased excerpts from
`ramziddin/solid-skills` (MIT, per its README; pinned `b113ce68`) -
`code-smells.md` and `complexity.md`. The tech-debt classification and
execution-order sections are own material over industry-standard (Fowler)
vocabulary - no upstream text. STARTING template: each
adopting repo copies it into `.claude/review-guides/` and then owns its final
body. The rules below are review-only JUDGMENT PROMPTS - they gate whether a
refactor is safe and worth it, never an instruction to edit. In
`deep-review-refactor`'s review-and-refactor mode they ALSO define the
discipline each fix slice must follow: behavior-preserving, test-covered,
atomic, and justified by a finding.
Template-Version: 2 (guides-revamp 2026-07-11)

This guide owns the long tail of structural quality. It does not repeat
`core-code-guidelines.md` (the always-on baseline: correctness, boundaries,
error handling, naming, comments, tests) - it cross-references it by name where
a smell touches a baseline rule. Architectural depth (dependency direction,
module cohesion, the deletion test) belongs to `clean-architecture.md` and
`architecture-deepening.md`; this guide points there rather than reproducing
them.

## How to apply this guide (conditional by repo type)

- **Strongest for code with real callers and real tests** - a service, a shared
  module, a runner primitive. There a behavior change slipped in under the name
  "refactor" is a production risk, and a seam that cuts real coupling earns its
  keep.
- **Lighter for script-style glue** - prefer plain readability; do not
  manufacture seams, value objects, or abstractions a single caller will ever
  use. Most OO-abuser and coupler smells below simply do not apply to a linear
  script.
- **The refactor that is not worth its risk is itself a finding** - record it as
  "leave it" with the reason (stable, untouched, slated for deletion, or the
  principal exceeds the interest - see Tech-debt classification), not as a P3 to
  churn.

## Behavior preservation is the contract

A refactor changes structure, never observable behavior. That is the whole
definition; everything below serves it.

- **Keep behavior tests green, unmodified.** *A behavior/contract test that had
  to change to pass means behavior changed.* **Check:** would the current suite
  pass as-is after this change? If a BEHAVIOR test had to change, it is a
  feature/fix, not a refactor - review it as one. Exception: a test coupled to
  internal structure (a mock mirroring the old call sequence, an import of a
  moved private) may legitimately be replaced during a refactor - with evidence
  observable behavior is unchanged, and that test's coupling recorded as its own
  finding (see `core-code-guidelines.md` tests).
- **Preserve inputs->outputs and effects at every boundary.** *The error path is
  behavior too.* **Check:** are return values, thrown error types, log lines,
  and side-effect shape identical before and after - on the failure paths, not
  just the happy one?
- **Reject ride-along behavior changes.** *A mixed diff is un-reviewable.*
  **Check:** did a "while I was in here" fix or tweak sneak in? Split it into its
  own reviewed change; a behavior-change-plus-refactor diff is a finding.

## Test-cover before you refactor

- **Cover the target with a behavior test before moving it.** *Structure you
  move blind can regress silently.* **Check:** is there a test that would FAIL if
  behavior regressed? If not, the first slice is to ADD a characterization test
  against today's behavior, then refactor under it.
- **Pin quirky legacy behavior exactly as it is.** *Characterization tests
  capture what the code does, not what it should do.* **Check:** for an untested
  seam, is current (even wrong-looking) behavior pinned before the structure
  moves? Fix the quirk in a separate, reviewed change.
- **Treat coverage-free structural moves as risk.** **Check:** does the refactor
  add net-new coverage or ride on existing tests? Refactoring untested code with
  no net added coverage is a P2 risk finding.

## Small, atomic steps

- **Decompose into independently-verifiable slices.** *A large all-at-once
  structural diff defeats bisecting and review even when correct.* **Check:** is
  each slice green on its own tests before the next begins? A monolithic
  refactor diff is a finding.
- **Keep each slice revertible alone.** **Check:** can slice N be reverted
  without breaking slice N+1? Slices that must land together are really one
  slice; slices that need not are over-batched.
- **Back every slice with a finding.** *A refactor slice with no finding behind
  it is churn.* **Check:** which prompt in this guide (or which smell below)
  triggered this slice? If none, drop it.
- **In fix mode, prove the pinning test has teeth.** *A characterization test
  stays green through the whole refactor - so its sensitivity must be shown, not
  assumed.* **Check:** is the test green before AND after the slice, and was its
  sensitivity demonstrated once (mutate or temporarily break the moved logic →
  the test goes red → revert)? A slice whose test never exercised the moved code
  proves nothing.

## Accidental vs essential complexity

A smell is only worth removing if the complexity it names is accidental - added
by the solution, not demanded by the problem. Essential complexity (real
business rules, domain edge cases, an irreducible state machine) must be
expressed clearly, not deleted; accidental complexity (needless indirection,
framework ceremony, a wrong abstraction) is the refactor target.

- **Separate essential from accidental before flagging.** *Deleting essential
  complexity is a behavior change, not a cleanup.* **Check:** does this
  branch/layer/abstraction encode a domain rule, or only the solution's
  plumbing? Only the second is a finding.
- **Read change-amplification as a signal.** *"To add one field I must touch
  many files" points at scattered responsibility.* **Check:** does a small
  logical change fan out across the codebase (see Shotgun surgery / Divergent
  change below)? Name the missing home.
- **Read cognitive load as a signal.** *Code you must hold ten other units in
  your head to follow is over-coupled.* **Check:** to understand this unit, how
  many others must you also read? High load points at hidden dependencies or a
  missing seam - not at a naming nit.
- **Do not trade duplication for the wrong abstraction.** *A premature
  abstraction is costlier than the duplication it replaced.* **Check:** is the
  proposed shared abstraction actually the same concept in every caller, or three
  things that merely look alike today? When unsure, leave the duplication (rule
  of three, below).

## Code-smells taxonomy

A smell is an indicator, not a bug - design that makes code hard to understand,
change, or test. Confirm it is a real problem before flagging (each table's "Not
a smell when" column), name the smallest standard remedy, and default to the
typical priority unless a live defect raises it. Thresholds (line counts, arg
counts) are signals to look closer, never auto-findings. Findings here almost
never block adoption - most are P3, some P2; a smell is P1 only when it hides a
correctness or safety defect, which is then a `core-code-guidelines.md`
correctness finding wearing a smell's clothes.

### Bloaters - code that has grown too large

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
|-------|------------------|------------------|-----------------|------|
| Long function | one function mixes validate + compute + persist + notify across many screens | it is one flat data literal, or a single exhaustive `switch` with no shared logic | Extract Function per concern | P3 |
| Large class | one type owns unrelated responsibility clusters (`auth` + `prefs` + `billing`) | it is a cohesive value object or a thin DTO | Extract Class along the responsibility seams | P3 |
| Long parameter list | `f(a,b,c,d,e)` where several args always travel together | the args are genuinely independent and few | Introduce Parameter Object / pass the whole record | P3 |
| Data clumps | the same 3+ fields recur across signatures (`x,y,w,h`) | the group appears in exactly one place | Extract a small type for the clump | P3 |
| Primitive obsession | a domain concept (money, id, email) is a bare `string`/`number` with validation copy-pasted at call sites | a one-off local with no invariant to protect | Wrap in a value object that validates once | P2/P3 |

### Object-orientation abusers - misuse of OO mechanisms

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
|-------|------------------|------------------|-----------------|------|
| Switch on type | `switch(x.type)` / if-else on a type tag repeated in more than one place | a single localized dispatch, or a discriminated union the compiler checks exhaustively | Replace with polymorphism or a lookup table | P3 |
| Refused bequest | a subclass ignores or throws on inherited members it cannot honor | the base is a genuine `is-a` and the member is optional by design | Replace inheritance with delegation/composition | P2 |
| Temporary field | a field set only in some flows, left null/unused otherwise | the null is a modeled, documented state | Extract the transient state into its own object or a parameter | P3 |

### Change preventers - structure that makes change expensive

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
|-------|------------------|------------------|-----------------|------|
| Divergent change | one module is edited for many unrelated reasons over time | the reasons share a genuine axis | Extract Class along the change axes (SRP; see `clean-architecture.md`) | P2 |
| Shotgun surgery | one logical change forces edits scattered across many files | the fan-out is a deliberate, documented layering | Gather the scattered pieces into one home | P2 |
| Parallel inheritance | adding a subclass here forces a matching subclass there | the pairing is coincidental, not structural | Collapse or merge the hierarchies | P3 |

### Dispensables - code that can simply go

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
|-------|------------------|------------------|-----------------|------|
| Dead code | unreachable branch, unused export/param, feature-flag branch never taken | a deterministic gate already owns it - reference, do not duplicate | Delete (prefer Knip/tsc/dependency-cruiser) | P3 |
| Speculative generality | an abstraction, hook, or config knob with no live caller ("just in case") | a committed, imminent, documented need | Delete (YAGNI) | P3 |
| Lazy class | a class/module that no longer earns its keep (pure passthrough) | it is a deliberate boundary/adapter | Inline it | P3 |
| Comments-as-deodorant | a comment explaining WHAT confusing code does | the comment carries a non-obvious WHY, gotcha, or trade-off (that is a KEEP - see `core-code-guidelines.md` Comments) | Rename / Extract to make code self-explaining, then delete the comment | P3 |

### Couplers - excessive coupling between units

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
|-------|------------------|------------------|-----------------|------|
| Feature envy | a method uses another type's data more than its own | the access is incidental or a single field | Move Method to the data's home | P3 |
| Inappropriate intimacy | two modules reach into each other's internals | the shared internals are a deliberate, cohesive pair | Tell-don't-ask: expose a method on the owner, hide the field | P2 |
| Message chains | `a.getB().getC().getD()` - the caller navigates structure it should not know | a fluent builder designed to chain | Hide Delegate: expose the endpoint on the first hop | P3 |
| Middle man | a class/method that only forwards to another | a deliberate adapter or anti-corruption boundary | Inline it; call the target directly | P3 |

## Seams and dependency injection

- **Flag a hard-wired external dependency that blocks unit testing.** *A unit
  testable only end-to-end is slow and brittle.* **Check:** to replace a clock,
  filesystem, network, git, or subprocess, is there a seam (a parameter, an
  injected function, an edge interface), or is it hard-wired? Absence of a seam
  where testing needs one is a finding.
- **Reject a seam that only adds indirection.** *A needless seam is
  over-engineering, not decoupling.* **Check:** does the seam cut real coupling,
  or just add a name and a layer? Weigh it against the deletion test in
  `architecture-deepening.md`; if deleting it loses nothing, do not add it.
- **Keep the existing caller's behavior identical.** **Check:** does the seam
  default-wire exactly as today? A seam that changes the default is a behavior
  change, not a refactor.

## Dead code and duplication

- **Prefer deletion, but defer to the gate that owns it.** **Check:** is the
  unreachable code / unused export / never-taken flag branch already caught by
  Knip, `tsc`, or dependency-cruiser? If so, reference the gate; do not
  duplicate a deterministic finding in a judgment review.
- **Apply the rule of three to duplication.** *The wrong abstraction is worse
  than duplication.* **Check:** how many copies exist? First copy - leave it.
  Second - note it, leave it. Third - now it is a finding: name the single home
  it should collapse to and the smallest slice to get there.
- **Record speculative flexibility as a deletion candidate.** *A config knob or
  generality with no live caller is debt.* **Check:** does every abstraction,
  parameter, and knob have a real caller today? A "just in case" one is a P3
  deletion candidate.

## Tech-debt classification

Debt is not the same as a defect. A defect is wrong behavior now - flag it as a
`core-code-guidelines.md` correctness finding (P1/P2), evidence = the failure
case. Debt is correct behavior carried by costly structure - flag it here, and
record it so a reader can decide whether paying it is worth the principal.

**Quadrant (why the debt exists).** Classify to set the recommendation:

| | Prudent | Reckless |
|-|---------|----------|
| **Deliberate** | "Ship now, accept X, cost known" - record as a tracked debt finding with a payback trigger, not a defect | "No time for design" - finding: a shortcut with no payback plan; name the missing plan |
| **Inadvertent** | "Now we know how it should have been done" - refactor when next in the path (Boy-Scout) | didn't know the principle - this is the code-smell taxonomy above |

**Interest vs principal (whether to pay it down).** *Principal* = the cost to
fix now. *Interest* = the ongoing tax every future change pays (extra time,
extra bug surface). **Check:** prioritize by interest rate x change frequency,
NOT by principal. High-interest code that changes often -> pay it down (raise to
P2). Low-interest or rarely-touched code -> defer, even if the principal is
large.

**Debt worth NOT paying.** **Check:** is the code slated for deletion/replacement
(refactoring it is wasted principal), or stable-and-untouched (it pays no
interest)? Then the finding is "leave it" - state why. Boy-Scout improvements
apply only when you are already editing that code for another reason.

## Refactor execution order

When one finding needs several slices, sequence them so the tree is green at
every commit. A safe plan looks like:

1. **Pin first.** Add the characterization test - nothing moves until behavior
   is covered.
2. **Introduce additively.** Create the new home / seam with the old path still
   wired; tests stay green.
3. **Migrate callers one at a time**, verifying after each. Never move all
   callers in one slice.
4. **Delete the old path last**, once no caller remains.
5. **Order low-risk, high-value first** - rename, extract a constant, delete
   dead code - before structural moves. Never fold a behavior change into the
   sequence.

Each numbered step is one committable, revertible slice. A step that cannot be
green on its own is mis-cut - re-slice it. A refactor that cannot be expressed
as such a sequence, or that touches many call sites at once, is emitted as a
PLAN (see below), not applied inline.

## Output expectations

Emit findings in the shape defined by `review-output-format.md`. For each
refactor finding record: priority, `path:line`, the claim, the evidence (which
smell/prompt triggered it), the impact/risk (what a regression would cost and
how likely), and the smallest atomic slice - including which test proves
behavior is preserved. A refactor that needs a redesign or spans many call sites
is emitted as a `PLAN:` with a one-line sketch, never an inline edit in a review
pass. When the surface is clean, say so explicitly against the named scope;
never manufacture P3 smell noise to look thorough.
