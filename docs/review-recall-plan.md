# Review-recall plan — three tiers against review-owned entropy

- **Status:** Draft — pending owner approval (Gate P critique pending)
- **Date:** 2026-07-15
- **Owner ADR:** ADR-017 (to be written in this batch; amends ADR-014, supersedes
  the ownership half of ADR-015)

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

Three additions to the shared inline plugin / presets. All follow the ADR-014
mechanism: custom rules in the `dev-standards` inline plugin (never shared
`no-restricted-syntax` entries — flat-config REPLACE semantics), presets
hard-code no paths, the consumer owns `files`/`ignores`/options.

1. **`dev-standards/inline-literals` (new rule).** Flags NUMERIC literals in
   LOGIC positions that `constants-home` deliberately skipped: literals in
   expressions/comparisons/call arguments/returns, function-local const
   literal inits, and literal-only arithmetic. v1 is numeric-only: string
   literals in logic (error messages, log labels, wire keys) are a huge
   false-positive class and the entire evidence set is numeric — inline
   strings stay profile-owned (P-naming). Default allowlist
   (option-overridable): `0`, `1`, `-1`, array-index positions; consumer
   option for extra allowed numbers. Tests are IN scope (the consumer decides
   via globs; the pilot's convention already requires named consts at test
   file top). This is the noisiest rule of the three — see Rollout below.
2. **`naming` preset extension: property floor.** The min-3/ASCII floor gains
   TS `interface`/type-literal property SIGNATURES and class field
   declarations (author-owned domain shapes). Object-literal keys stay exempt
   (they mirror a type; gating the type suffices). New `exemptPropertyKeys`
   option (mirror of `exemptNamedImports`) for wire-format/external keys —
   renaming a wire key is a data-format decision, not a lint fix.
3. **`dev-standards/types-home` (new rule).** An EXPORTED `interface`/`type`
   declared outside the types home is an error; mirror of `constants-home`
   (consumer owns globs/ignores). Option `allowNamePattern` (seed:
   `/Props$/`) keeps ADR-015's React-props carve-out. Non-exported local
   helper types never fire.

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
    duplication, over-mocking, vacuous async.
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
  via the pin bump. ADR-016's mechanism (main session reads EVERY mandated
  file) is otherwise untouched — the main session now reads the contract +
  all profiles (same content, reorganized); profiles narrow only what each
  WORKER reads.
- Overlay mechanism: same-named consumer overlays now extend profile files.
  Old-named overlays degrade gracefully (an unmatched overlay name is already
  defined as a repo-only extra guide — still read); re-keying them is part of
  consumer adoption.
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

## Tier 3 — recall ratchet (extend existing mechanisms, no new machinery)

1. **`agents/gate-misses-template.md`:** fix routes gain `profile:<name>` for
   judgment escapes; closing a judgment escape REQUIRES adding the escaped
   case as a canary line to the owning profile file (the nondeterministic
   analogue of "gate now red on the retained offense").
2. **`docs/CALIBRATION.md`:** the session gains a judgment-escape step —
   triage escapes per profile, and on any profile-file edit spot-check its
   canaries still get caught (cheap: include canaries in the next run's brief
   acceptance). The profiles README traceability table joins the session's
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
- **C3 (Tier 3):** gate-misses-template + CALIBRATION edits (orchestrator;
  small).

Gate C (read-only Codex cross-check) runs on the full branch diff before the
PR; the doc-focused lens applies (lost facts, new contradictions, rule
loopholes) since C2/C3 are rule-bearing docs.

## Out of scope (recorded, not started)

- Consumer adoption in `ai-prompter`: pin bump, eslint config globs/options,
  report-only ramp, fixing the flagged engine violations (closes the PR #25
  comments), seeding the consumer gate-misses ledger. Separate follow-up task
  in the consumer repo.
- Corpus-loop findings from the engine review (10 needs-plan) — unrelated.
- CLI changes (`scripts/deep-review` verbs) — the coverage matrix is
  orchestrator-runtime in v1; a `coverage` verb is a future promotion if the
  matrix proves valuable.

## Acceptance (whole batch)

1. `node --test tests/eslint/` green, including negative cases per rule.
2. Gate-proof: the three Tier-1 rules flag the 18 machine-catchable PR-#25
   sites when run against the retained pilot state (documented in the ADR).
3. Traceability: every normative line of the old 7-guide corpus mapped to a
   profile section (table committed with C2); doc-lens Gate C reports no lost
   facts and no new contradictions.
4. Skill body: profile fan-out + coverage matrix contract present; ADR-016
   mechanism intact (`deep-review` tests green after the guides.ts change).
5. Seed parity: consumer template + `templates/consumer/**` updated in C1.
6. ADR-017 recorded; ADR-014/015 cross-referenced (amend/supersede notes).
