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
