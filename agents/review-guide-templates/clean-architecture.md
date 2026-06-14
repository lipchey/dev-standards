# Clean Architecture (review guide template)

Seed template. Adapted as short, paraphrased excerpts from `ramziddin/solid-skills`
(MIT) and the Clean/Hexagonal architecture community sources recorded in
`agents/skill-catalog.json`. STARTING template: each adopting repo copies it into
`.agents/review-guides/` and then owns its final body. The prompts below are
review-only JUDGMENT PROMPTS, never edit instructions.

## Conditionality banner (read before applying)

SOLID and class-design rules in this guide are CONDITIONAL by repo type. Do not
import them blindly - they overfit NestJS and other class-heavy code:

- STRONGLY: class-heavy TypeScript (DI containers, service classes, layered
  domain models). Here ports/adapters and dependency-direction rules pay off.
- LIGHTLY: script-style TS pipelines (a few functions transforming data
  top-to-bottom). Apply only the parts that cut real coupling; do not manufacture
  interfaces a single caller will ever use.
- NOT AT ALL: Bash/n8n glue. There are no classes, ports, or domain layers to
  judge; skip this guide entirely for that surface.

If a rule below would force structure onto code that is fine as plain functions
or a script, that is a signal the rule does not apply here - not a finding.

## Ports and adapters (hexagonal)

Judgment prompts (apply per the banner - strong for class-heavy TS):

- Does domain or business logic depend on a concrete I/O detail (a specific DB
  client, HTTP library, or SDK), or on an interface (port) it owns?
- Are adapters (DB, queue, external API) kept at the edges, with the core unaware
  of which adapter is wired in?
- Could you swap an adapter (e.g. real DB -> in-memory) for a test without
  touching domain code? If not, the boundary is leaking.
- Is there a port with exactly one adapter that will only ever have one? In
  script-style code that abstraction may be needless - weigh it down.

## Dependency direction

- Do dependencies point inward (outer layers depend on inner; inner never imports
  outer)? Flag any import that makes the domain reference a framework or transport
  detail.
- Are there cycles between modules that should be layered? Name the cycle and the
  edge that should be inverted.
- Does the repo's actual layer DAG (see `project-facts.md`) match the imports?
  Judge against the repo's declared layers, not a textbook diagram.

## DDD boundaries

- Are bounded contexts or domains separated, or does one module reach across a
  boundary into another's internals?
- Do domain terms in the code match the repo's ubiquitous language (the domain
  terms recorded in `project-facts.md`)? Naming drift across a boundary is a
  finding.
- Is shared state crossing a boundary that should instead communicate through an
  explicit contract?

## Behavior-first tests

- Do tests assert observable behavior (inputs -> outputs, effects at the
  boundary), or do they pin internal implementation details that break on any
  harmless refactor?
- Would the suite still pass after a pure, behavior-preserving refactor? Tests
  coupled to structure are themselves a finding.
- Is critical behavior tested at the port boundary rather than only through a
  brittle end-to-end path?

## Output expectations

Each finding records location, which prompt triggered it, the conditionality tier
you applied (strong / light / none) and why, the risk, and the smallest
behavior-preserving slice. Boundary redesigns are plans, not inline edits.
