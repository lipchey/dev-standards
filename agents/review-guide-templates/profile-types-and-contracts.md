# Types and Contracts Review Profile

You review ONLY through this lens: type safety at boundaries, contract
exhaustiveness, immutability promised by shared interfaces, type reuse and
placement, and domain values that encode real invariants. Do not turn runtime
lifecycle, general architecture, naming, tests, or security concerns into
findings from this profile.

Template-Version: 3 (review-recall 2026-07-15)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

This profile carries the relevant share of the repo-owned
`core-code-guidelines.md` baseline. Its language lenses remain paraphrased from
`awesome-skills/code-review-skill` (MIT, pinned `f2fd4e57`) plus repo
experience, as attributed in `language-review-sources.md`. Its architecture
prompts remain paraphrased from the MIT sources attributed in
`clean-architecture.md`: `ramziddin/solid-skills` @ `b113ce6`,
`wondelai/skills` clean-architecture @ `326b380`, and
`affaan-m/everything-claude-code` hexagonal-architecture @ `4092795`.
The language material comes from that source's per-language guides,
`code-quality-universal.md`, `common-bugs-checklist.md`, and cross-cutting
async/error notes. Shell, n8n, and Node lenses were written from universal
material plus repo experience because upstream has no dedicated lens for them.

## Conditionality

- Apply public-contract and strict-typing prompts strongly to long-lived shared
  modules, services, and framework boundaries. Weight them more lightly on
  one-off scripts while retaining correctness at their actual input/output
  edges.
- SOLID and layered type-boundary prompts are strong for class-heavy TypeScript,
  light for script-style pipelines, and none for Bash/n8n glue. Never invent an
  interface for a single caller just to satisfy a principle.
- Value-object prompts are strong where domain invariants matter and light for
  scripts. A one-field wrapper with no invariant in one local scope is ceremony.
- Type placement applies only where a types home is visible in the repo or
  declared in `.claude/code-conventions.md`.

## Public contracts and optional values

- Are public function contracts honored - types, nullability, documented
  pre/postconditions - or does a caller quietly rely on an undocumented shape?
- **Null / undefined flow.** Is an optional read behind a guard, and is
  `arr[i]` / `map.get(k)` treated as possibly absent? Indexed access is
  `T | undefined` under strict settings for a reason.
- Boundary validation against hostile input is owned by
  → see `profile-security.md` §Input validation at trust boundaries. Runtime
  failures caused by violated contracts are owned by
  → see `profile-correctness-and-lifecycle.md` §Correctness.

## Type placement and reuse

- Where a types home exists: do type and interface declarations live there
  rather than inline in a logic file? The one exception is a React component's
  own props interface, which stays beside the component.
- **Reuse before writing.** Does a new type duplicate one already in the repo
  (adjacent files, `shared/`, `utils/`)? Reinvented local definitions drift out
  of sync. Helper/util duplication is owned by
  → see `profile-structure-and-dependencies.md` §Cross-cutting structural
  checks; constant reuse is owned by
  → see `profile-naming-and-constants.md` §Constants placement and reuse.
- Constants placement is not a typing concern; see
  → see `profile-naming-and-constants.md` §Constants placement and reuse.

## Stack routing

Identify the surface by what the code actually is, one file or slice at a time,
not by extension alone. Pick the matching section below and apply its checks
with this profile's cross-cutting contract rules. If a file mixes stacks, route
each part separately. Record the loaded stack lens with every finding.
Adopting repos may add rows for their own stacks; every row points to exactly
one matching section.

| Surface under review | Load this section |
| --- | --- |
| TypeScript service / shared module (long-lived) | §TypeScript shared module / service |
| Script-style TS / one-off pipeline | §Script-style TS / one-off pipeline |
| React / UI (`.tsx`, hooks, components) | §React / UI TS |
| Node / backend TS | §Node / backend TS |
| Bash / shell glue | §Bash / shell glue |
| n8n / workflow JS glue | §n8n / workflow JS glue |
| Python script | §Python scripts |

### TypeScript shared module / service

Strict typing carries the weight here. Expect strict `tsconfig` settings
(`strict`, `noUncheckedIndexedAccess`), `unknown` plus narrowing at inputs,
concrete types within, discriminated unions for variant/result types with
exhaustive handling, `readonly` on shared data, and typed errors carrying a
`cause` chain.

- Does any exported function accept or return `any`? An `any` at a public
  boundary disables type-checking for every caller - require `unknown` plus a
  narrowing guard at the edge, concrete types within.
- Is every `switch`/`if` chain over a discriminated union exhaustive, with a
  `never`-typed default that fails to compile when a variant is added? A silent
  fallthrough ships an unhandled case.
- Is boundary data typed `unknown` and narrowed rather than asserted with `as`?
  A bare `as` cast is a claim the compiler believes without proof.
- Are shared or returned arrays/objects `readonly` where callers must not mutate
  them? A mutable return invites action-at-a-distance.
- Do thrown errors carry a typed shape and a `cause`, or is context lost by
  re-throwing a bare `Error(string)`?

Promise settlement, `Promise.all` semantics, and strict equality are owned by
→ see `profile-correctness-and-lifecycle.md` §TypeScript shared module / service.

### Script-style TS / one-off pipeline

