# Module Depth Review Profile

You review ONLY through this lens: module depth, information hiding, locality,
change amplification, caller leverage, and premature abstraction. Do not turn
naming, test-oracle, type-contract, runtime, architecture-boundary, refactoring,
or security concerns into findings from this profile except where the full rule
is explicitly owned here.

Template-Version: 3 (review-recall 2026-07-15)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

This profile carries the following preserved provenance:

- Architecture-deepening material remains distilled from
  `mattpocock/skills` @ `391a2701` (ideas only, layered over Ousterhout's
  *A Philosophy of Software Design*) and `ramziddin/solid-skills`
  complexity.md @ `b113ce6` (MIT, adapted excerpts).
- Stack-router material remains paraphrased from
  `awesome-skills/code-review-skill` (MIT, pinned `f2fd4e57`) plus repo
  experience, as attributed in `language-review-sources.md`: its per-language
  guides, `code-quality-universal.md`, `common-bugs-checklist.md`, and
  cross-cutting async/error notes. The Node lens was written from universal
  material plus repo experience because upstream has no dedicated lens for it.

## Cross-cutting structural checks

- **Reuse before writing.** Does a new helper or util duplicate one already in
  the repo (adjacent files, `shared/`, `utils/`)? Reinvented local code drifts
  out of sync. Type reuse is owned by
  → see `profile-types-and-contracts.md` §Type placement and reuse; constant
  reuse by → see `profile-naming-and-constants.md` §Constants placement and reuse.
- **Over-broad reads.** Does the code load a whole collection or file to use a
  slice? Push the filter/limit to the source (DB query, `readline`).

## Architecture-deepening conditionality banner

Depth judgments are CONDITIONAL. They pay off in proportion to how many callers
and how many years a module must survive:

- **strong** - long-lived shared modules: code many callers depend on, a public
  interface, a library boundary, anything whose shallowness compounds over time.
- **light** - one-off scripts and short pipelines: a task runner does not need a
  "deep module"; flag only egregious pass-throughs and leakage.

When unsure, prefer the smallest structural change that removes the most future
friction; never redesign a script slated for deletion next quarter. A prompt
that would push structure onto code fine as a flat function does not apply; that
is not a finding.

## Depth vocabulary

- **Module** - a unit of code behind an interface: function, class, file, or
  package. **Interface** - every fact a caller must know to use it: signatures
  plus invariants, ordering, error modes, and performance, not just types.
- **Depth** - behavior hidden per unit of interface a caller must learn.
  **Deep** means much behavior and a small interface; **shallow** means the
  interface is nearly as wide as the implementation. Depth is a property of the
  interface, not the implementation.
- **Leverage** - how much a caller or test can do per unit of interface it must
  learn.
- **Seam** - a place behavior can change without editing there. One adapter is a
  hypothetical seam; two is a real one.
- **Locality** - how much of one behavior lives close together versus scattered.

## Deep versus shallow modules

Weighting: strong for shared modules; light for scripts.

- **Measure the ratio, do not eyeball it.** **Check:** for a suspect module,
  weigh what a caller must read to use it correctly (the full interface -
  signature plus invariants, ordering, error modes) against what it hides. A
  numerator near the denominator confirms shallowness; a small numerator over a
  large denominator confirms depth.
- **Interface-to-implementation ratio.** A shallow module makes the caller learn
  almost as much as inlining would, for the cost of an extra hop. **Check:** is
  the public surface (params, return, and the full interface above) nearly as
  complex as the body? If a caller must understand internals to call it
  correctly, it is shallow - finding.
- **Pass-through method / wrapper / param.** A method that only forwards, a
  parameter threaded untouched to a deeper call, or a manager that only
  delegates adds a name but no abstraction. **Check:** does it add behavior or
  only relay it? Pure relay is a P3 candidate to inline or collapse.
- **Thin manager / anemic wrapper.** **Check:** does a class hold no invariant
  and only forward calls to its fields? Merge it into caller or callee.
