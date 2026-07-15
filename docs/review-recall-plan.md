# Review-recall plan — three tiers against review-owned entropy

- **Status:** Draft — pending owner approval (Gate P critique pending)
- **Date:** 2026-07-15
- **Owner ADRs:** ADR-017 (recall system; amends ADR-014, supersedes the
  ownership half of ADR-015) + ADR-018 (two-stage development doctrine)

## Evidence

2026-07-15, pilot consumer (`ai-prompter`), PR #25: `packages/engine` had just
been deep-reviewed at full-package scope (18 fixed slices, adversarially
verified, `verify --full` green). The owner's manual pass still left 20 review
comments: 16× inline magic values (src AND tests), 3× unclear identifiers
(`avgIdf`, a `.t` field, `pos`), 1× types-home violation (`src/types.ts` outside
`src/types/`). Every one of the 20 falls in a class that ADR-014/ADR-015
explicitly assigned to review judgment ("review-owned ceiling", "always-on
review judgments") — and the judgment layer demonstrably under-delivered on a
freshly reviewed package.

Root causes (verified against the run's transcript and configs):

1. **Attention dilution.** A review worker faces ~3,000 lines of guide text
   (7 package guides + overlays + consumer must-reads); per-rule recall
   collapses. No worker owns any specific rule class.
2. **Example-reporting, not saturation.** Finders report the instances they
   happened to notice; fixes close the cited lines. No contract says "rule R ×
   file F swept exhaustively", and nothing records which rule classes were
   checked against which files — gaps are invisible.
3. **Precision is verified, recall is not.** Adversarial verification filters
   false positives; no stage asks "what was NOT found".
4. **Review-owned ceilings have no real owner.** The constants-home gate stops
   at module-scope consts BY DESIGN and hands the rest to review (ADR-014,
   ADR-015) — but nothing makes the review actually run that specific check.

## Decision shape (ADR-017)

A rule class may stay review-owned ONLY if a machine gate is impossible or too
noisy — and then it must have a named profile owner (Tier 2) and, once it
escapes, a canary (Tier 3). Mechanical rule classes move down into gates.

## Tier 1 — raise the gate floor (eslint presets, mechanism-only per ADR-014)

Three additions to the shared presets. All follow the ADR-014 mechanism:
presets hard-code no paths, the consumer owns `files`/`ignores`/options.

**Shared plugin object (Gate P F1, reproduced):** two flat-config entries
defining DIFFERENT objects under `plugins["dev-standards"]` throw
`Cannot redefine plugin` on overlapping files — so C1 first extracts ONE
module-level plugin object (`eslint/plugin.js`) holding every custom rule;
every factory (including the existing `constantsHome`) references that same
object. A composition test enables all presets on one representative file.

1. **`inlineLiterals()` preset — wraps `@typescript-eslint/no-magic-numbers`**
   (Gate P F6: the installed dependency already ships the numeric rule with
   mature options — no custom AST work). The preset pins curated defaults:
   `ignore: [0, 1, -1]`, `ignoreArrayIndexes`, `ignoreEnums`,
   `ignoreNumericLiteralTypes`, `ignoreReadonlyClassProperties`,
   `ignoreTypeIndexes`; consumer may extend `ignore` and owns globs. v1 is
   numeric-only: inline strings are a huge false-positive class and the
   entire evidence set is numeric — strings stay profile-owned. Tests are IN
   scope (pilot convention: named consts at test file top). C1 acceptance
   verifies the rule fires on the 16 real pilot sites; any residual class
   (e.g. a site the upstream rule's variable-assignment allowance skips) is
   closed by extending the existing `constants-home` custom rule, not by a
   new rule. *(Verified at C1, Gate C 2026-07-15: every evidence-set class -
   comparisons, call args, arithmetic operands, test expected values - fires
   under the preset; the one residual numeric form is a function-local `const`
   bound to a bare literal, which is a NAMED value and deliberately stays
   profile-owned placement judgment, not a gate extension.)* Noisiest of the
   three — see Rollout below.
2. **`dev-standards/property-naming` (new rule, shared plugin).** The min-3
   floor for TS `interface`/type-literal property SIGNATURES only — class
   fields are ALREADY covered by the naming preset's `PropertyDefinition`
   selector (Gate P F7). A DISTINCT rule, not a naming-preset selector
   extension: it needs its own severity (warn-ramp independent of the
   existing `error` floor — one `no-restricted-syntax` entry has one
   severity) and file-scoped exemptions. Wire-format shapes are exempted by
   FILE (`ignores` globs on the wire-contract modules) or a narrow inline
   disable — never a repo-global key list, which would exempt internal
   same-named fields too and defeat the `.t` canary. Object-literal keys stay
   exempt (they mirror a type; gating the type suffices).
3. **`dev-standards/types-home` (new rule, shared plugin).** An EXPORTED
   `interface`/`type` alias declared outside the types home is an error;
   consumer owns globs/ignores. Export resolution is explicit (Gate P F8):
   fires on a top-level declaration exported directly OR referenced by a
   same-file `export { X }` / `export type { X }` / `export default X`;
   ambient declarations and `.d.ts` are excluded via ignores; re-exports of
   OTHER modules never fire. Option `allowNamePattern` is a validated STRING
   regex (seed `"Props$"`) for ADR-015's React-props carve-out. Non-exported
   local helper types never fire. Red/green test cases enumerate: direct
   export, indirect type-only export, default export, re-export, ambient,
   `.d.ts`, local helper, Props.

Each rule ships with `tests/eslint/<rule>.test.mjs` (mirroring
`constants-home.test.mjs`), is exported from `eslint/index.js`, documented in
`eslint/README.md`, and lands ACTIVE in
`eslint/consumer-template.eslint.config.js` + the consumer seeds in the same
batch (seed-parity rule).

**Rollout severity split:** the consumer TEMPLATE ships all three at `error`
(a new consumer starts clean). An EXISTING consumer adopts at `warn` and the
CALIBRATION session flips to `error` per the established report-only→blocking
discipline — `inline-literals` in particular never lands blocking on a legacy
codebase in one step.

**Gate-proof acceptance:** run against the retained pilot state
(`ai-prompter` engine @ PR #25 head), the three rules must flag 18 of the 20
owner comments (16 magic values, `.t`, `src/types.ts`). The remaining 2
(`avgIdf`, `pos`) are meaningfulness judgments — they become Tier-2 canaries,
see below.

## Tier 2 — the guide corpus is REWRITTEN into worker-ready profiles

**Owner decision (2026-07-15):** profiles are not pointer/routing files — the
seven guide templates are REORGANIZED into self-contained profile files, so a
fan-out worker receives ONE ready instruction file. The profile set REPLACES
the old guide set as the canonical corpus (one owner of fact — no
guide-vs-profile duplication); the old files are deleted in the same commit.

**New corpus, same directory** (`agents/review-guide-templates/` is kept —
the gate's suffix-match anchor and the vendor/** no-touch baseline reference
the dir name):

- `review-contract.md` — the worker contract shared by every lens: output
  format (absorbs `review-output-format.md`), evidence rules, the
  exhaustiveness contract (report EVERY instance, grouped repeats allowed; a
  `COVERAGE` list of every in-scope file actually read; explicit `CLEAN`
  claims), untrusted-checklist-data rule.
- Six self-contained lens profiles, each carrying its share of the old
  baseline (`core-code-guidelines.md`), the stack-router sections
  (`language-review-sources.md`) relevant to its lens, the area-guide content
  distributed by lens, per-section conditionality inherited from the old
  banners, and its canaries:
  - `profile-naming-and-constants.md` — name meaningfulness beyond the floor,
    constant placement/reuse beyond the gates, inline strings, comment
    quality. Canaries: `avgIdf`, `pos` (PR #25).
  - `profile-tests-quality.md` — oracle strength (would a mutant survive?),
    boundary coverage on inclusive/exclusive comparisons, fixture
    duplication, over-mocking, vacuous async. *(C2 outcome note, 2026-07-15:
    "vacuous async" here, "deep immutability" under types, and
    "stale-callback inertness" under correctness had NO normative source in
    the old corpus - the rewrite did not invent them mid-migration; all three
    are pending new-rule candidates in `inbox/review-promotions.md`.)*
  - `profile-types-and-contracts.md` — strict-typing depth, type
    reuse-before-add, deep immutability at boundaries (`Readonly` is
    shallow), exhaustiveness.
  - `profile-correctness-and-lifecycle.md` — error causes, resource-pair
    symmetry on every path, stale-callback inertness, boundary conditions,
    async races.
  - `profile-structure-and-dependencies.md` — boundaries, dependency
    direction, cohesion, cross-module duplication, dead code.
  - `profile-security.md` — the old `security-review.md` lens, keeping its
    own conditionality banner.

**Migration safety (the known failure mode).** A rewrite that moves/merges
facts across files is exactly the class that lost ~11 facts in the 2026-07-12
audit. Mitigations, all blocking: (a) a traceability table (old guide section
→ new profile section) committed with the rewrite as the migration proof —
every normative line of the old corpus mapped, no orphans; (b) the C2 Gate C
cross-check runs the doc-focused lens (lost facts vs base, new
contradictions, rule loopholes/over-reach) as a MANDATORY pass, not optional;
(c) old guides live on in git history only after both pass.

**Mechanics that must move with the corpus:**

- `deep-review/src/guides.ts` hardcodes the seven filenames — the const list
  changes to the new set, with its tests; the consumer inherits the new gate
  via the pin bump. **Full blast radius (Gate P F4, verified):** the corpus
  is cross-referenced by `agents/skill-catalog.json` (provenance ledger;
  INT-06 asserts set equality with the templates dir) and by
  `tests/runner/review-guides-present.test.ts`,
  `tests/deep-review/{guides-read,no-touch,preflight}.test.ts` — ALL are C2
  files; provenance entries are remapped (`feeds_guides` → new filenames),
  never dropped. C2 acceptance = the FULL repo suite (`npm test`, lint,
  typecheck, build), not just deep-review tests.
- **ADR-016 amendment (Gate P F2, explicit — not "untouched"):** the MAIN
  session's obligation is unchanged (reads contract + ALL profiles — same
  content, reorganized). What changes is the WORKER briefing rule in the
  skill body (today: "brief each delegated worker to read every mandated
  guide") — it becomes "brief each worker with `review-contract.md` + its
  assigned profile (+ same-named overlay)". v1 fan-out runs on EXTERNAL
  workers (separate runtimes the Stop/SubagentStop hook never sees — same
  category as the Codex cross-run); in-session Agent-tool fan-out under an
  attributed pass stays all-guides until a worker-scoped required set is
  designed (deferred, recorded in ADR-017).
- Overlay mechanism: same-named consumer overlays now extend profile files.
  Old-named overlays keep being READ by the main session (unmatched name =
  repo-only extra guide) but have no owning WORKER (Gate P F5) — so during
  the migration window the skill broadcasts unmatched legacy overlays to
  EVERY profile worker's brief; re-keying them is a named consumer-adoption
  step, after which the broadcast naturally becomes a no-op.
- Skill body (`agents/skill-sources/deep-review-refactor.md`): §Mandatory
  guide reads and §review-only step 4 re-reference the new corpus (read
  order: contract → baseline-bearing profiles per their conditionality);
  §Orchestration gains the profile fan-out — one worker per applicable
  profile (scope permitting), briefed with `review-contract.md` + its ONE
  profile file (+ same-named overlay); the main session merges per-profile
  findings with provenance, adversarially verifies (same doctrine as the
  Codex cross-run), and assembles a **coverage matrix** (in-scope files ×
  profiles) from the workers' COVERAGE sections — any hole is re-dispatched
  or recorded as an explicit gap (orchestrator-runtime, no CLI verb).
- The independent Codex cross-run stays as-is — it is the recall-diversity
  backstop, not replaced by profiles.

## Two-stage development doctrine (owner decision 2026-07-15 → ADR-018)

Prose restrictions at WRITE time are weakly followed and dilute attention —
so feature development becomes explicitly two-stage:

- **Stage 1 — write functional code.** Minimal PROSE pre-reads (the goal is
  working, tested code). Machine gates stay BLOCKING at their configured
  severity — a gate is mechanical feedback, not an attention tax, and with
  Tier 1 in place the mechanical standards (placement, constants, naming
  floor) are gate-owned, not prose-owned. Behavior tests remain a Stage-1
  duty (functional code includes its tests).
- **Stage 2 — deep-review-refactor as the standard quality stage.** The
  profile fan-out (Tier 2) applies the full standards corpus with targeted,
  per-lens attention; architecture/quality intent is given to the AI HERE,
  where recall is engineered, not at write time where it demonstrably decays.

**The decline loophole (Gate P F3):** if Stage 2 were optional, declined
reviews would leave Stage-1-reduced-standards code with no recovery — the
doctrine would LOWER quality. So ADR-018 states: in a two-stage repo, Stage 2
is a REQUIRED pipeline stage for feature work — consent governs WHEN it runs,
not WHETHER; a skipped/postponed Stage 2 leaves the feature explicitly marked
`stage-2 pending` (a tracked debt entry in the repo's status/memory doc), it
is never silently "done". Two always-on layers survive in Stage 1 regardless:
the machine gates and the Gate C cross-check (global rule, unchanged) — the
doctrine removes prose PRE-READS from writing, not review coverage.

Consequences in this batch: ADR-018 records the doctrine incl. the pending
debt rule; `agents/checklist-template.md` frames its split explicitly as
Stage-1 (blocks commit — gates) vs Stage-2 (review-owned — profiles); the
deep-review-refactor skill's trigger section names the two-stage flow as the
intended standing use (the consent gate itself is unchanged — ADR-012/016
posture stays). Consumer-side rewording of "read the full checklist before
code" pre-reads is adoption work (follow-up task, out of scope here).

## Tier 3 — recall ratchet (extend existing mechanisms, no new machinery)

1. **`agents/gate-misses-template.md` AND `docs/effectiveness-plan.md` (the
   canonical ledger definition — both, same batch, Gate P F9):** a new entry
   class `judgment-missed` and fix route `profile:<name>` for judgment
   escapes. **Canaries are BLINDED:** they live in the ds-side registry
   (`agents/review-guide-templates/TRACEABILITY.md`, which also carries the
   migration table), NEVER in the worker-facing profile body — a canary
   quoted in the brief would be parroted, not discovered. Closing a judgment
   escape = a replay over the retained offending state where the worker is
   NOT told the expected locations and still reports them.
2. **`docs/CALIBRATION.md`:** the session gains a judgment-escape step —
   triage escapes per profile, and on any profile-file edit spot-check its
   canaries still get caught (cheap: the orchestrator checks the registered
   canaries against the next BLINDED run's findings as its own acceptance
   criterion - canary identifiers and locations never enter a worker brief). The profiles README traceability table joins the session's
   listed inputs so a guide edit that orphans a section is caught there.
3. **Seeding:** the 20 PR-#25 comments become the first ledger entries on the
   consumer side (`ai-prompter/.claude/gate-misses.md`) during adoption — 18
   close via the Tier-1 gate-proof, 2 become P-naming canaries.

## Batching & division of labor

One branch (`feature/review-recall`), three commits, one PR, tag after merge:

- **C1 (Tier 1):** 3 rule changes + tests + template seeds + ADR-017.
  Implementation delegated to Codex (full spec in brief; ADR-014 mechanism and
  `constants-home.js`/`naming.js` as reference); orchestrator runs the tests
  and reviews the diff.
- **C2 (Tier 2):** the corpus rewrite (Codex drafts the seven→seven
  reorganization per the file plan above + the traceability table;
  orchestrator owns final wording and the lost-fact review) +
  `deep-review/src/guides.ts` const/test update + skill-body edits
  (orchestrator-owned — rule-bearing text). Doc-lens Gate C on this commit is
  mandatory before it is considered done.
- **C3 (Tier 3 + doctrine):** gate-misses-template + CALIBRATION edits +
  ADR-018 + checklist-template two-stage framing + skill trigger-section note
  (orchestrator; small).

Gate C (read-only Codex cross-check) runs on the full branch diff before the
PR; the doc-focused lens applies (lost facts, new contradictions, rule
loopholes) since C2/C3 are rule-bearing docs.

## Out of scope (recorded, not started)

- Consumer adoption in `ai-prompter`: pin bump, eslint config globs/options,
  report-only ramp, fixing the flagged engine violations (closes the PR #25
  comments), overlay re-keying to profile names, seeding the consumer
  gate-misses ledger. NOTE (Gate P F11): `scripts/seed-eslint-config.sh`
  copies the template only when ABSENT — existing consumers receive nothing
  automatically; the adoption task applies the config delta by hand.
  Separate follow-up task in the consumer repo.
- Corpus-loop findings from the engine review (10 needs-plan) — unrelated.
- CLI changes (`scripts/deep-review` verbs) — the coverage matrix is
  orchestrator-runtime in v1; a `coverage` verb is a future promotion if the
  matrix proves valuable.

## Considered and declined

Gate P proposed keeping the seven guides + a thin ownership map (no rewrite).
Declined by explicit owner decision (2026-07-15): a worker must receive ONE
self-contained instruction file; the pointer model keeps the ~3k-line read
problem. The rewrite risk is carried by the F4 blast-radius file list, the
traceability table, and the mandatory doc-lens Gate C.

## Acceptance (whole batch)

1. `npm run test:eslint` green (the runnable script — `node --test` on the
   bare dir fails), including negative cases per rule and the composition
   test; `npm test` + lint + typecheck + build green for the whole branch.
2. Gate-proof, DURABLE: minimal offense-shaped fixtures for all 18
   machine-catchable PR-#25 classes live in the rule tests permanently; the
   one-time run against the retained pilot state is documented in ADR-017.
3. Traceability: every normative line of the old 7-guide corpus mapped to a
   profile section (table committed with C2); doc-lens Gate C reports no lost
   facts and no new contradictions.
4. Skill body: profile fan-out + coverage matrix contract present; ADR-016
   mechanism intact (`deep-review` tests green after the guides.ts change).
5. Seed parity: consumer template + `templates/consumer/**` updated in C1.
6. ADR-017 recorded; ADR-014/015 cross-referenced (amend/supersede notes).
