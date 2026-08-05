# Refactoring and Smells Review Profile

You review ONLY through this lens: safe structural refactoring, accidental
complexity, code smells, seams, duplication, dead code, speculative
flexibility, and technical-debt execution. Do not turn naming, test-oracle,
type-contract, runtime, architecture-boundary, module-depth, or security
concerns into findings from this profile except where the full rule is
explicitly owned here.

Template-Version: 4 (sonarjs-gate-boundary 2026-07-28)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

This profile carries the following preserved provenance:

- Refactoring material remains distilled as short paraphrased excerpts from
  `ramziddin/solid-skills` (MIT, pinned `b113ce68`) `code-smells.md` and
  `complexity.md`. Tech-debt classification and execution order remain the
  repo's own material over industry-standard Fowler vocabulary.
- Stack-router material remains paraphrased from
  `awesome-skills/code-review-skill` (MIT, pinned `f2fd4e57`) plus repo
  experience, as attributed in `language-review-sources.md`: its per-language
  guides, `code-quality-universal.md`, `common-bugs-checklist.md`, and
  cross-cutting async/error notes. The Node lens was written from universal
  material plus repo experience because upstream has no dedicated lens for it.

## Refactoring conditionality banner

- **Strongest for code with real callers and real tests** - a service, shared
  module, or runner primitive. There a behavior change slipped in as a refactor
  is production risk, and a seam that cuts real coupling earns its keep.
- **Lighter for script-style glue** - prefer plain readability; do not
  manufacture seams, value objects, or abstractions a single caller will use.
  Most OO-abuser and coupler smells do not apply to a linear script.
- **A refactor not worth its risk is itself a finding** - record it as "leave
  it" with the reason (stable, untouched, slated for deletion, or principal
  exceeds interest), not as a P3 to churn.

Observable behavior preservation is owned by
→ see `profile-correctness-and-lifecycle.md` §Behavior preservation during
refactors. Characterization tests and pinning-test sensitivity are owned by
→ see `profile-tests-quality.md` §Test-cover before a refactor.

## Small atomic refactor steps

- **Decompose into independently-verifiable slices.** A large all-at-once
  structural diff defeats bisecting and review even when correct. **Check:** is
  each slice green on its own tests before the next begins? A monolithic
  refactor diff is a finding.
- **Keep each slice revertible alone.** **Check:** can slice N be reverted
  without breaking slice N+1? Slices that must land together are really one
  slice; slices that need not are over-batched.
- **Back every slice with a finding.** A refactor slice with no finding behind
  it is churn. **Check:** which prompt in this profile or another assigned
  profile triggered it? If none, drop it.
- Pinning-test sensitivity is owned by
  → see `profile-tests-quality.md` §Test-cover before a refactor.

## Accidental versus essential complexity

A smell is worth removing only when the complexity is accidental - added by the
solution, not demanded by the problem. Essential complexity (real business
rules, domain edges, irreducible state machines) must be expressed clearly, not
deleted. Accidental complexity (needless indirection, framework ceremony, wrong
abstraction) is the refactor target.

- **Separate essential from accidental before flagging.** Deleting essential
  complexity is behavior change, not cleanup. **Check:** does this
  branch/layer/abstraction encode a domain rule or only solution plumbing? Only
  the second is a finding.
- **Read change amplification as a signal.** To add one field, must many files
  change? That points to scattered responsibility. Name the missing home.
- **Read cognitive load as a signal.** How many other units must be held in mind
  to understand this one? High load points to hidden dependencies or a missing
  seam, not a naming nit.
- **Do not trade duplication for the wrong abstraction.** Is a proposed shared
  abstraction genuinely the same concept in every caller, or three things that
  merely look alike today? When unsure, leave duplication under the rule of
  three.
- **Where a counted complexity form already has a machine owner, reference the
  gate.** A repo that runs the `sonarjs` disposition matrix (ADR-026) hands the
  mechanically-counted forms to it — the specific ones its own matrix marks
  `enabled`, typically cognitive/cyclomatic complexity, nesting and control-flow
  depth, switch-case count, and identical function bodies. Do not re-flag those
  by hand; cite the rule. **Check:** is the repo's matrix `enabled` on the rule
  that owns this exact form? Only then defer. Everything in this section that no
  rule counts stays a finding here: essential versus accidental, change
  amplification, cognitive load, and the duplication-versus-wrong-abstraction
  judgment. Partial gate coverage never silently retires an uncovered ceiling.