- **Merge candidates.** **Check:** do two shallow modules always used together
  form one deeper module with a simpler combined interface? If the seam varies
  nothing, propose the merge; use a PLAN if it moves call sites.
- **Classitis.** A proliferation of tiny modules/classes, each contributing
  little, costs more total interface to learn than a few deep ones. **Check:**
  count modules touched for one small task; if each does almost nothing and
  exists mainly to be "small", that is classitis - a deepen/merge candidate.
- **Different layer, same abstraction.** Adjacent layers should hide different
  kinds of complexity. **Check:** does this layer's interface mirror the one it
  calls through same-signature forwarding? It likely adds no depth; collapse it.

## The deletion test

Weighting: strong for class-heavy TS. On script-style code, a helper that reads
better inline is noise, not a finding.

- **Delete-and-inline thought experiment.** For each unit of structure, imagine
  deleting it and inlining behavior into callers. **Check:** does complexity
  vanish (only a name was lost -> shallow, P3 simplification) or reappear as
  duplication across callers or a leaked invariant (it earns its place; leave
  it)?
- **One versus two adapters.** **Check:** a seam with exactly one implementation
  and no second in sight is hypothetical; do not defend it as depth. Two
  implementations, or a real test fake, is a real seam worth keeping.
- **Deletion test on a whole layer.** **Check:** could a layer be deleted and its
  neighbors talk directly, losing only forwarding? If yes, the layer is a
  pass-through tier - a high-leverage merge emitted as a PLAN.

## Information hiding and leakage

Weighting: strong for shared modules; light for scripts.

- **A decision known to many modules is leaked.** Leakage means changing that
  decision edits every module that knows it. **Check:** does a single change
  (add field, change format, rename status) force edits in distant files? Name
  the decision that should live hidden in one module.
- **Temporal decomposition smell.** Modules split by WHEN things run
  (read -> process -> write) instead of by knowledge they hide tend to share one
  secret across all three. **Check:** are modules organized by phase, each
  touching the same format/decision? Re-cut around hidden knowledge, not time.
- **Config sprawl.** **Check:** is one concern's configuration spread across
  files/env vars/flags that must all change together? Consolidate leaked
  knowledge.
- **Implementation detail exposed publicly.** A public method or field callers
  do not need widens the interface and freezes implementation. **Check:** is a
  helper, intermediate state, or format detail public with no external caller?
  Narrow it to private.
- **Hidden global input.** A global/singleton read deep inside a module hides its
  source and breeds unknown-unknowns. **Check:** is an input read globally
  rather than passed at the boundary? Make the dependency explicit.

## Locality of behavior

Weighting: strong for shared modules; light for scripts.

- **Behavior reads close together.** **Check:** to understand one feature, how
  many files must a reader open in sequence? High fan-out across distant files
  is a locality smell - co-locate.
- **Wiring/config lives near the code it governs.** **Check:** does
  configuration, route registration, or a feature flag live far from behavior,
  hiding cause and effect? Finding.
- **No splitting to satisfy a dogma the repo ignores.** **Check:** is related
  logic split only to honor layering the rest of the repo does not follow?
  Re-co-locate; consistency beats partial dogma.
- **Conjoined methods.** Two methods that must be read together to understand
  either are a decomposition smell. **Check:** can method A be understood
  without B and vice versa? If not, merge or re-cut the seam so each stands
  alone.

## Pull complexity downward and define errors out of existence

Weighting: strong for shared modules and public APIs; light for scripts.

- **Pull complexity down.** One module should absorb complexity rather than push
  it to every caller. **Check:** does an API make every caller handle the same
  edge, set the same defaults, or perform the same follow-up? Absorb it behind
  the interface.
- **Define errors out of existence.** An error callers cannot act on, or a state
  that should not be representable, is best designed away. **Check:** does an API
  throw/return an error every caller handles identically or ignores, when the
  interface could make the case impossible or benign (for example, delete an
  absent key silently, clamp a range)? Redesign to remove the error class using
  a PLAN. This differs from
  `profile-correctness-and-lifecycle.md` §Error handling, which checks that
  errors that exist are handled.
