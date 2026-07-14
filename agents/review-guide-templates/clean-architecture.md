# Clean Architecture (review guide template)

Package template. Sources (all MIT, verified):

- `ramziddin/solid-skills` @ `b113ce6` — SOLID, object design, and
  layered/hexagonal architecture references (adapted excerpts).
- `wondelai/skills` clean-architecture @ `326b380` — the Dependency Rule,
  entities/use-cases, boundaries, component principles (adapted excerpts).
- `affaan-m/everything-claude-code` hexagonal-architecture @ `4092795` —
  ports/adapters, composition root, per-boundary testing (adapted excerpts).

Paraphrased throughout; no verbatim blocks copied.
Template-Version: 2 (guides-revamp 2026-07-11)

Deep-review reads this file in place. An adopting repo may extend it additively
with a same-named file in `.claude/review-guides/`; the package body remains
active. The prompts below are review-only JUDGMENT PROMPTS for a human or
reviewing agent — they say what to look for and how to weigh it, never an
instruction to edit. This guide adds the architecture long tail ABOVE
the always-on `core-code-guidelines.md` baseline; where a rule sits next to a
baseline rule it cross-references it by name rather than restating it.

## Conditionality banner (read before applying)

SOLID, ports/adapters, and layering rules here are CONDITIONAL by repo surface.
Do not import them blindly — they overfit NestJS-style class-heavy code and
manufacture ceremony on script-style pipelines. Weight every section below by the
tier it declares, and judge against the repo's declared layers in
`.claude/project-facts.md` (that DAG, never a textbook diagram):

- **strong** — class-heavy TypeScript: DI containers, service classes, layered
  domain models, repositories/gateways. Ports, dependency direction, and SOLID
  all pay off here.
- **light** — script-style TS pipelines (a few functions transforming data
  top-to-bottom). Apply only the parts that cut real coupling; never invent an
  interface a single caller will ever use.
- **none** — Bash / n8n glue. No classes, ports, or domain layers to judge; skip
  this guide entirely for that surface.

If a rule below would force structure onto code that is fine as plain functions
or a script, that is a signal the rule does not apply here — not a finding.

## 1. The dependency rule

Weighting: strong for layered code, light for pipelines, none for glue.

- **Imports point inward.** Inner layers (entities, domain, use-cases per
  `project-facts.md`) must never name an outer layer — that is what keeps them
  swap- and test-able. **Check:** read the import statements of each inner-layer
  module; any import of a framework, transport (HTTP/router), ORM/DB client, or
  vendor SDK is a finding unless `project-facts.md` declares that module outer.
- **Data crosses a boundary in the inner shape.** An ORM row or framework request
  object dragged inward re-couples the core to a detail. **Check:** does a
  use-case/domain function accept or return a framework object (`req`, `res`, an
  ORM entity, a raw DB row) instead of a plain DTO or domain type? finding.
- **No cycles between layered modules.** A cycle means neither module can be read,
  tested, or released without the other. **Check:** trace imports (or read the
  dependency-cruiser report — do not re-report a cycle the gate already owns);
  name the cycle and the single edge to invert, usually via an inner-owned
  interface.
- **Actual graph matches the declared DAG.** **Check:** reconcile real import
  direction against the `project-facts.md` layer DAG; flag each violating edge as
  `<outer> → <inner>` with the layer contract it breaks.

## 2. Ports & adapters (hexagonal)

Weighting: strong for class-heavy TS; light for pipelines (see the one-adapter
caution); none for glue.

- **The core owns the port interface.** If the adapter's package defines the
  interface, the dependency still points outward. **Check:** locate each port
  interface's file — it must live in domain/application, not in the adapter/infra
  package. Interface defined beside its concrete adapter = finding.
- **Adapters are swappable.** A boundary that cannot swap real → in-memory is
  leaking. **Check:** can the use case be constructed with an in-memory fake port
  in a unit test without importing infra? if a test needs the real DB/HTTP to
  exercise business logic, the port is not a real seam — finding.
- **Construction happens only at the composition root.** Concretes newed up inside
  inner layers re-couple them to infra. **Check:** look for `new <ConcreteAdapter>(`
  or SDK-client construction inside domain/use-case files; wiring belongs only in
  `main`/container/factory. Inner code that constructs infra = finding (also DIP,
  §4).
