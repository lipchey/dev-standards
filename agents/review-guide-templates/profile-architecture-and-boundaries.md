# Architecture and Boundaries Review Profile

You review ONLY through this lens: dependency direction, boundary shape,
ports/adapters, layer separation, SOLID, DDD boundaries, and framework
isolation. Do not turn naming, test-oracle, type-contract, runtime, module-depth,
refactoring, or security concerns into findings from this profile except where
the full rule is explicitly owned here.

Template-Version: 3 (review-recall 2026-07-15)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

This profile carries the architecture-and-boundaries share of the repo-owned
`core-code-guidelines.md` baseline and the following preserved provenance:

- Clean-architecture material remains paraphrased from MIT sources:
  `ramziddin/solid-skills` @ `b113ce6`, `wondelai/skills`
  clean-architecture @ `326b380`, and
  `affaan-m/everything-claude-code` hexagonal-architecture @ `4092795`.
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
- **A new workspace/package must be named in every scoped gate list.** Quality
  gates are scoped by explicit path lists (eslint preset `files` globs, boundary
  blocks, `quality.json` filesets, typecheck chains), so a NEWLY-added workspace
  is invisible to all of them - silently unlinted, unchecked, uncovered - until
  each list names it by hand. **Check:** does this diff add an app / package /
  workspace? If so, is every scoped gate list (eslint, staged/full filesets,
  boundary rules, typecheck chain) extended to include it, or is the new zone a
  gate blind spot? (2026-07-15, dev-standards / ai-prompter adoption - two pilot
  ledger escapes: a `site/` zone blind to eslint+staged, a missing deep contract
  in a second zone)

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

## Stack routing

The stack router does not decide whether an architecture section applies; the
conditionality banner above does. Route by actual surface, record the choice,
and preserve these architecture scope constraints:
Adopting repos may add rows for their own stacks; every row points to exactly
one matching section or weighting.

| Surface | Architecture routing |
| --- | --- |
| TypeScript service / shared module | apply strong architecture tiers as the code's lifetime and declared DAG warrant |
| Script-style TS / one-off pipeline | apply only architecture rules that cut real coupling; do not manufacture layers or ports |
| React / UI TS | apply only real module/boundary rules; runtime hook/effect checks live in correctness |
| Node / backend TS | apply service/module rules according to lifetime and declared boundaries |

## Output

Follow `review-contract.md` exactly. Record the triggering section,
conditionality tier (strong/light/none and why), risk, and smallest
behavior-preserving slice. Boundary redesigns or multi-call-site changes are
PLANs, never inline rewrites. Report every applicable instance and include
per-file `COVERAGE`/`CLEAN` claims. When a script/glue surface is out of scope,
say so instead of manufacturing architecture findings.
