# Architecture Decision Records

The canonical ADR log. Referencing a new `ADR-0NN` id from code, a skill body, or
a plan requires a matching entry here (CLAUDE.md ADR discipline).

**ADR-001..012 predate this file** (the "create on first entry" debt from CLAUDE.md).
They were never collected into a single log; they live as references in code and
skill bodies — e.g. ADR-003 (`agents/review-guide-templates/core-code-guidelines.md`),
ADR-007 (`deep-review/src/types.ts`), ADR-010 and ADR-012 (`deep-review/src/handoff.ts`,
`agents/skill-sources/deep-review-refactor.md`). Backfilling them here is documented
debt; new decisions land as full entries below.

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
