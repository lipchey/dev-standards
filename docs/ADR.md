# Architecture Decision Records

The canonical ADR log. Referencing a new `ADR-0NN` id from code, a skill body, or
a plan requires a matching entry here (CLAUDE.md ADR discipline).

**ADR-001..012 predate this file** (the "create on first entry" debt from CLAUDE.md).
They were never collected into a single log; they lived only as references in code and
skill bodies. Backfilled below (Phase 6, 2026-07-15) as concise records — the facts of
the decisions, not the full Context/Consequences template used for ADR-013 onward — so
the log **covers every id referenced by current code** (ADR-003/007/008/010/011/012).

Numbering gaps: ADR-002/004/005 were never assigned; ADR-001 was never formalized as a
standalone record. **ADR-006** (workflow state enum + frozen transition/seat table) and
**ADR-009** (workflow locked transactions + auto-advance) were workflow-internal
decisions retired with the `workflow/` removal (2026-07-10) and are not referenced by
current code, so they get no standalone entry here.

---

## ADR-003 — One canonical source per guide/skill body, loaded by explicit brief

- **Status:** Accepted (backfilled 2026-07-15)

### Decision

Review guides and skill bodies each have a **single canonical source in the package**
(`agents/review-guide-templates/` for guides, `agents/skill-sources/` for skills),
consumed by **explicit brief — never auto-discovered**. A consumer's same-named
`.claude/review-guides/` overlay may only *additively* extend a guide, never override or
delete a canonical rule. (Wrapper mechanics for skill bodies: ADR-010.)

---

## ADR-007 — `deep_review` is an optional, standalone top-level config block

- **Status:** Accepted (backfilled 2026-07-15)

### Decision

The deep-review engine is configured by an optional top-level `deep_review` block in
`quality.json`, with its own engine types (`deep-review/src/types.ts`). Present-but-
disabled (`{ "enabled": false }`) or absent is valid; the hand-validator treats the
block as optional (`runner/src/validate.ts`).

---

## ADR-008 — Autonomous, write-capable Codex "reviewer seat" — RETIRED

- **Status:** Retired (2026-07-10, workflow removal)

### Decision (retired)

The workflow subsystem gave Codex an autonomous, write-capable "reviewer seat" — a
second-model agent that reviewed, committed trailers, and drove the feature state
machine on its own. **Retired with the entire `workflow/` subsystem:** it is the opposite
trust model from how these standards are used — Codex is a read-only advisor; a
human/Claude producer verifies and commits (the Cross-Check Gates). No current code
references it.

---

## ADR-010 — Skill wrappers are static pointers, never a generated/duplicated body

- **Status:** Accepted (backfilled 2026-07-15)

### Decision

The per-consumer skill wrappers (`.claude/skills/**/SKILL.md`) are **thin static
pointers** at the canonical body (single source per ADR-003), never a generated or
duplicated copy. The wrapper generator was retired in Phase 2 (2026-07-10); a static
contract test (`tests/runner/skill-wrappers-static.test.ts`) guards wrapper↔body drift.
Project specificity goes through the three legal tuning surfaces (`quality.json`, additive
review-guide overlays, `project-facts.md` — see `docs/ADOPTION.md`), never a forked skill body.

---

## ADR-011 — Automatic cross-model review-chain gating (workflow) — RETIRED

- **Status:** Retired (2026-07-10, workflow removal)

### Decision (retired)

The removed workflow subsystem could run an **automatic cross-model review-chain** and
skip it when the owner explicitly disabled it for a session. Retired with `workflow/`.
Recorded here as *"automatic review-chain gating"* — deliberately **not** the bare name
"review-chain" — to end the naming collision with the downstream `codex-chain` Gate-C
skill (resolves the BACKLOG "Related core-backlog" item).

---

## ADR-012 — Landing happens via a standalone handoff; no local merge verb

- **Status:** Accepted (backfilled 2026-07-15; workflow-era implementation retired)

### Decision

There is no local "merge" verb — completed work lands via a **standalone handoff
instruction that a human owns**: deep-review "leaves nothing landed and mutates nothing …
a human drives the PR review and landing" and MUST NEVER suggest an automated landing
(`deep-review/src/handoff.ts`). The workflow-era schema block and its *autonomous* PR
implementation were removed with the `workflow/` subsystem (2026-07-10, Phase R — not the
Phase 2 wrapper-generator removal), but the decision survives and is now embodied by
deep-review (`handoff.ts`, `cli.ts`, `verify.ts`, `worktree.ts`): the engine emits a
landing instruction and never merges. (The roadmap's "ADR-012 retired" shorthand is
imprecise — the workflow *implementation* was retired; the *decision* is active.)