- **One-adapter-forever ports are over-abstraction.** A port with exactly one
  implementation that will only ever have one buys indirection, not decoupling.
  **Check:** count implementations per port; exactly one, no test double, no
  planned second, on script-style code → P3 simplification candidate (inline it).
  Two implementations or a real test fake = a real seam, keep it. (Ties to the
  deletion test in `architecture-deepening.md`.)
- **Adapters do not call each other.** **Check:** an outbound adapter importing
  another outbound adapter, bypassing the use case, is a finding. The two legal
  flows: inbound, adapter → port → use-case; outbound, use-case → port, with the
  adapter implementing that port — never adapter → adapter directly.

## 3. Layer separation (entities / use-cases / interface adapters)

Weighting: strong for layered domains; light for pipelines; none for glue.

- **Entities hold enterprise rules and do zero I/O.** **Check:** does an entity or
  value-object method perform I/O (DB, HTTP, fs, logging) or import infra? finding
  — that behavior belongs in a use case or adapter.
- **Use cases orchestrate; they embed no transport or persistence detail.**
  **Check:** does a use case build SQL, parse HTTP, or read env/framework globals
  directly? finding — push it behind an outbound port.
- **Interface adapters translate only.** **Check:** does a controller/presenter
  make business decisions (pricing, domain-invariant validation, state
  transitions) rather than translate protocol ↔ use-case shapes? finding — move
  the decision inward.
- **Domain types and transport DTOs live apart.** Reusing one type for the wire
  and the domain couples business rules to the API/DB schema, so a schema change
  rewrites the rules. **Check:** is the same type used as an HTTP/DB payload AND as
  the domain model (e.g. a Prisma model passed into domain logic)? finding —
  introduce a domain type plus a DTO.
- **DTO ↔ domain mapping is at the boundary, once.** **Check:** is mapping
  scattered inside use cases/entities instead of centralized in the adapter?
  mapping leaking inward is a finding.

## 4. SOLID (distill, not dogma)

Weighting: strong for class-heavy TS; light-to-none for script-style code — a
violation is only a finding when it causes real coupling or change-pain on THIS
surface. On flat pipelines most "violations" are non-findings.

#### SRP — one reason to change (one actor)

- **Smell:** a module edited for unrelated reasons (persistence + presentation +
  business), an "and" in its description, a `util`/`manager` that grows forever.
- **Check:** list the distinct actors who could request a change to this module;
  more than one = finding.
- **When NOT:** a small cohesive script doing a linear job is one responsibility
  even across several steps.
- **Smallest remedy:** split along the actor seam; do not pre-split speculatively.

#### OCP — extend by adding, not editing

- **Smell:** an `if`/`switch` on a `type`/`kind` string that grows a branch per
  variant and is edited on every new one.
- **Check:** to add the next variant, must existing tested code be modified rather
  than a new unit added? finding when the variant set is open-ended.
- **When NOT:** a closed set of 2–3 cases — a switch is clearer than a strategy
  hierarchy; polymorphism there is over-abstraction.
- **Smallest remedy:** replace the conditional with a strategy/lookup only once
  variants actually vary independently.

#### LSP — subtypes honor the base contract

- **Smell:** a subtype that throws on a base method, narrows a return, strengthens
  a precondition, or callers that `instanceof`-check the subtype.
- **Check:** can every caller use the subtype through the base interface with no
  downcast and no surprise? a `throw "not supported"` override is a finding.
- **When NOT:** no inheritance/interface hierarchy present — the principle is
  inert.
- **Smallest remedy:** segregate the interface (ISP) or replace inheritance with
  composition.

#### ISP — no fat interfaces

- **Smell:** implementers with empty or `throw new Error("not implemented")`
  methods; a port clients only half-use.
- **Check:** does any implementer stub out methods it cannot support? that is the
  interface being too wide.
- **When NOT:** a small interface fully used by every implementer — leave it.
- **Smallest remedy:** break the wide interface into role interfaces; each client
  depends on the slice it uses.

#### DIP — depend on abstractions the inner layer owns

- **Smell:** business logic constructs a concrete infra class (`new StripeClient()`,
  `new PgPool()`) or imports an SDK directly.
- **Check:** read inner-layer files for concrete infra construction/imports; each
  is a finding (also §2 composition-root).
- **When NOT:** a leaf script with a single I/O call, no test and no second impl —
  a direct call is fine; a port is ceremony.
- **Smallest remedy:** define a port inward, inject the concrete at the composition
  root.

## 5. Value objects & domain primitives

Weighting: strong where domain invariants matter; light for scripts.