## Code-smells taxonomy

A smell is an indicator, not a bug. Confirm real understand/change/test pain
before flagging; honor each "Not a smell when" exception; name the smallest
remedy; and use the typical priority unless a live defect raises it. Thresholds
are signals to inspect, never automatic findings. Smells are almost never P1; a
smell hiding a live correctness/safety defect is a correctness finding wearing
a smell's clothes.

### Bloaters

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
| --- | --- | --- | --- | --- |
| Long function | one function mixes validate + compute + persist + notify across many screens | one flat data literal or a single exhaustive `switch` with no shared logic | Extract Function per concern | P3 |
| Large class | one type owns unrelated clusters (`auth` + `prefs` + `billing`) | cohesive value object or thin DTO | Extract Class along responsibility seams | P3 |
| Long parameter list | `f(a,b,c,d,e)` where several args always travel together | arguments are genuinely independent and few | Introduce Parameter Object / pass whole record | P3 |
| Data clumps | same 3+ fields recur across signatures (`x,y,w,h`) | group appears exactly once | Extract a small type | P3 |
| Primitive obsession | domain concept (money, id, email) is bare `string`/`number` with validation copied at call sites | one-off local with no invariant | Wrap in a value object that validates once | P2/P3 |

The full invariant/type rule for primitive obsession is in
→ see `profile-types-and-contracts.md` §Value objects and domain primitives.

### Object-orientation abusers

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
| --- | --- | --- | --- | --- |
| Switch on type | `switch(x.type)` / if-else on a tag repeated in more than one place | single localized dispatch or compiler-exhaustive discriminated union | Replace with polymorphism or lookup table | P3 |
| Refused bequest | subclass ignores or throws on inherited members | base is genuine `is-a` and member optional by design | Replace inheritance with delegation/composition | P2 |
| Temporary field | field set only in some flows and otherwise null/unused | null is a modeled, documented state | Extract transient state into object/parameter | P3 |

Contract-level refused bequest is also owned by
→ see `profile-types-and-contracts.md` §Substitutability and interface width.

### Change preventers

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
| --- | --- | --- | --- | --- |
| Divergent change | one module edited for unrelated reasons over time | reasons share a genuine axis | Extract Class along change axes (SRP) | P2 |
| Shotgun surgery | one logical change forces scattered edits | fan-out is deliberate, documented layering | Gather scattered pieces into one home | P2 |
| Parallel inheritance | adding subclass here forces matching subclass there | pairing is coincidental, not structural | Collapse or merge hierarchies | P3 |

### Dispensables

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
| --- | --- | --- | --- | --- |
| Dead code | unreachable branch, unused export/param, never-taken flag | deterministic gate already owns it; reference, do not duplicate | Delete, preferring Knip/tsc/dependency-cruiser | P3 |
| Speculative generality | abstraction, hook, or config knob with no live caller | committed imminent documented need | Delete (YAGNI) | P3 |
| Lazy class | class/module no longer earns its keep, pure passthrough | deliberate boundary/adapter | Inline it | P3 |
| Comments-as-deodorant | comment explains WHAT confusing code does | non-obvious WHY, gotcha, or trade-off | Rename/extract, then delete comment | P3 |

Comment keep/delete semantics are owned by
→ see `profile-naming-and-constants.md` §Comments.

### Couplers

| Smell | Check: signature | Not a smell when | Smallest remedy | Prio |
| --- | --- | --- | --- | --- |
| Feature envy | method uses another type's data more than its own | access is incidental or one field | Move Method to data's home | P3 |
| Inappropriate intimacy | two modules reach into each other's internals | internals are a deliberate cohesive pair | Tell-don't-ask: expose owner method, hide field | P2 |
| Message chains | `a.getB().getC().getD()` navigates structure caller should not know | fluent builder designed to chain | Hide Delegate at first hop | P3 |
| Middle man | class/method only forwards | deliberate adapter or anti-corruption boundary | Inline; call target directly | P3 |

## Seams and dependency injection

