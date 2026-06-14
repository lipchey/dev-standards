# Architecture Deepening (review guide template)

Seed template. Adapted as short, paraphrased excerpts from the
`mattpocock/skills` -> `improve-codebase-architecture` source recorded in
`agents/skill-catalog.json`. This is a STARTING template: each adopting repo
copies it into `.agents/review-guides/` and then owns its final body. The
prompts below are review-only JUDGMENT PROMPTS for a human or reviewing agent -
they say what to look for and how to weigh it, never an instruction to edit.

## How to apply this guide (conditional by repo type)

These prompts are conditional, not absolute rules. Weight them by what the repo
actually is:

- Strongest for long-lived TypeScript services and shared modules - code many
  callers depend on, where a shallow interface compounds in cost over time.
- Light for one-off scripts and script-style glue: a short task runner does not
  need a "deep module"; flag only egregious cases.
- Skip structural-depth judgments for Bash/n8n glue - there is no real module
  surface to deepen there.

When unsure, prefer the smallest structural change that removes the most future
friction; do not redesign a script that will be deleted next quarter.

## Shallow modules vs deep modules

A module is deep when it hides substantial implementation behind a small, stable
interface; it is shallow when its interface is nearly as large as its
implementation (pass-through wrappers, thin managers that only forward calls).

Judgment prompts:

- Does this module's public surface buy the caller real abstraction, or must the
  caller still understand the internals to use it?
- Is this a pass-through layer that adds a name but no behavior? Pass-through
  indirection is a cost, not an abstraction.
- Could two shallow modules be merged into one deeper module with a simpler
  combined interface?

## The deletion test

For each unit of structure, ask: if it were deleted and its callers had to
inline the behavior, would anything important be lost?

- If deletion loses nothing but a layer of naming, the structure is likely
  shallow - record it as a P3 simplification candidate.
- If deletion forces real duplication or leaks a hidden invariant, the module is
  earning its place; leave it.
- Apply this conditionally: in class-heavy TS a deletable interface is a finding;
  in script-style code a small helper that reads better inline is noise, not a
  finding.

## Locality of behavior

Prefer code where the behavior you need to understand lives close together, over
behavior scattered across many files that must be read in sequence.

Judgment prompts:

- To understand one feature, how many files must the reader open? High fan-out
  across distant files is a locality smell.
- Is related logic co-located, or split only to satisfy a layering dogma this
  repo does not otherwise follow?
- Does wiring or configuration live far from the code it governs in a way that
  hides intent?

## Leverage (high-impact structural change first)

Not all structural findings are worth the same. Rank by leverage: the change
that removes the most downstream friction per unit of risk comes first.

Judgment prompts:

- Which single structural change would simplify the largest number of callers or
  unblock the most future work?
- Is a proposed refactor high-leverage, or is it churn that moves code without
  reducing total complexity?
- For each finding, name the smallest slice that captures most of the benefit; a
  redesign touching many call sites is a PLAN, not a slice.

## Output expectations

For each finding record: location, which prompt above triggered it, the
estimated leverage (callers affected or friction removed), the risk of changing
it, and the smallest behavior-preserving slice. Architectural redesigns are
emitted as plans, never as inline edits in a review pass.