The old stack lens adds no typing-specific rule beyond the cross-cutting public
contract and optional-value checks above. Use the lighter conditionality; do
not import service-level abstraction requirements into a one-off pipeline.

### React / UI TS

Component props interfaces may stay beside their component. The old React
stack lens otherwise owns runtime hook/effect behavior, not additional typing
prompts; see
→ see `profile-correctness-and-lifecycle.md` §React / UI TS.

### Node / backend TS

- Is required config/env validated once at startup (present, parsed, typed), so
  the process fails fast instead of hitting `undefined` mid-request?

Runtime startup/shutdown, streaming, and event handling are owned by
→ see `profile-correctness-and-lifecycle.md` §Node / backend TS.

### Bash / shell glue

No typing rule applies. Do not judge module depth, SOLID, or TypeScript type
idioms on shell glue.

### n8n / workflow JS glue

Expression node availability belongs to
→ see `profile-correctness-and-lifecycle.md` §n8n / workflow JS glue.
- Does a Code/Function node return items in `[{ json: ... }]` shape rather than
  relying on n8n's auto-wrapping of bare objects? Does its output cardinality
  match its MODE and intent - "Run Once for Each Item" preserving one output
  per input, "Run Once for All Items" aggregating/filtering deliberately with
  item linking kept for downstream mapping? An UNINTENDED collapse or drop is
  the bug, not a count change per se.

This section owns the output-shape/mode contract; replay, branch, and failure
lifecycle are owned by
→ see `profile-correctness-and-lifecycle.md` §n8n / workflow JS glue.

### Python scripts

- Are public functions type-annotated, so the script's public contracts are
  explicit?

Pinned dependency/venv reproducibility is owned by
→ see `profile-security.md` §Supply chain and dependencies.

## Layer-boundary data contracts

Weighting: strong for layered domains; light for pipelines; none for glue.

- **Domain types and transport DTOs live apart.** Reusing one type for the wire
  and the domain couples business rules to the API/DB schema, so a schema change
  rewrites the rules. **Check:** is the same type used as an HTTP/DB payload AND
  as the domain model (for example, a Prisma model passed into domain logic)?
  Finding - introduce a domain type plus a DTO.
- **DTO <-> domain mapping is at the boundary, once.** **Check:** is mapping
  scattered inside use cases/entities instead of centralized in the adapter?
  Mapping leaking inward is a finding.

The dependency-direction and layer ownership around these shapes are owned by
→ see `profile-structure-and-dependencies.md` §Layer separation.

## Substitutability and interface width

Weighting: strong for class-heavy TS; light-to-none for script-style code. A
violation is a finding only when it causes real coupling or change-pain on this
surface.

### LSP - subtypes honor the base contract

- **Smell:** a subtype that throws on a base method, narrows a return,
  strengthens a precondition, or callers that `instanceof`-check the subtype.
- **Check:** can every caller use the subtype through the base interface with no
  downcast and no surprise? A `throw "not supported"` override is a finding.
- **When NOT:** no inheritance/interface hierarchy present - the principle is
  inert.
- **Smallest remedy:** segregate the interface or replace inheritance with
  composition.

### ISP - no fat interfaces

- **Smell:** implementers with empty or `throw new Error("not implemented")`
  methods; a port clients only half-use.
- **Check:** does any implementer stub out methods it cannot support? That is the
  interface being too wide.
- **When NOT:** a small interface fully used by every implementer - leave it.
- **Smallest remedy:** break the wide interface into role interfaces; each
  client depends on the slice it uses.

The surrounding SRP, OCP, and DIP structure rules are owned by
→ see `profile-structure-and-dependencies.md` §SOLID.

## Value objects and domain primitives

Weighting: strong where domain invariants matter; light for scripts.

- **Wrap constrained primitives in types.** Passing `string`/`number`
  everywhere lets the compiler silently swap an email, an id, and a money
  amount, and scatters the same validation across call sites. **Check:** are
  domain concepts with invariants (money, ids, email, dates/ranges, quantities)
  threaded as raw primitives through many signatures with validation repeated
  at call sites? Finding - introduce a value object / branded type that
  validates once at construction.
- **Value objects are immutable and compared by value.** **Check:** does a
  would-be value object expose setters or mutable fields, or get compared by
  reference where value equality is meant? Finding.
- **Do not manufacture ceremony.** A one-field wrapper with no invariant, used
  in one local scope, is noise. **Check:** does the wrapper enforce an invariant
  or prevent a real mix-up? If not, it is a P3 over-abstraction, not a win.
- **Entities are compared by identity, not attributes.** **Check:** an entity
  with a lifecycle id compared by structural equality is a finding - compare by
  id.

The generic `Primitive obsession`, `Data clumps`, and `Refused bequest` smell
rows remain owned by
→ see `profile-structure-and-dependencies.md` §Code-smells taxonomy. Use this
section as the full rule when the issue is a contract or domain invariant; the
other profile carries only the structural smell classification.

## Output

Follow `review-contract.md` exactly. Name the boundary or contract whose type
guarantee fails, the value that escapes it, and the smallest type-safe fix.
Report every applicable instance and include the required per-file
`COVERAGE`/`CLEAN` claims. A clean type surface is a first-class outcome.