- **Flag a hard-wired external dependency that blocks unit testing.** A unit
  testable only end-to-end is slow and brittle. **Check:** to replace a clock,
  filesystem, network, git, or subprocess, is there a seam (parameter, injected
  function, edge interface), or is it hard-wired? Absence where testing needs a
  seam is a finding.
- **Reject a seam that only adds indirection.** A needless seam is
  over-engineering, not decoupling. **Check:** does it cut real coupling or only
  add a name/layer? Apply
  → see `profile-module-depth.md` §The deletion test; if deletion loses nothing,
  do not add it.
- **Keep the existing caller's behavior identical.** **Check:** does the seam
  default-wire exactly as today? A changed default is behavior change, not
  refactor.

## Duplication, dead code, and speculative flexibility

- **Prefer deletion, but defer to the owning gate.** **Check:** is unreachable
  code, an unused export, or never-taken flag already caught by Knip, `tsc`, or
  dependency-cruiser? Reference the gate; do not duplicate its finding.
- **Apply the rule of three to duplication.** The wrong abstraction is worse
  than duplication. **Check:** first copy - leave it. Second - note and leave.
  Third - finding: name the single home and smallest slice to collapse it.
- **Record speculative flexibility as a deletion candidate.** Does every
  abstraction, parameter, and knob have a real caller today? A "just in case"
  one is a P3 deletion candidate.

## Tech-debt classification

Debt is not a defect. A defect is wrong behavior now; review it through
`profile-correctness-and-lifecycle.md`, with a failure case. Debt is correct
behavior carried by costly structure; record it here so a reader can decide if
paying it is worth the principal.

### Quadrant: why the debt exists

| | Prudent | Reckless |
| --- | --- | --- |
| **Deliberate** | ship now, accept X, cost known - tracked debt with payback trigger, not a defect | "no time for design" - shortcut with no payback plan; name missing plan |
| **Inadvertent** | now we know how it should have been done - refactor when next in path (Boy-Scout) | did not know principle - apply code-smell taxonomy |

### Interest versus principal

*Principal* is cost to fix now. *Interest* is ongoing tax paid by future changes.
Prioritize by interest rate times change frequency, NOT principal. High-interest
code that changes often should be paid down (raise to P2); low-interest or
rarely-touched code should be deferred even when principal is large.

### Debt worth not paying

Is code slated for deletion/replacement, making refactoring wasted principal,
or stable-and-untouched, paying no interest? Then the finding is "leave it" and
states why. Boy-Scout improvements apply only when already editing that code for
another reason.

## Refactor execution order

When one finding needs several slices, keep the tree green at every step:

1. **Pin first.** Add characterization test; nothing moves before behavior is
   covered.
2. **Introduce additively.** Create the new home/seam with old path still wired;
   tests stay green.
3. **Migrate callers one at a time**, verifying after each; never move all
   callers in one slice.
4. **Delete the old path last**, after no caller remains.
5. **Order low-risk, high-value first** - rename, extract constant, delete dead
   code - before structural moves. Never fold behavior change into the sequence.

Each step is one committable, revertible slice. A step that cannot be green on
its own is mis-cut; re-slice it. A refactor that cannot be expressed this way,
or touches many call sites at once, is emitted as a PLAN, not applied inline.

## Stack routing

The stack router does not decide whether a refactoring section applies; the
conditionality banner above does. Route by actual surface, record the choice,
and preserve these refactoring scope constraints:
Adopting repos may add rows for their own stacks; every row points to exactly
one matching section or weighting.

| Surface | Refactoring routing |
| --- | --- |
| TypeScript service / shared module | apply strong refactoring tiers where real callers and tests make structural risk concrete |
| Script-style TS / one-off pipeline | prefer plain readability; most OO-abuser and coupler smells are light or out of scope |
| React / UI TS | apply only real structural smells and safe slices; runtime hook/effect checks live in correctness |
| Node / backend TS | apply service/module rules according to lifetime, callers, tests, and declared boundaries |

## Output

Follow `review-contract.md` exactly. Name the triggering smell/prompt,
conditionality tier (strong/light/none and why), risk, smallest atomic slice,
and the test that preserves behavior. Redesigns or multi-call-site changes are
PLANs, never inline rewrites. Report every applicable instance and include
per-file `COVERAGE`/`CLEAN` claims. When a script/glue surface is out of scope or
a refactor is not worth its risk, say so instead of manufacturing P3 churn.
