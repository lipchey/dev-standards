# Architecture Deepening (review guide template)

Seed template. Sources (all MIT, verified):

- `mattpocock/skills` @ `391a2701` — improve-codebase-architecture,
  codebase-design, domain-modeling (ideas only: the published pages summarize the
  deep-module vocabulary, so this guide distills the concepts and copies no
  prose), layered over the same ideas from Ousterhout's *A Philosophy of Software
  Design*.
- `ramziddin/solid-skills` complexity.md @ `b113ce6` — the three complexity
  symptoms, essential vs accidental complexity, YAGNI, the Rule of Three (adapted
  excerpts).

Template-Version: 2 (guides-revamp 2026-07-11)

STARTING template: each adopting repo copies it into `.claude/review-guides/` and
then owns its final body. The prompts below are review-only JUDGMENT PROMPTS for a
human or reviewing agent — they say what to look for and how to weigh it, never an
instruction to edit. This guide is the module-depth long tail ABOVE the always-on
`core-code-guidelines.md` baseline and the layer/boundary rules in
`clean-architecture.md`; it cross-references both rather than restating them.

## Conditionality banner (read before applying)

Depth judgments are CONDITIONAL — they pay off in proportion to how many callers
and how many years a module must survive. Weight every prompt by the surface:

- **strong** — long-lived shared modules: code many callers depend on, a public
  interface, a library boundary, anything whose shallowness compounds over time.
- **light** — one-off scripts and short pipelines: a task runner does not need a
  "deep module"; flag only egregious pass-throughs and leakage.
- **none** — Bash / n8n glue: there is no real module surface to deepen; skip.

When unsure, prefer the smallest structural change that removes the most future
friction; never redesign a script slated for deletion next quarter. A prompt that
would push structure onto code that is fine as a flat function is a signal it does
not apply here — not a finding.

## Vocabulary (every prompt below is phrased in these terms)

- **Module** — a unit of code behind an interface (a function, class, file, or
  package). **Interface** — every fact a caller must know to use it: signatures
  *plus* invariants, ordering, error modes, and performance, not just the types.
- **Depth** — behavior hidden per unit of interface a caller must learn. **Deep** =
  much behavior, small interface; **shallow** = interface nearly as wide as the
  implementation. Depth is a property of the interface, not the implementation.
- **Leverage** — how much a caller (or a test) can do per unit of interface it has
  to learn.
- **Seam** — a place you can change behavior without editing there. One adapter is
  a hypothetical seam; two is a real one.
- **Locality** — how much of one behavior lives close together vs scattered.

## 1. Deep vs shallow modules

Weighting: strong for shared modules; light for scripts; none for glue.

- **Measure the ratio, do not eyeball it.** **Check:** for a suspect module, weigh
  what a caller must read to use it correctly (the full interface — signature plus
  invariants, ordering, and error modes) against what it hides. A numerator near
  the denominator confirms shallowness; a small numerator over a large denominator
  confirms depth.
- **Interface-to-implementation ratio.** A shallow module makes the caller learn
  almost as much as inlining would, for the cost of an extra hop. **Check:** is the
  public surface (params, return, and everything in the interface above) nearly as
  complex as the body? if a caller must understand the internals to call it
  correctly, it is shallow — finding.
- **Pass-through method / wrapper / param.** A method that only forwards to another
  with no added logic, a param threaded through untouched to a deeper call, a
  "manager" that only delegates — each adds a name but no abstraction. **Check:**
  does the method/param add behavior or only relay it? pure relay is a P3 candidate
  to inline or collapse.
- **Thin manager / anemic wrapper.** **Check:** does the class hold no invariant and
  only forward calls to its fields? merge it into its caller or callee.
- **Merge candidates.** **Check:** do two shallow modules, always used together,
  form one deeper module with a simpler combined interface? if the seam between
  them varies nothing, propose the merge (a PLAN if it moves call sites).
- **Classitis.** A proliferation of tiny modules/classes, each contributing
  little, costs more total interface to learn than a few deep ones — the caller
  pays per boundary crossed. **Check:** count the modules touched to accomplish
  one small task; if each does almost nothing and exists mainly to be "small",
  that is classitis — a deepen/merge candidate.
- **Different layer, same abstraction.** Adjacent layers should each hide a
  *different* kind of complexity; when two expose the same abstraction, one is
  redundant. **Check:** does this layer's interface look like the interface it
  calls (same-signature forwarding, a wrapper mirroring what it wraps)? if so it
  likely adds no depth — collapse it.

