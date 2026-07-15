# Structure and Dependencies Review Profile

You review ONLY through this lens: dependency direction, boundaries, cohesion,
module depth, change amplification, duplication, dead code, and safe structural
refactoring. Do not turn naming, test-oracle, type-contract, runtime, or security
concerns into findings from this profile except where the full rule is explicitly
owned here.

Template-Version: 3 (review-recall 2026-07-15)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

This profile carries the relevant share of the repo-owned
`core-code-guidelines.md` baseline and the following preserved provenance:

- Clean-architecture material remains paraphrased from MIT sources:
  `ramziddin/solid-skills` @ `b113ce6`, `wondelai/skills`
  clean-architecture @ `326b380`, and
  `affaan-m/everything-claude-code` hexagonal-architecture @ `4092795`.
- Architecture-deepening material remains distilled from
  `mattpocock/skills` @ `391a2701` (ideas only, layered over Ousterhout's
  *A Philosophy of Software Design*) and `ramziddin/solid-skills`
  complexity.md @ `b113ce6` (MIT, adapted excerpts).
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

## Baseline structural checks

- Does the change cross a module boundary in a way that leaks internals a caller
  should not need?
- Is there needless duplication that will drift out of sync, or needless
  indirection that adds a name but no behavior? Weigh both directions - do not
  manufacture an abstraction a single caller will ever use.

## Cross-cutting structural checks

- **Reuse before writing.** Does a new helper or util duplicate one already in
  the repo (adjacent files, `shared/`, `utils/`)? Reinvented local code drifts
  out of sync. Type reuse is owned by
  → see `profile-types-and-contracts.md` §Type placement and reuse; constant
  reuse by → see `profile-naming-and-constants.md` §Constants placement and reuse.
- **Over-broad reads.** Does the code load a whole collection or file to use a
  slice? Push the filter/limit to the source (DB query, `readline`).

## Clean-architecture conditionality banner

SOLID, ports/adapters, and layering rules are CONDITIONAL by repo surface. Do
not import them blindly; they overfit NestJS-style class-heavy code and
manufacture ceremony on script-style pipelines. Judge against the repo's
declared layers in `.claude/project-facts.md` - that DAG, never a textbook
diagram:

- **strong** - class-heavy TypeScript: DI containers, service classes, layered
  domain models, repositories/gateways. Ports, dependency direction, and SOLID
  all pay off here.
- **light** - script-style TS pipelines: apply only parts that cut real coupling;
  never invent an interface a single caller will ever use.

If a rule below would force structure onto code that is fine as plain functions
or a script, the rule does not apply - that is not a finding.

## The dependency rule and boundary shape

Weighting: strong for layered code, light for pipelines.

- **Imports point inward.** Inner layers (entities, domain, use-cases per
  `project-facts.md`) must never name an outer layer - that keeps them swap- and
  test-able. **Check:** read imports of each inner-layer module; any import of a
  framework, transport (HTTP/router), ORM/DB client, or vendor SDK is a finding
  unless `project-facts.md` declares that module outer.
- **Data crosses a boundary in the inner shape.** An ORM row or framework
  request object dragged inward re-couples the core to a detail. **Check:** does
  a use-case/domain function accept or return a framework object (`req`, `res`,
  an ORM entity, raw DB row) instead of a plain DTO or domain type? Finding.
  DTO/domain type ownership is also described in
  → see `profile-types-and-contracts.md` §Layer-boundary data contracts.
- **No cycles between layered modules.** A cycle means neither module can be
  read, tested, or released without the other. **Check:** trace imports (or read
  the dependency-cruiser report - do not re-report a cycle the gate already
  owns); name the cycle and the single edge to invert, usually through an
  inner-owned interface.
- **Actual graph matches the declared DAG.** **Check:** reconcile real import
  direction against the `project-facts.md` layer DAG; flag each violating edge
  as `<outer> → <inner>` with the layer contract it breaks.

## Ports and adapters

Weighting: strong for class-heavy TS; light for pipelines, subject to the
one-adapter caution.

- **The core owns the port interface.** If the adapter's package defines the
  interface, the dependency still points outward. **Check:** locate each port
  interface's file - it must live in domain/application, not adapter/infra.
  Interface defined beside its concrete adapter is a finding.
- **Adapters are swappable.** A boundary that cannot swap real -> in-memory is
  leaking. **Check:** can the use case be constructed with an in-memory fake
  port in a unit test without importing infra? If a test needs the real DB/HTTP
  to exercise business logic, the port is not a real seam - finding.
- **Construction happens only at the composition root.** Concretes newed up
  inside inner layers re-couple them to infra. **Check:** look for
  `new <ConcreteAdapter>(` or SDK-client construction inside domain/use-case
  files; wiring belongs only in `main`/container/factory. Inner construction is
  a finding (also DIP).
- **One-adapter-forever ports are over-abstraction.** A port with exactly one
  implementation that will only ever have one buys indirection, not decoupling.
  **Check:** exactly one implementation, no test double, no planned second, on
  script-style code -> P3 simplification candidate. Two implementations or a
  real test fake is a real seam; keep it.
- **Adapters do not call each other.** **Check:** an outbound adapter importing
  another outbound adapter and bypassing the use case is a finding. Legal flows
  are inbound adapter -> port -> use case and use case -> port with an outbound
  adapter implementing it; never adapter -> adapter directly.

## Layer separation

Weighting: strong for layered domains; light for pipelines.