- **Wrap constrained primitives in types.** Passing `string`/`number` everywhere
  lets the compiler silently swap an email, an id, and a money amount, and
  scatters the same validation across call sites. **Check:** are domain concepts
  with invariants (money, ids, email, dates/ranges, quantities) threaded as raw
  primitives through many signatures with validation repeated at call sites?
  finding — introduce a value object / branded type that validates once at
  construction.
- **Value objects are immutable and compared by value.** **Check:** does a
  would-be value object expose setters or mutable fields, or get compared by
  reference where value equality is meant? finding.
- **Do not manufacture ceremony.** A one-field wrapper with no invariant, used in
  one local scope, is noise. **Check:** does the wrapper enforce an invariant or
  prevent a real mix-up? if not, it is a P3 over-abstraction, not a win.
- **Entities are compared by identity, not attributes.** **Check:** an entity (has
  a lifecycle id) compared by structural equality is a finding — compare by id.

## 6. DDD boundaries

Weighting: strong for multi-context domains; often none for a small
single-purpose repo — say so rather than inventing contexts.

- **Bounded contexts do not reach into each other's internals.** **Check:** does a
  module import another context's internal entities/tables directly instead of
  going through a published contract/port? cross-boundary reach-in = finding.
- **Ubiquitous language matches `project-facts.md`.** A term that drifts across a
  boundary (`user` vs `account` vs `customer` for the same thing) breeds
  mistranslation bugs. **Check:** compare domain identifiers against the domain
  terms in `project-facts.md`; drift across a boundary is a finding. (The baseline
  owns intra-module naming; this is the cross-boundary angle.)
- **Cross-boundary communication is an explicit contract, not shared mutable
  state.** **Check:** do two contexts share a mutable object/table both write,
  instead of exchanging DTOs/messages through a defined interface? shared mutable
  state across a boundary = finding.

## 7. Framework isolation

Weighting: strong for framework-heavy code; light/none otherwise.

- **Framework types and annotations stay at the edge.** A decorator or framework
  type on a domain class couples the core to the framework's lifecycle and
  version. **Check:** read domain/use-case files for framework imports, decorators
  (`@Injectable`, `@Entity`, `@Controller`), or framework base classes; any in the
  core is a finding — keep them in adapters.
- **The framework calls inward, never the reverse.** **Check:** does inner code
  import the framework (Express `Router`, a Nest module, an ORM base) rather than
  being called by an adapter that does? finding. (Cross-ref
  `core-code-guidelines.md` boundaries/inputs; this is the framework-coupling
  slice.)

## 8. Behavior-first tests at boundaries

Weighting: strong where ports exist; light for pipelines; none for glue.
Cross-ref: `core-code-guidelines.md` owns the generic behavior-vs-structure test
rule and the mock-mirrors-internals anti-pattern — this section is the
boundary-specific slice, do not restate the generic form.

- **Use cases are tested through the port with fakes.** **Check:** are use-case
  tests written against in-memory fake ports asserting business outcomes at the
  boundary? (Generic structure-coupled-test judgment is the baseline's rule —
  here check specifically that the fake stands at the PORT, not deeper.)
- **A port contract gets one shared contract test run against every adapter.**
  Each adapter must satisfy the same port behavior. **Check:** is there a
  per-adapter contract suite, or does each adapter get ad-hoc, divergent tests?
  absence on a multi-adapter port = finding.
- **Critical behavior is tested at the port, not only through a brittle E2E.**
  **Check:** is a core rule covered only by an end-to-end path that breaks on any
  wiring change? finding — pull the assertion down to the port boundary.

## Output expectations

Emit findings in the shape `review-output-format.md` defines. For each finding
record:

- **Location** — `file:line`, or the named area for a boundary/design finding
  with no single anchor line.
- **Triggering prompt** — which section/prompt above fired.
- **Conditionality tier applied** — strong / light / none, and one clause on why
  (the surface it landed on), so an over-applied rule is auditable.
- **Risk** — priority per the ladder: architectural leakage and layer-contract
  violations default to P2 (concrete coupling that will amplify change), P1 only
  when the violation causes a demonstrated live defect or makes the change
  unsafe to ship; P3 simplification / over-abstraction candidate.
- **Smallest behavior-preserving slice** — the one inversion, extracted port, or
  moved mapping that captures most of the benefit.

A boundary redesign that touches many call sites is emitted as a PLAN (per
`review-output-format.md`), never an inline rewrite. When the reviewed surface is
script-style or glue and this guide does not apply, say so explicitly rather than
manufacturing structure findings.