## 2. The deletion test

Weighting: strong for class-heavy TS; on script-style code a helper that reads
better inline is noise, not a finding.

- **Delete-and-inline thought experiment.** For each unit of structure, imagine
  deleting it and inlining its behavior into callers. **Check:** does complexity
  *vanish* (only a name was lost → shallow, P3 simplification) or *reappear* —
  duplicated across N callers, or a hidden invariant now leaks (→ it earns its
  place, leave it)?
- **One vs two adapters.** **Check:** a seam with exactly one implementation and no
  second in sight is a hypothetical seam — do not defend it as depth. Two
  implementations, or a real test fake, is a real seam worth keeping.
- **Deletion test on a whole layer.** **Check:** could an entire layer be deleted
  and its two neighbors talk directly, losing only forwarding? if yes, the layer
  is a pass-through tier — a high-leverage merge, emitted as a PLAN.

## 3. Information hiding & leakage

Weighting: strong for shared modules; light for scripts; none for glue.

- **A decision known to many modules is leaked.** Leakage means changing that
  decision edits every module that knows it. **Check:** does a single change (add a
  field, change a format, rename a status) force edits in N distant files? that
  fan-out is the leakage signal — name the decision that should have lived hidden
  in one module. (The symptom is change amplification, §7.)
- **Temporal decomposition smell.** Modules split by WHEN things run (read →
  process → write) instead of by what knowledge they hide tend to share one secret
  across all three. **Check:** are modules organized by execution phase, each
  touching the same data format/decision? re-cut them around the hidden knowledge,
  not the timeline.
- **Config sprawl.** **Check:** is one concern's configuration spread across many
  files / env vars / flags that must all change together? scattered config is
  leaked knowledge — consolidate it.
- **Implementation detail exposed publicly.** A public method/field callers do not
  need widens the interface and lets them couple to internals, freezing the
  implementation. **Check:** is a helper, intermediate state, or format detail
  exposed as public API when no external caller needs it? narrow it to private.
- **Hidden global input.** A value reached via a global/singleton deep inside a
  module hides where it comes from and breeds unknown-unknowns (§7). **Check:** is
  an input read from a global rather than passed at the boundary? make the
  dependency explicit at the interface.

## 4. Locality of behavior

Weighting: strong for shared modules; light for scripts; none for glue.

- **Behavior reads close together.** **Check:** to understand one feature, how many
  files must the reader open in sequence? high fan-out across distant files is a
  locality smell — co-locate.
- **Wiring/config lives near the code it governs.** **Check:** does configuration, a
  route registration, or a feature flag live far from the behavior it controls, so
  the reader cannot see cause and effect together? finding.
- **No splitting to satisfy a dogma the repo ignores.** **Check:** is related logic
  split only to honor a layering the rest of the repo does not follow? re-co-locate
  — consistency beats partial dogma.
- **Conjoined methods.** Two methods you must read together to understand either
  are a decomposition smell — the split added a boundary without added clarity.
  **Check:** can you understand method A without also reading method B, and vice
  versa? if not, they are conjoined — merge them or re-cut the seam so each stands
  alone.

## 5. Pull complexity downward / define errors out of existence

Weighting: strong for shared modules and public APIs; light for scripts.

- **Pull complexity down.** It is better for one module to absorb complexity than to
  push it onto every caller. **Check:** does an API make each caller handle the same
  edge case, set the same defaults, or perform the same follow-up step? that
  pushed-up complexity is a finding — absorb it behind the interface (a sensible
  default, internal handling).
- **Define errors out of existence.** An error the caller cannot act on, or a state
  that should not be representable, is best designed away rather than handled
  everywhere. **Check:** does the API throw/return an error every caller handles
  identically (or ignores), when the interface could make the case impossible or
  benign (e.g. deleting an absent key returns silently, a range clamps)? finding —
  redesign to remove the error class (PLAN). (Distinct from
  `core-code-guidelines.md` error-handling, which checks that raised errors ARE
  handled; this asks whether the error should exist at all.)
- **Special cases pushed to callers.** **Check:** is null/empty/boundary handling
  duplicated at every call site instead of handled once inside? pull it down.