- **Special cases pushed to callers.** **Check:** is null/empty/boundary handling
  duplicated at every call site instead of handled once inside? Pull it down.
- **Configuration overload.** **Check:** does an interface force callers to
  assemble a large options object where sane defaults would do? Push defaults
  down and keep required surface minimal.

## Generality and premature abstraction

Weighting: strong for shared modules; light for scripts.

- **Somewhat-general interface, but not built for hypotheticals.** An
  over-special interface leaks the current use case; an over-general one adds
  unused parameters and cognitive load. **Check:** does the interface carry
  options/hooks no current caller uses "for future extensibility"? Remove them.
  Conversely, is it so tied to one caller that a second cannot reuse it? Note
  the special-purpose leak.
- **Rule of Three.** **Check:** was an abstraction extracted from one use or from
  duplication seen only twice? The wrong abstraction costs more than
  duplication; under three real uses, inlining may be the fix.

## The three complexity symptoms

Weighting: strong for shared modules; light for scripts. These are symptoms;
trace each to a cause in the preceding sections.

| Symptom | What it looks like | Check |
| --- | --- | --- |
| **Change amplification** | one conceptual change touches many files | estimate files edited to add one field/change one format; high count means a boundary is missing or a decision leaked |
| **Cognitive load** | many things must be held in mind to touch one thing | count other modules needed to change this safely; high means tight coupling, hidden dependencies, or unclear names |
| **Unknown-unknowns** | it is not obvious what must change or break | can a competent reader tell from the interface everything a change could affect? Name surprising action-at-a-distance or hidden state |

## Leverage ranking

Applies whenever this profile produces more than one deepening finding.

- **Rank by leverage.** Which single change simplifies the most callers or
  unblocks the most future work? Tackle that first; churn that only moves code
  ranks last or is dropped.
- **Smallest slice per finding.** Name the smallest slice that captures most of
  the benefit; a redesign across many call sites is a PLAN.
- **Essential versus accidental complexity.** Is complexity inherent to the
  domain (leave it, express clearly) or introduced by the solution (target it)?
  Do not simplify essential complexity into hidden bugs.

## Candidate strength

Applies to every deepening finding.

- **Concentrate-versus-move filter.** Does the proposed deepening concentrate
  complexity behind a smaller interface, or merely move it? Only concentrate
  cases are findings; moving it around is not a finding.

| Grade | Meaning | Emit as |
| --- | --- | --- |
| **Strong** | clear shallowness/leakage; deepening obviously concentrates complexity behind a smaller interface | actionable finding |
| **Worth exploring** | plausible but depends on evolution; current pain is real but modest | finding flagged as a judgment call |
| **Speculative** | pays only under a future that may not arrive | note and move on; not a finding |

## Stack routing

The stack router does not decide whether a module-depth section applies; the
conditionality banner above does. Route by actual surface, record the choice,
and preserve these module-depth scope constraints:
Adopting repos may add rows for their own stacks; every row points to exactly
one matching section or weighting.

| Surface | Module-depth routing |
| --- | --- |
| TypeScript service / shared module | apply strong/shared-module tiers as the code's lifetime and caller count warrant |
| Script-style TS / one-off pipeline | flag only egregious pass-throughs, leakage, or needless caller complexity |
| React / UI TS | apply only real module-depth and locality rules; runtime hook/effect checks live in correctness |
| Node / backend TS | apply shared-module depth according to lifetime, public surface, and caller count |

## Output

Follow `review-contract.md` exactly. Record the triggering section,
conditionality tier (strong/light/none and why), candidate strength, risk,
leverage rank, and smallest behavior-preserving slice; speculative cases are
not findings. Multi-call-site changes are PLANs, never inline rewrites. Report
every applicable instance and include per-file `COVERAGE`/`CLEAN` claims. When
a script/glue surface is out of scope or a shared surface is already deep, say
so instead of manufacturing module-depth findings.