---

## ADR-013 — The deep-review fix loop is verified under the standard that judges the merge

- **Status:** Accepted
- **Date:** 2026-07-14

### Context

ai-prompter deep-review PR #18 post-mortem. The `review-and-refactor` fix phase
verified at `--fast` while the merge was judged by `--full` CI, so every full-only
gate (e.g. the `comments` gate) was invisible to the fix loop: CI failed twice on
gates that were never run locally. The fix was thus born under a lighter regime than
the one it is judged under. A related isolation gap: a run worktree that reuses the
main checkout's `dist/` verifies against a build that concurrent work can rebuild or
mutate mid-run.

### Decision

1. **Full-tier default.** The fix-phase verify default flips `--fast` → `--full` —
   the tier that judges the merge. Set in `deep-review/src/cli.ts` (verify scope
   fallback) and `templates/consumer/quality.starter.json`
   (`deep_review.verify_after_fix`); the config key still overrides per repo.
2. **Copy, not symlink, the worktree dist** (`deep-review/src/worktree.ts`,
   `setupWorktreeTooling`). The run worktree receives its own copied `dist/`,
   not a symlink into the main checkout, so the fix phase verifies against a frozen
   build isolated from concurrent rebuilds.
3. **Same-lens fix-diff review** (skill body `deep-review-refactor.md`): before
   `verify`, the produced diff is self-reviewed against the same merged guide lens
   (diffed against the descriptor's `initial_head_sha`), architecture/placement/
   conventions included; any Codex Gate-C prompt over a fix diff carries that lens,
   never behavior-only; and finding→slice translation must cite a rule-compliant
   destination validated against `code-conventions.md`. A standing violation routes
   the refactor to `needs-human` (the same fail-closed exit as a red verify) — the
   engine has no verb to reopen a bound finding.

**Amendment — 2026-07-15.** The same-lens fix-diff verdict is persisted as a
HEAD-bound `self_review` record. Handoff readiness requires a clean verdict bound
to the current HEAD; an absent, non-clean, or stale verdict fails closed before a
landing instruction is emitted.

### Consequences

- The fix loop can no longer green locally on a standard the merge will later fail.
- `--full` is slower per run; repos that deliberately want the lighter local tier set
  `deep_review.verify_after_fix: "--fast"` explicitly.
- The placement/conventions lens now applies to the produced diff, not just the
  find phase, closing the gap where a fix diff got a weaker review than the findings.

---

## ADR-014 — Review-only placement rules become machine gates; naming standards must be operational

- **Status:** Accepted
- **Date:** 2026-07-14

### Context

Two review-only rules proved unenforceable in the pilot. A "value constants never
inline in logic files → workspace constants home" rule was review-only, so an inline
`const MAX_FRAME_GAP_MS = 500;` in a logic file passed every gate green. Separately, a
"meaningful names" prose rule was enforced only as a ≥3-char length proxy — its
aspirational half ungated and contradicted by ~250 accepted abbreviated identifiers,
making reviewer enforcement arbitrary.

### Decision

1. **`constantsHome` ESLint preset** (`eslint/constants-home.js`) turns the
   constants-home rule into a gate: a custom rule in an inline plugin flags
   module-scope `const` bound to a bare primitive literal (number/string/boolean,
   unary-signed numeric, expressionless template, and the same in a TS `as const`).
   It ships a custom rule, **not** a `no-restricted-syntax` config, because flat
   config REPLACES (never merges) same-rule options and the pilot already uses
   `no-restricted-syntax` for its naming gate — a shared entry would silently erase
   one gate or the other. The preset hard-codes no paths; the consumer owns the
   `files`/`ignores` globs. Function-local literals and literal-only arithmetic
   (`45 * 60 * 1000`) stay review-owned ceilings.
2. **Operational naming standard** (`agents/code-conventions-template.md`): the
   template now requires the naming rule to be operational — either an explicit
   blessed-abbreviation allowlist (new abbreviation added in the same PR) or an
   explicit "abbreviations are fine" stance — never a bare "descriptive names" rule
   backed only by a length gate.

### Consequences

- The constants-home miss is now a deterministic lint error, with a durable
  regression test (`tests/eslint/constants-home.test.mjs`).
- Naming enforcement stops being reviewer-dependent once a consumer fills the
  template with a concrete allowlist or stance.
- The gate mechanism is shared; the rule configuration (which globs, which
  abbreviations) stays consumer-side, per the core/consumer split.

### Amendment (2026-07-15, seed parity)

The pilot's identifier floor is promoted to the shared **`naming` preset**
(`eslint/naming.js`): `no-restricted-syntax` min-3-chars over every
author-chosen name (variables, functions, classes, params incl.
defaults/rest/catch and TS parameter-properties, destructured bindings, class
members incl. `#private`, and ALL import locals including aliases) plus
`id-match` ASCII-only; `_` discard and object/type PROPERTY keys exempt. The
selector strings are the pilot contract verbatim — changing them is a standards
decision recorded here, never silent drift. Because the preset owns
`no-restricted-syntax` within its scope (flat-config replace semantics),
consumer-specific selectors ride `extraRestrictedSyntax` and short
framework-canonical externals ride `exemptNamedImports` (seed: vitest's `vi`).
Both new-standard presets (`naming`, `constantsHome`) ship ACTIVE in
`eslint/consumer-template.eslint.config.js`, and the starter
`deep_review.budget.seconds` is 1800 so the ADR-013 `--full` default fits the
run deadline — per the CLAUDE.md seed-parity rule: a consumer-facing standard
lands in the seeds in the same batch, the pilot is an adopter, not the source
of truth.

---

## ADR-015 — Constant/type placement become always-on review judgments

- **Status:** Accepted
- **Date:** 2026-07-15

### Context

ADR-014 gated one narrow constant case — a module-scope `const` bound to a bare
primitive literal, in the files the `constantsHome` preset lints — and left
everything else (literals in expressions and call arguments, function-local
literals, literal-only arithmetic, and constant reuse) to review, but no guide
wrote that down. Type/interface PLACEMENT had no baseline prompt either. Type
reuse-before-add already existed as a cross-cutting check in the router
(`language-review-sources.md`); specific home paths lived only in the per-repo
`code-conventions.md` template.

### Decision

The always-on baseline (`core-code-guidelines.md`) gains two placement prompts,
each conditional on the repo actually keeping the home it names (a repo without
that home is out of scope for the bullet): a non-obvious inline scalar belongs in
the constants home and an existing constant is reused; a type/interface belongs
in the types home, with a React component's own props interface the standing
exception. These are review JUDGMENTS layered on ADR-014's gate, not a second
gate — ADR-014 stays authoritative for gate scope, and exact home paths plus
format-owned literal exceptions stay consumer-owned in
`.claude/code-conventions.md`. Strict-typing depth and type reuse stay the
TypeScript lens's job in `language-review-sources.md`; the baseline does not
repeat them. The seeded `code-conventions-template.md` names the types home and
the props exception so a new consumer inherits both.

### Consequences

- What the `constantsHome` gate cannot see is a written review prompt instead of
  tribal knowledge, and does not re-report the gated case.
- Type placement gets a review lens with no new gate; the props carve-out keeps
  it from firing on component-local props.
- No guide seed sync (the seven guides are read in place from the package); the
  `code-conventions-template.md` change is the seed parity, same batch.

---

## ADR-016 — Mandated review guides are enforced by a transcript-reading hard gate

- **Status:** Accepted
- **Date:** 2026-07-15

### Context

The `deep-review-refactor` skill instructs the reviewer to read the seven package
guide templates (plus repo overlays and project must-read docs) before judging. In
practice an AI reviewer periodically SKIPS them — judging the code "clean enough" and
substituting memory for the source — and every gate still passes green, because
"did the reviewer read the guides" was never machine-checked. The instruction was
advisory; nothing blocked a pass that ignored it. This must hold for a review the
main session delegates to subagents too.

### Decision

A model-independent hard gate, shipped in dev-standards so every consumer inherits it.

1. **Read-proof from the transcript, not self-report.** A new `deep-review
   guides-read` verb (`deep-review/src/{transcript,guides-read}.ts`) parses the
   session's JSONL transcript. Read-proof for a file = a genuine `Read` tool_use
   whose correlated `tool_result` did not error and was not user-denied. A Bash
   echo, a failed/denied read, or a read that never completed is NOT proof.
   Activation is the harness-set `attributionSkill == deep-review-refactor` on the
   transcript (the harness stamps it, not the model).
2. **Required set, strict and fail-closed.** = the seven package templates (a
   missing/blank template fails closed) ∪ every `*.md` in `deep_review.guides_dir`
   (a listed-but-unreadable overlay fails closed; ENOENT = no overlay is fine) ∪
   every `deep_review.required_reads` entry (a configured read that does not exist
   fails closed). Paths are matched by repo-relative TAIL so a worktree root and the
   main checkout satisfy the same guide. [SUPERSEDED 2026-07-16, see Amendment
   below: the required-READ set is now the ANCHOR only — `review-contract.md` + its
   overlay + `required_reads`; the profile bodies are profile-route reads. Package
   availability (all nine templates) and overlay availability stay fail-closed.]
3. **Wired as `Stop` + `SubagentStop` hooks** calling `scripts/deep-review
   guides-read --hook-stdin`. The hook blocks (`{"decision":"block","reason":…}`)
   until every required file is proven read. STRICT main-session rule: the main
   transcript must show the reads even when the review was delegated to subagents,
   so delegation cannot launder the requirement.
4. **The engine protects its own policy + mechanism.** `NO_TOUCH_BASELINE` gains
   `.claude/settings.json`, `.claude/hooks/**`, `scripts/deep-review` (the
   mechanism); the fix-mode no-touch set unions `required_reads` + the `guides_dir`
   overlay (the policy). A fix slice can neither disarm the gate nor edit a guide it
   was reviewed against.
5. **Escape hatch.** The hook honors `DEEP_REVIEW_GUARD_OFF=1` (exit 0
   immediately), so a gate bug can never brick a consumer's Claude sessions;
   ADOPTION documents the out-of-band removal.

### Consequences

- **The guarantee is "hard up to the platform cap-8," not absolute.** Claude Code
  force-continues after 8 consecutive Stop-blocks. So a determined skip becomes LOUD
  (8 recorded `preventedContinuation`) rather than impossible; the realistic
  accidental skip is caught on the first block with the unread files named. This
  ceiling is the platform's and is stated honestly rather than papered over.
- **Fix-verb attestation was deliberately NOT built.** Making the fix verbs
  (`report`/`handoff`/`commit-slice`) fail-closed on read-proof would need the engine
  to locate the session transcript from inside a fix verb — impossible robustly:
  `CLAUDE_PROJECT_DIR` is absent from the Bash tool environment (only a hook-config
  placeholder), the cwd at fix time is an engine worktree, and the transcript's
  on-disk hash is keyed to the launch dir. Any resolver would be brittle and could
  brick review-and-refactor on a hash-format change — a fragile security mechanism is
  a net negative. `handoff` lands nothing and `report` is metadata-only, so nothing
  auto-lands; the robust `Stop`/`SubagentStop` gate covers conclusion. Revisit only
  if the harness exposes the transcript path to tool invocations.
- **The activation MARKER is designed but not wired in v1.** The gate supports a
  `.artifacts/deep-review/active-<session_id>` marker for deterministic fail-closed
  activation, but no `PreToolUse[Skill]` hook writes it — that PreToolUse fires for
  the `Skill` tool is unconfirmed, and shipping unconfirmed config is a liability.
  Without it, activation depends on the harness attribution being present in a
  readable, sufficiently-FLUSHED transcript: two edges fail open (skip) — an
  unreadable transcript, and a transcript whose attribution line has not yet flushed
  at Stop time (the harness writes it asynchronously). Both are unlikely for a real
  review — the attribution is stamped on every assistant line, so it is present long
  before conclusion — but they are honest gaps the marker would close. A pilot will
  confirm whether the marker is worth wiring.
- Adoption seeds the hooks by structured MERGE into `.claude/settings.json`
  (`scripts/merge-deep-review-hooks.mjs`, never copy-if-absent — a consumer's
  existing settings must survive) and sets `required_reads` in the starter manifest.
  `seed-consumer.sh --check` fails if the hooks are not wired.

### Amendment 2026-07-16 — the main-session read set shrinks to the ANCHOR (owner decision)

Once the profile fan-out became MANDATORY (ADR-018 amendment, same date), forcing
the main session to ALSO Read all eight profile lens bodies on EVERY run was pure
context bloat: the routes carry the profiles; the main session only orchestrates,
merges, and renders verdicts. So the required-read set on the MAIN transcript is
rescoped to the ANCHOR — `review-contract.md` (the corpus contract) + its overlay
if present + the `deep_review.required_reads` project docs. The eight `profile-*`
bodies and their overlays become profile-route reads (each fan-out worker reads its
assigned profile; a main-hosted route or a fix-mode self-review reads the profiles
that role needs), no longer gated on the main transcript.

Precise tradeoff (what actually changes):

- **Package availability stays fail-closed.** `loadReviewGuides` still loads all
  nine templates (a missing/blank one fails preflight), and a LISTED overlay that
  is unreadable now fails closed IN the loader (`guides.ts`) — the single point
  covering both the gate and fix-mode preflight, since the rescope removed the
  gate's separate per-overlay read requirement that used to catch it.
- **Removed:** machine proof that the MAIN session Read each profile BODY. ADR-016
  only ever proved successful main-session READS, never that a profile was APPLIED
  to any file — profile application was ALWAYS convention (the fan-out). This
  removes a read-proof, not an application guarantee.
- **The application guarantee** (each profile applied to saturation) rests on the
  mandatory fan-out's tracked-todo countermeasure + the REQUIRED coverage matrix,
  and stays convention until the deferred worker-scoped gate (ADR-018) lands.

Engine: `guides-read.ts` `MAIN_SESSION_REQUIRED_TEMPLATE_NAMES = {review-contract.md}`
filters the required-read tails; `guides.ts` fails the load closed on an unreadable
listed overlay; `preflight.ts` surfaces that reason. The consumer hook +
`quality.json` need no change (the verb computes the set from the engine). Tests
updated (`guides-read.test.ts`, `preflight.test.ts`).

---

## ADR-017 — check-new-deps flags a source SWAP on an existing dependency

- **Status:** Accepted
- **Date:** 2026-07-15

### Context

`check-new-deps` enforced its positive spec grammar and lockfile pinning only on
NEW deps; D3 deliberately lets a lockfile-proven registry RANGE change on an
existing dep pass. That left the security-critical gap: an existing dep silently
re-pointed from a registry version/range/tag to a git repo, tarball URL, `npm:`
alias, or local path (a supply-chain source SWAP) passed unflagged. A v0.20.x
attempt was backed out because a `://` regex is not a robust classifier (misses
scp-git `git@host:` and bare `user/repo`) and because the lock-only vector,
section precedence, and blocking posture were undecided. Design +
Gate P/C: `docs/source-swap-detection-plan.md`.

### Decision

- **Scope: source-swap only.** A registry range/tag change on an existing dep
  stays passing (the D3 contract); only a change to a non-registry SOURCE is
  flagged. Grammar-tightening on changed deps is explicitly deferred.
- **A vendored classifier, no runtime dependency.** `npm-package-arg` is
  unavailable to a tool that imports only `node:` builtins and runs from
  `vendor/` in every consumer (a top-level import would hard-crash the gate
  before its own error handling). `isSourceSpec` is a fail-closed port of
  npm-package-arg's registry-vs-source partition — source iff the spec starts
  with `.`, contains `\`, contains `:` or `/`, or ends `.tgz`/`.tar`/`.tar.gz`;
  else registry. Verified against `npm-package-arg@14` (0 false negatives / 84
  specs). No `file:vendor/dev-standards` exemption in the classifier (a
  registry→vendor-path change is a real swap); the sanctioned vendored dep is
  exempt naturally because an unchanged dep has no delta. An `npm:` alias is
  deliberately treated as source.
- **The lock-only vector is inspected too.** Because `npm ci` installs the lock's
  `resolved` verbatim, a swap that leaves `package.json` unchanged is caught by
  three staged-lock signals for existing deps: a source root spec, a non-https
  `resolved`, and a `resolved` registry-identity (host + package path) that
  drifts from the base HEAD lock — the last catches an https↔https swap including
  a same-host pivot to a different package. `link:true` (local/workspace)
  resolutions are exempt. Residual ceilings (documented): a `link:` swap and a
  first-time tarball with no base entry to diff.
- **Precedence, not rejection.** Cross-section duplicate names are resolved by an
  effective map (optional > deps > dev), not rejected — npm permits a name in
  more than one section.
- **Report-only.** Source-swap findings ride the existing exit-1 channel; the gate
  stays `mode: "report-only"` in both `quality.json` and the seed. The
  report-only → blocking flip is a separate CALIBRATION decision.

### Consequences

- The gate's registration shape is unchanged (mode / exit codes / skip / timeout),
  so there is no seed-config delta — the behavior lives entirely inside the tool,
  and both `quality.json` and `templates/consumer/quality.starter.json` stay as
  they were (confirmed same batch).
- A workspace repo does not false-fail: `link:true` resolutions are exempt from
  the URL signals.
- The residual lock-only ceilings (`link:` swaps; first-time same-registry
  tarballs with no base entry) are honest gaps, upgradable later by pinning the
  expected registry host in `quality.json`.
- Findings are non-blocking until a calibration session flips the gate with real
  catch evidence and zero operational noise.

---

## ADR-018 — Review-owned rule classes get named owners: gate floor, profile corpus, recall ratchet

- **Status:** Accepted
- **Date:** 2026-07-15
- **Plan:** `docs/review-recall-plan.md` (Gate-P-reviewed)
- **Amended by:** ADR-020 (2026-07-16) — the standalone full-corpus Codex
  cross-run this ADR paired with the fan-out is removed; Codex is folded into the
  fan-out as a per-profile staffing mode.

### Context

Pilot evidence (ai-prompter PR #25, 2026-07-15): a package that had JUST passed a
full deep-review (18 adversarially verified fixes, `verify --full` green) still
drew 20 owner review comments — 16 inline magic numbers (src and tests), 3
identifier-meaningfulness cases (`avgIdf`, a `.t` property signature, `pos`), 1
type-placement case (`src/types.ts` outside the types home). Every one falls in a
class ADR-014/ADR-015 assigned to review judgment. Verified root causes: ~3k
lines of guide text per reviewer dilute per-rule recall; finders report examples,
not rule saturation; nothing records which rule classes were checked against
which files; verification filters false positives while nothing measures recall.
"Review-owned ceiling" was a class with no enforced owner.

### Decision

1. **Ownership invariant.** A rule class may stay review-owned ONLY with a named
   profile owner (below); a mechanically checkable class gets a gate, or an ADR
   note recording why a gate is impossible/too noisy. This amends ADR-014's
   "review-owned ceiling" and supersedes ADR-015's ownership assignment — the
   ADR-015 review prompts survive as profile content, but the PRIMARY owner of
   inline numeric literals and exported-type placement becomes the gate floor.
2. **Gate floor.** One shared plugin object (`eslint/plugin.js`) carries every
   custom rule — two flat-config entries defining different objects under the
   same plugin key throw `Cannot redefine plugin` (reproduced), so factories must
   share the object. New presets: `inlineLiterals()` wrapping
   `@typescript-eslint/no-magic-numbers` with curated defaults (numeric-only v1);
   `dev-standards/types-home` (exported `interface`/`type` outside the types
   home; explicit export-resolution semantics; string-regex `allowNamePattern`,
   seed `"Props$"`); `dev-standards/property-naming` (min-3 floor on TS property
   SIGNATURES — class fields already covered by `naming`; a distinct rule so its
   severity ramps independently; exemptions are file-scoped, never a global key
   list, which would blind the `.t` canary class). Consumer template ships all
   three at `error`; an existing consumer adopts at `warn` and CALIBRATION flips.
3. **Profile corpus.** The seven guide templates are REWRITTEN into
   `review-contract.md` + six self-contained lens profiles in the same directory
   (owner decision: a fan-out worker receives ONE ready instruction file; the
   keep-guides-plus-ownership-map alternative was considered and declined).
   `TRACEABILITY.md` carries the migration table (every old normative section →
   its new home) and the BLINDED canary registry (canaries never appear in
   worker-facing profile bodies). The main session's ADR-016 obligations are
   unchanged (it reads contract + all profiles [SUPERSEDED 2026-07-16: the main
   session reads only the ANCHOR — contract + project reads; the profile bodies
   become profile-route reads — see the ADR-016 Amendment 2026-07-16 and the
   fan-out Amendment below]); the skill's worker-briefing rule changes to contract
   + assigned profile; v1 fan-out runs on external workers (outside the
   Stop/SubagentStop gate, same category as the Codex cross-run) — a worker-scoped
   required set for in-session subagents is deferred.
4. **Recall ratchet.** The gate-miss ledger (template + the canonical
   `effectiveness-plan.md` §5 definition) gains the `judgment-missed` class and
   `profile:<name>` fix route. Closing a judgment escape requires a canary entry
   and a BLINDED replay: the worker reports the retained offense without being
   told the expected locations. The one-time gate-proof run against the retained
   pilot state is recorded at consumer adoption; durable offense-shaped fixtures
   live in the rule tests.

Amendment 2026-07-15 (owner decision): `profile-structure-and-dependencies.md`
was split three ways so each worker owns one mandate with size and attention
parity.

Amendment 2026-07-16 (pilot evidence, ai-prompter apps/api run): the recall
engine itself was skipped. A deep-review pass followed the ADR-016 guide-read
gate to the letter (all guides read, materialized as todos) but COLLAPSED the
profile fan-out into a single full-corpus Codex cross-run plus the main
session's own pass - the enforced step held, the prose-only step decayed
(exactly the ADR-018/ADR-019 failure mode, one level up). Root cause: the
fan-out is unenforceable in v1 (external workers the Stop hook never sees) AND
the skill body's soft wording ("scope permitting", a profile "may be skipped")
gave a rationalization foothold for a small scope. Fix (skill body, this pin),
refined by a Codex doc-review + Gate-P plan-critique:
the fan-out is now MANDATORY and NON-COLLAPSIBLE; every applicable profile gets a
**profile route** — a dedicated worker (default) OR a main-session lens pass over
that one profile when no worker route exists (the worker-route floor is a route,
so the headless case is literally compliant, not a contradiction). The Codex
cross-run is explicitly ADDITIONAL, never a substitute. A profile route is
skippable ONLY when EVERY section of that profile is inapplicable by its own
conditionality banner ("no bounded contexts" drops the DDD subsection, NOT the
architecture profile, which keeps its unconditional baseline checks; "small
scope" / "looks clean" / budget are never skip reasons). The pass's FIRST-action
`TodoWrite` carries one item per CORPUS profile route plus the coverage-matrix
merge (the ADR-016 guide-read countermeasure, extended). The coverage matrix
becomes a REQUIRED report section with one row for EVERY corpus profile in exactly
one state — `APPLIED`+route, `SKIPPED`+banner reason, or `GAP`+operational blocker
(`NOT REVIEWED`) — so a collapse or a missing profile is visible on the report's
face. This lands together with the ADR-016 anchor rescope (same date): the main
session no longer reads all profiles, so the fan-out is now the SOLE reader of the
per-lens corpus — which makes its mandatory, tracked, matrix-accounted shape the
load-bearing guarantee. The real in-session enforcement gate (a Stop hook parsing
the coverage matrix) stays deferred — same register as the worker-scoped read set
— so this amendment tightens the honest-limit reliance on prose until that gate
lands.

### Consequences

- The 20-comment miss class becomes 18 deterministic lint errors + 2 named
  profile canaries — the same escape cannot recur silently.
- Review workers stop re-checking what gates own (the skill's
  deterministic-first rule already forbids duplicating a gate) and spend recall
  on judgment rules, one lens each, with coverage accounted per file × profile.
- Legacy consumer overlays lack a profile-route owner until re-keyed — the skill
  broadcasts each unmatched overlay into every profile route's brief during the
  migration window. A route is a worker or, under the worker-route floor, a
  main-session lens pass (ADR-016 2026-07-16 rescope: profile bodies/overlays are
  profile-route reads, no longer main-session-gated).

---

## ADR-019 — Two-stage development: functional first, standards at review

- **Status:** Accepted
- **Date:** 2026-07-15
- **Owner decision** (pilot owner, 2026-07-15)

### Context

Prose restrictions at write time are weakly followed: the pilot wrote code under
mandatory pre-reads (conventions, checklist, guides) and still landed the ADR-018
evidence set. Attention spent on rule prose while writing measurably decays;
machine gates do not (they fire regardless of attention).

### Decision

Feature development in an adopting repo is explicitly two-stage:

1. **Stage 1 — write functional code.** Goal: working code WITH its behavior
   tests. Prose pre-reads shrink to a minimum; machine gates stay BLOCKING at
   their configured severity (a gate is mechanical feedback, not an attention
   tax — with ADR-018's floor, placement/constants/naming floors are gate-owned);
   the always-on Gate C cross-check is unchanged.
2. **Stage 2 — deep-review-refactor is a REQUIRED pipeline stage for feature
   work.** The profile fan-out applies the full standards corpus with per-lens
   attention; architecture/quality intent is given to the AI here, where recall
   is engineered. Consent (ADR-012/016 posture) governs WHEN it runs, never
   WHETHER: a skipped or postponed Stage 2 leaves the feature explicitly marked
   `stage-2 pending` — a tracked debt entry in the repo's status doc — never
   silently "done".

The checklist template frames its sections as Stage-1 (blocks commit — gates)
vs Stage-2 (review-owned — profiles). Consumer pre-read guidance is updated at
adoption, not retroactively by this ADR.

**Enforcement (v1, honest).** The `stage-2 pending` record is a skill-driven
CONVENTION, not a machine gate: the deep-review offer step writes the debt
entry on decline; no receipt schema, merge check, or hook enforces it (a
machine-readable Stage-2 receipt is deferred — same deferral register as the
worker-scoped read set, ADR-018). The calibration session reviews pending
entries, which is where an unrecorded decline surfaces.

### Consequences

- Writing sessions carry less rule prose; standards enforcement concentrates in
  the two layers that demonstrably hold: deterministic gates and the
  high-recall Stage-2 review.
- A declined Stage 2 lowers the bar VISIBLY when the convention is followed —
  the debt entry survives session boundaries; making that impossible to skip
  (receipt + gate) is the deferred hardening above.

## ADR-020 — Codex joins the review as a per-profile fan-out staffing mode, replacing the standalone full-corpus cross-run

- **Status:** Accepted
- **Date:** 2026-07-16
- **Amends:** ADR-018 (profile fan-out) — retires its "the Codex cross-run is
  ADDITIONAL to the fan-out" clause.

### Context

ADR-018 established the mandatory per-profile fan-out (the recall engine) AND, on
top of it, a SEPARATE standalone Codex cross-run: one independent full-corpus
review by Codex, effort chosen per run (`xhigh`/`ultra`). Two structures, two
runtimes. The full-corpus cross-run gave one model the whole corpus at once —
cross-model recall diversity — but at the cost of the very dilution the fan-out
exists to fix (one route carrying ~3k lines of guide text), and the per-run
`ultra` ask was an extra prompt whose only job was to set effort.

Owner decision (2026-07-16): fold Codex INTO the fan-out. The fan-out is the
recall engine; the MODEL that staffs it should be a per-run choice, not a second
parallel structure.

### Decision

1. **The standalone full-corpus Codex cross-run is removed.** Codex no longer
   runs as one independent full-corpus pass. Cross-model recall diversity is now
   delivered by STAFFING the per-profile fan-out with Codex (below), where
   per-lens attention is already engineered.
2. **The §Run-setup first ask changes** from "Codex cross-run effort
   xhigh/ultra" to a **profile-worker mode**: (a) N Opus workers over the N
   profiles, (b) N Codex workers over them, or (c) BOTH fleets in parallel with
   the main session consolidating per profile. Default `c` — it preserves the
   cross-model diversity the standalone cross-run provided by default, and the
   Codex half is flat-rate. The second ask (report-only / fix) is unchanged.
3. **Codex effort is fixed at `xhigh`, read-only, per profile.** A Codex route
   reads only its two corpus files in-band (`review-contract.md` + its one
   `profile-*.md`, plus overlays and the project must-reads), NOT the full
   corpus. `ultra` is never auto-selected; it is reached only on an explicit
   in-the-moment user request — the per-run ultra confirmation the global Codex
   gates require.
4. **The fan-out invariant is unchanged** (ADR-018): MANDATORY, NON-COLLAPSIBLE,
   one differentiated route + coverage row per applicable profile. The
   worker-mode choice governs only the staffing MODEL; a single full-corpus pass
   by ANY model still does not discharge the per-profile obligation. Adversarial
   verification, provenance labels (`opus`/`codex`/`both`), the independence
   guard, and the required coverage matrix carry over from the old cross-run
   merge to the new per-profile consolidation.

### Consequences

- One structure instead of two: the fan-out is the single recall engine, staffed
  by the chosen model(s). No separate full-corpus cross-run to launch, watch, or
  merge.
- Cross-model recall becomes opt-out (pick mode a) rather than always-on; the
  default (c) keeps it on. Headless/delegated runs, which never call external
  agents, fall to main-session lens passes under the worker-route floor —
  single-model, as before.
- Per-profile Codex routes each read only their one profile, ending the
  full-corpus dilution the fan-out exists to prevent; concurrency requires unique
  per-route `-o`/log paths (the /tmp-collision hazard).
- `docs/review-recall-plan.md`'s "the independent Codex cross-run stays as-is"
  bullet is superseded.