- **Configuration overload.** An interface that forces the caller to assemble many
  options before it works has pushed complexity up. **Check:** does calling this
  require a large config/options object where sane defaults would do? push the
  defaults down; keep the required surface minimal.

## 6. Generic vs special-purpose; premature generality

Weighting: strong for shared modules; light for scripts.

- **Somewhat-general interface, but not built for hypotheticals.** An over-special
  interface leaks the current use case; an over-general one adds unused parameters
  and cognitive load. **Check:** does the interface carry parameters, options, or
  hooks no current caller uses ("for future extensibility")? that is premature
  generality — a finding; strip it to what is used. Conversely, is the interface so
  tied to one caller's specifics that a second caller cannot reuse it? note the
  special-purpose leak.
- **Rule of Three.** **Check:** was an abstraction extracted from a single use, or
  from duplication seen only twice? the wrong abstraction costs more than
  duplication — under three real uses, inlining may be the fix.

## 7. The three complexity symptoms (as review prompts)

Weighting: strong for shared modules; light for scripts; none for glue. These are
symptoms — trace each back to a cause in §3–§6.

| Symptom | What it looks like | Check |
|---|---|---|
| **Change amplification** | one conceptual change touches many files | estimate the files edited to add one field / change one format; a high count means a boundary is missing or a decision is leaked (§3) |
| **Cognitive load** | you must hold many things in mind to touch one thing | how many other modules must the reader understand to change this one safely? high = tight coupling, hidden dependencies, or unclear names |
| **Unknown-unknowns** | it is not obvious what must change or what a change will break | can a competent reader tell, from the interface alone, everything a change here could affect? surprising action-at-a-distance (global/hidden state, an implicit contract) is the worst symptom — name the hidden dependency |

## 8. Leverage ranking (highest-impact structural change first)

Weighting: applies whenever this guide produces more than one finding.

- **Rank by leverage.** Not all structural findings are worth the same. **Check:**
  which single change simplifies the most callers or unblocks the most future work?
  that is tackled first; churn that moves code without reducing total complexity
  ranks last, or is dropped.
- **Smallest slice per finding.** **Check:** name the smallest slice that captures
  most of the benefit; a redesign touching many call sites is a PLAN, not a slice.
- **Essential vs accidental complexity.** **Check:** is the complexity inherent to
  the domain (essential — leave it, express it clearly) or introduced by the
  solution (accidental — the target)? do not "simplify" essential complexity into
  hidden bugs.

## 9. Candidate strength (grade every deepening finding)

Weighting: applies to every finding this guide emits. Not all deepening findings
are equally certain — grade each so the reader can triage, and apply the one
filter that stops this guide from becoming generic cleanup advice.

- **The concentrate-vs-move filter.** **Check:** does the proposed deepening
  *concentrate* complexity behind a smaller interface, or merely *move it around*?
  only "concentrate" cases are findings; "moves it around" is not a finding at all.

| Grade | Meaning | Emit as |
|---|---|---|
| **Strong** | clear shallowness/leakage; the deepening obviously concentrates complexity behind a smaller interface | actionable finding |
| **Worth exploring** | plausible but depends on how the module evolves; current pain is real but modest | finding, flagged as a judgment call |
| **Speculative** | would only pay off under a future that may not arrive (YAGNI risk) | note it and move on — not a finding |

## Output expectations

Emit findings in the shape `review-output-format.md` defines. For each finding
record:

- **Location** — `file:line`, or the named module/area for a depth finding with no
  single anchor line.
- **Triggering prompt** — which section above fired (deletion test, leakage,
  locality, pull-down, generality, a complexity symptom, …).
- **Conditionality tier applied** — strong / light / none, and one clause on why,
  so a depth rule applied to a throwaway script is auditable.
- **Candidate strength** — Strong / Worth exploring per §9 (Speculative ones are
  not emitted as findings), so the reader can triage confidence separately from
  impact.
- **Leverage & risk** — callers affected or friction removed, and the priority per
  the ladder. Depth findings are usually P2 (maintainability) or P3
  (simplification); a leak that already causes a live bug can be P2/P1.
- **Smallest behavior-preserving slice** — the one merge, pulled-down default, or
  hidden decision that captures most of the benefit.

Rank findings by leverage, highest first. A redesign that touches many call sites
is emitted as a PLAN, never an inline rewrite. A clean surface is a first-class
outcome — if the modules are already deep, say so rather than inventing
shallowness where none exists.