- **Entities hold enterprise rules and do zero I/O.** **Check:** does an entity
  or value-object method perform I/O (DB, HTTP, fs, logging) or import infra?
  Finding - that behavior belongs in a use case or adapter.
- **Use cases orchestrate; they embed no transport or persistence detail.**
  **Check:** does a use case build SQL, parse HTTP, or read env/framework globals
  directly? Finding - push it behind an outbound port.
- **Interface adapters translate only.** **Check:** does a controller/presenter
  make business decisions (pricing, domain-invariant validation, state
  transitions) rather than translate protocol <-> use-case shapes? Finding -
  move the decision inward.
- Domain-type/transport-DTO separation and one-time mapping are owned by
  → see `profile-types-and-contracts.md` §Layer-boundary data contracts.

## SOLID

Weighting: strong for class-heavy TS; light-to-none for script-style code. A
violation is a finding only when it causes real coupling or change-pain on this
surface. On flat pipelines most violations are non-findings.

### SRP - one reason to change (one actor)

- **Smell:** a module edited for unrelated reasons (persistence + presentation +
  business), an "and" in its description, a `util`/`manager` that grows forever.
- **Check:** list distinct actors who could request a change to this module;
  more than one is a finding.
- **When NOT:** a small cohesive script doing a linear job is one responsibility
  even across several steps.
- **Smallest remedy:** split along the actor seam; do not pre-split
  speculatively.

### OCP - extend by adding, not editing

- **Smell:** an `if`/`switch` on a `type`/`kind` string that grows a branch per
  variant and is edited on every new one.
- **Check:** to add the next variant, must existing tested code be modified
  rather than a new unit added? Finding when the variant set is open-ended.
- **When NOT:** a closed set of two or three cases; a switch is clearer than a
  strategy hierarchy, and polymorphism there is over-abstraction.
- **Smallest remedy:** replace the conditional with a strategy/lookup only once
  variants actually vary independently.

LSP and ISP contract rules are owned by
→ see `profile-types-and-contracts.md` §Substitutability and interface width.

### DIP - depend on abstractions the inner layer owns

- **Smell:** business logic constructs a concrete infra class
  (`new StripeClient()`, `new PgPool()`) or imports an SDK directly.
- **Check:** read inner-layer files for concrete infra construction/imports;
  each is a finding (also §Ports and adapters composition-root).
- **When NOT:** a leaf script with a single I/O call, no test and no second
  implementation; a direct call is fine, a port is ceremony.
- **Smallest remedy:** define a port inward and inject the concrete at the
  composition root.

Value-object and domain-primitive rules are owned by
→ see `profile-types-and-contracts.md` §Value objects and domain primitives.

## DDD boundaries

Weighting: strong for multi-context domains; often none for a small
single-purpose repo. Say so rather than inventing contexts.

- **Bounded contexts do not reach into each other's internals.** **Check:** does
  a module import another context's internal entities/tables directly instead
  of going through a published contract/port? Cross-boundary reach-in is a
  finding.
- Cross-boundary terminology drift is owned by
  → see `profile-naming-and-constants.md` §Ubiquitous language across boundaries.
- **Cross-boundary communication is an explicit contract, not shared mutable
  state.** **Check:** do two contexts share a mutable object/table both write,
  instead of exchanging DTOs/messages through a defined interface? Shared
  mutable state across a boundary is a finding.

## Framework isolation

Weighting: strong for framework-heavy code; light or none otherwise.

- **Framework types and annotations stay at the edge.** A decorator or
  framework type on a domain class couples the core to the framework's lifecycle
  and version. **Check:** read domain/use-case files for framework imports,
  decorators (`@Injectable`, `@Entity`, `@Controller`), or framework base
  classes; any in the core is a finding - keep them in adapters.
- **The framework calls inward, never the reverse.** **Check:** does inner code
  import the framework (Express `Router`, a Nest module, an ORM base) rather
  than being called by an adapter that does? Finding.

Behavior-first tests at ports are owned by
→ see `profile-tests-quality.md` §Behavior-first tests at boundaries.

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
  add a name/layer? Apply §The deletion test; if deletion loses nothing, do not
  add it.
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

The stack router does not decide whether an area section applies; each banner
above does. Route by actual surface, record the choice, and preserve these
structural scope constraints:
Adopting repos may add rows for their own stacks; every row points to exactly
one matching section or weighting.

| Surface | Structural routing |
| --- | --- |
| TypeScript service / shared module | apply strong/shared-module tiers as the code's lifetime and declared DAG warrant |
| Script-style TS / one-off pipeline | correctness/readability dominate; structural and abstraction rules are light or out of scope per their banners |
| React / UI TS | apply only real module/boundary rules; runtime hook/effect checks live in correctness |
| Node / backend TS | apply service/module rules according to lifetime and declared boundaries |

## Output

Follow `review-contract.md` exactly. For architecture findings, record the
triggering section, conditionality tier (strong/light/none and why), risk, and
smallest behavior-preserving slice. For deepening findings, also record candidate
strength and rank by leverage; speculative cases are not findings. For refactor
findings, name the smell/prompt and the test that preserves behavior. Boundary
redesigns or multi-call-site changes are PLANs, never inline rewrites. Report
every applicable instance and include per-file `COVERAGE`/`CLEAN` claims. When a
script/glue surface is out of scope or a shared surface is already deep, say so
instead of manufacturing structure findings.
