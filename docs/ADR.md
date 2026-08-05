# Architecture Decision Records

Status: **live decision log**. Accepted decisions remain current until an amendment or
new ADR explicitly supersedes them; retired decisions are historical constraints.

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

## Index

| ADR | Status | Decision |
| --- | --- | --- |
| ADR-003 | Accepted | One canonical source per guide/skill body |
| ADR-007 | Accepted | `deep_review` is an optional top-level config block |
| ADR-008 | Retired | Autonomous write-capable Codex reviewer seat |
| ADR-010 | Accepted | Skill wrappers are static pointers |
| ADR-011 | Retired | Automatic cross-model review-chain workflow |
| ADR-012 | Accepted | Landing through standalone handoff; no local merge verb |
| ADR-013 | Accepted | Fix loop verified under the merge standard |
| ADR-014 | Accepted | Mechanical placement rules and operational naming standards |
| ADR-015 | Accepted | Constant/type placement stays a review judgment |
| ADR-016 | Accepted | Transcript-backed required-guide gate |
| ADR-017 | Accepted | Existing-dependency source-swap detection |
| ADR-018 | Accepted | Named owners for gate floor, profiles, and recall ratchet |
| ADR-019 | Accepted | Two-stage development |
| ADR-020 | Accepted | Codex per-profile fan-out |
| ADR-021 | Accepted | Test-to-source placement is a lens plus report-only assist |
| ADR-022 | Accepted | Comparison literals become a machine gate |
| ADR-023 | Accepted | Package boundaries require a layer worth isolating |
| ADR-024 | Accepted | Fix every valid finding; escalate cost/benefit decisions |
| ADR-025 | Accepted | Distinct Codex-only deep-review skill |
| ADR-026 | Accepted | SonarJS machinery upstream, rule matrix in the consumer |
| ADR-027 | Accepted | `check-new-deps` proves pnpm workspaces |
| ADR-028 | Accepted | Shared deep-review core with adaptive tiered topology |

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

### Amendment (2026-07-16, reviewer lens + starter baseline)

ADR-014 made the naming standard operational on the CONSUMER side (the template
requires a declared allowlist or an explicit "abbreviations are fine" stance) but
left the REVIEWER with no lens to enforce it: `profile-naming-and-constants.md`
judged name meaningfulness by taste alone. The naming profile now carries a
Conditionality-gated judgment prompt — where a repo declares a
blessed-abbreviation allowlist, an abbreviation neither on the list nor spelled
out is a finding, and a new abbreviation introduced without a same-PR list
addition is a finding; the length/ASCII gate is only the floor. The gating
mirrors ADR-015's home-conditional placement lenses (a repo declaring
"abbreviations are fine" is out of scope). `code-conventions-template.md`
§Naming now also seeds a universal starter baseline (`api, ctx, id, idx, opts,
…`) a new consumer extends with its domain abbreviations: the concrete list
stays consumer-owned (per the core/consumer split), only the enforcement lens
and the starter vocabulary are shared. Seed parity: the template edit is the
seed and the profile is read in place (no dist sync), same batch. Making the
list authoritative retired the pilot's `pos` naming canary (ADR-018 registry):
the pilot blessed `pos`, so the retained state is no longer an offense once
allowlist membership decides compliance — burned in `TRACEABILITY.md` this batch
(without it the new lens would silently neuter a live canary).

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

### Amendment 2026-07-16 — overlay entry-type contract + one shared confinement boundary

Three pre-existing fail-opens in the overlay loader (Codex Gate-C on the deep-review
hardening diff) are closed together, since they share one boundary. The consumer-visible
contract for `deep_review.guides_dir` is now explicit:

- **An overlay is loaded ONLY from a plain regular `*.md` file.** A leaf that is a
  symlink (regardless of target — even in-repo), a directory named `*.md`, or any other
  non-regular entry is REJECTED fail-closed, never silently dropped. Before, an
  `entry.isFile()` filter dropped a symlinked/non-regular `*.md` silently, so a review
  rule vanished from the corpus AND escaped the read gate. Each leaf is read through one
  no-follow descriptor (`openSync(O_RDONLY|O_NOFOLLOW)` → `fstat` isFile → read fd), so
  the type check and the read are the same operation (no check→read TOCTOU). The reserved
  `TRACEABILITY.md` is skipped BEFORE the type check (a broken reserved entry is ignored,
  not a hard failure).
- **One confinement boundary, shared by fix-mode preflight AND the Stop-gate**
  (`assertGuidesDirConfined`). Previously preflight confined `guides_dir` LEXICALLY only
  while the gate also realpath-confined it, so an in-repo `guides_dir` symlinked OUTSIDE
  the repo passed the file-EDITING verb (the weaker side) yet the gate rejected it. Now
  both apply the same confinement: a lexical escape (`../`, absolute) OR **any symlink
  component in the `guides_dir` path** (leaf or ancestor, dangling or not) is rejected
  fail-closed — `guides_dir` must be a real directory. A symlinked `guides_dir` is refused
  rather than followed for two reasons: (a) the required-read tail is computed lexically
  while read-proof is realpath-matched, so a symlinked dir makes the anchor overlay
  unprovable and the Stop-gate would block forever; (b) a dangling ancestor symlink would
  otherwise ENOENT the whole path and hide the overlay as "absent" (a fail-open). A
  non-ENOENT `lstat` fault on any component fails closed (never "absent").
- **The required overlay tail is derived from the loader's OWN returned sources** (one
  authoritative snapshot), not a second directory listing that could disagree under a
  filesystem race.

Ceiling (`ponytail:` in `guides.ts`): Node has no `openat`, so ANCESTOR directory
components of an overlay leaf stay path-based — an ancestor-swap race survives; the
no-follow open closes the LEAF check→read race only. A native addon is the upgrade path if
that ever matters.

Engine: `guides.ts` (`loadOverlaySources` — the hardened overlay seam, separate from the
trusted template name-lister), `guides-read.ts` (`assertGuidesDirConfined` +
`assertNoSymlinkComponent`; source-derived anchor tail; `realListOverlay` removed),
`preflight.ts` (`runPreflight(config, verb, cwd, overrides?)` — shares the confinement),
`cli.ts` (wires `env.cwd` into it). No consumer `quality.json`/hook change (behavior for a
normal in-repo regular-file overlay is unchanged). Tests: `guides-read.test.ts`,
`preflight.test.ts`, `cli.test.ts`.

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
Gate P/C: `docs/plans/archive/2026-07-15-source-swap-detection-plan.md`.

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
- **Plan:** `docs/plans/archive/2026-07-15-review-recall-plan.md` (Gate-P-reviewed)
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
   WHETHER.

The checklist template frames its sections as Stage-1 (blocks commit — gates)
vs Stage-2 (review-owned — profiles). Consumer pre-read guidance is updated at
adoption, not retroactively by this ADR.

**Amendment (2026-07-31, owner decision).** The automatic Stage-2 OFFER is
retired. Stage 2 runs only when the owner invokes the skill by name
(`/deep-review-refactor`, `$deep-review-refactor-codex`); an agent never
proposes it, never asks whether to run it, and never composes a review prompt
because feature work completed — a finished feature simply finishes. Stage 2
remains the required quality stage of the doctrine and still runs in a FRESH
session over the branch diff; only the automatic offer that used to start it is
gone. Supersedes the offer wording in the 2026-07-25 amendment, the 2026-07-16
addendum, and the Consequences bullet below.

**Amendment (2026-07-25, owner decision).** The documentation convention for an
unperformed Stage 2 is retired. A declined or postponed offer ends after the
one-time offer and does not create a `stage-2 pending` entry, handoff note, or
other repository-documentation record solely because the review did not run.
This changes recording only; consent and the one-time-offer behavior are
unchanged. There is no Stage-2 receipt or merge gate.

**Addendum (2026-07-16, pilot adoption).** The seeder now drops
`.claude/two-stage-dev.marker` (copy-if-absent, verified by `--check` with the
other instance docs): machine-local write-time guide injectors (editor
pre-tool hooks, delegate-launcher preambles) key off its presence and stay
silent in two-stage repos — Stage 1 loses the injection tax without touching
non-adopting repos. Consumer-wired convention (ADOPTION §4 — NOT yet emitted
by the canonical skill): the Stage-2 offer is composed as a ready prompt for
a FRESH session (scope = diff vs base + new files, branch/base SHA, worktree
path) — the build session's context is already spent, so the review never
runs inside it. Known seam: `ds-update-pins.sh` commits pathspec-confined to
the gitlink, so the first bump of a pre-marker consumer leaves the freshly
seeded marker untracked — commit it with that bump (transactional inclusion
tracked in BACKLOG).

### Consequences

- Writing sessions carry less rule prose; standards enforcement concentrates in
  the two layers that demonstrably hold: deterministic gates and the
  high-recall Stage-2 review.
- An uninvoked Stage 2 adds no repository-documentation debt and no receipt;
  the feature session simply finishes.

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
- `docs/plans/archive/2026-07-15-review-recall-plan.md`'s
  "the independent Codex cross-run stays as-is"
  bullet is superseded.

---

## ADR-021 — Test-to-source placement: a review-owned lens plus a report-only mechanical assist, not a blocking gate

- **Status:** Accepted
- **Date:** 2026-07-16
- **Owner decision** (repo owner, 2026-07-16)
- **Uses:** ADR-018 §Decision.1 — a mechanically-checkable rule class gets a gate
  OR a note recording why a blocking gate is too noisy, plus a named review
  owner. This is that branch: report-only assist + named profile owner.

### Context

Where a repo has a settled test-layout convention, a test should mirror its
subject's source path — replicating every intermediate subfolder — so a reader
can map any test to its source and back without searching. The convention itself
is the repo's to choose (a parallel tree or co-location); a repo without a
settled convention is out of scope. The judgment rule was added as a lens in
`profile-tests-quality.md` §Test-to-source traceability and placement (it reaches
consumers read-in-place, like the rest of the profile corpus). The open question
was whether to ALSO enforce placement mechanically. Research plus a Gate-P plan
critique agreed: mechanically buildable (a runner check may do the needed
whole-tree lookup — precedent `check-new-deps`/`diff-cover` do I/O; the runner
also hands a check the tracked tree via a `{files:repo_all}` token), but this
repo's test↔source mapping is irregular — cross-root subjects (a `tests/tools`
test whose subject is a `scripts/*.sh`), cross-extension, many-to-one via
dot-qualifier variants (`exec.bypass.test.ts` → `exec.ts`), and cross-cutting /
e2e / aspect tests with no 1:1 subject. A faithful blocking gate would reject
legitimate commits and carry an exemption set that rots. The owner chose the
report-only assist knowingly, over the guide-only option.

### Decision

1. **Review-owned.** Placement is owned by `profile-tests-quality.md`
   §Test-to-source traceability and placement — the judgment cases a path-map
   cannot express (ambiguous subject, fragmented coverage, whether the convention
   itself is right).
2. **A report-only mechanical assist ships:** `tools/check-test-placement.mjs`
   (pure list-processor, no I/O — it receives the tracked tree via a single
   `{files:placement_tree}` token; per-`(testRoot, sourceRoot, sourceExt)` maps,
   several rows may share a testRoot; subject resolution is dot-strip only, never
   hyphen-strip; exact-path `--ignore` for tests with no 1:1 subject). Wired into
   THIS repo's `full` tier, `mode: report-only`.
3. **Not a blocking gate.** Placement findings (exit 1) are non-blocking;
   operational failures (exit 2, bad args/glob) remain fail-closed via
   `operational_exit_codes`. The assist surfaces NEW drift (a test added under a
   mapped root whose mirrored source — including subfolder — is absent); it does
   not relitigate the current tree. A clean 0-finding baseline is held by
   exact-path exemptions for aspect/cross-cutting tests plus the e2e/fixtures
   directory globs.
4. **Opt-in for consumers, like `check-companion-tests`.** The tool ships in the
   submodule (`vendor/dev-standards/tools/check-test-placement.mjs`); it is NOT
   seeded as an active check because the map/exemption config is per-repo and
   cannot be a generic default (the strict-JSON starter has no disabled/example
   check form). A consumer opts in by adding a `full`-tier report-only check with
   its own `--map`/`--ignore`, e.g.:
   `["node", "vendor/dev-standards/tools/check-test-placement.mjs", "--map", "tests/<area>:<srcRoot>:.ts", "--", "{files:<tree>}"]`.

### Consequences

- Exemption maintenance is the accepted cost: each new aspect/cross-cutting test
  whose name has no 1:1 subject needs one `--ignore` line, else the report-only
  output gains a benign false positive. Recorded as a known limitation, not a bug.
- Dot-strip only: because hyphens are part of real source basenames
  (`feature-slug.ts`), `slug.test.ts` does NOT resolve to `feature-slug.ts` — such
  descriptively-named tests are exempted, not auto-aliased.
- No `quality.schema.json` change — argv is opaque and the `{files:}` token
  grammar already admits the new fileset.
- If real placement-drift evidence later shows the report-only signal is worth
  hardening, promoting a scoped subset to blocking is a follow-up decision, not a
  reversal of this one.

---

## ADR-022 — Magic strings in comparisons become a machine gate (`comparisonLiterals`)

- **Status:** Accepted
- **Date:** 2026-07-16
- **Owner decision** (repo owner, 2026-07-16)
- **Amends:** ADR-015 (constant/type placement become always-on review judgments) —
  for the specific shape of a bare string literal in an equality comparison or a
  `switch` case, ownership moves from review to a deterministic gate. Every other
  string position stays review-owned per ADR-015.

### Context

`isEditableTarget` in the pilot compared `element.tagName === "INPUT" | "SELECT" |
"TEXTAREA"` with inline string literals. A full deep-review fan-out (8 profiles ×
Opus+Codex) marked the file clean on naming — no machine gate covers magic strings:
`inlineLiterals` wraps `@typescript-eslint/no-magic-numbers` (numbers only) and
`constants-home` fires only on a module-scope `const` bound to a bare literal. A
`x === "lit"` comparison is invisible to both, so the class was left to review recall,
which missed it. Strings are noisier than numbers (error messages, discriminant tag
DECLARATIONS, DOM/aria names, CSS classes, import specifiers, i18n keys, log scopes are
all legitimate), so a blanket "no string literals" rule is unusable — the gate had to be
scoped to the high-signal, low-noise shape. Measured on the pilot (SHA `00ccbedc`): of
78 raw string comparisons (72 equality operands + 6 `switch` cases), 31 are
`typeof x === "…"` (a fixed language return, not a magic value) and 7 are empty strings;
the remaining 40 (34 equality + 6 switch) are the real candidates.

### Decision

1. **A new custom plugin rule `dev-standards/comparison-literals`** (factory
   `comparisonLiterals({files, ignores, severity})`), NOT a `no-restricted-syntax`
   selector: flat config REPLACES same-rule options, so a shared `no-restricted-syntax`
   entry would clobber the `naming` floor (or be clobbered). A distinct rule id cannot
   collide, carries a hint message, and expresses precise exemptions.
2. **Scope (MVP):** a static string operand of an equality `BinaryExpression`
   (`===`/`!==`/`==`/`!=`) and a `SwitchCase` test. Reports ONCE per node. A
   `staticStringValue` helper unwraps a transparent `TSAsExpression`/`TSSatisfiesExpression`
   and accepts an expressionless template, so a cast or backtick spelling cannot bypass it.
3. **Exempt in the rule (universal):** the empty string, and a string whose sibling
   operand is a `typeof` unary (either yoda order). **Exempt by construction:** a
   comparison with no string literal, and union/enum type DECLARATIONS (the rule matches
   only value-position comparison nodes, never `TSLiteralType`).
4. **`severity` is a factory param (default `"error"`).** Siblings hard-code error; this
   one is parameterized because it ships to existing consumers on a WARN-first ramp, and a
   consumer must pass `"warn"` on the SAME block that registers the plugin — a separate
   override block would leave `dev-standards` unregistered on any preset-ignored file and
   crash ESLint with "Could not find plugin". Seeds and `presets-compose` keep the default
   error, so a NEW consumer inherits the gate at error from day one.
5. **Review guide amended** (`profile-naming-and-constants.md` §Constants): the
   comparison/switch string shape is now gate-owned, so the reviewer no longer reports it
   (review-contract.md: do not duplicate a deterministic gate). Other string positions stay
   review-owned.

### Consequences

- **Ceilings (documented, review-owned or opt-in):** `.has`/`.includes` membership
  (needs a known-set type; noisy — 0 pilot hits, opt in per repo on demonstrated need);
  interpolated/tagged templates and ternary-valued operands (dynamic); and every string
  position outside a comparison/switch.
- **Rollout is a WARN ramp on the pilot**, flip-to-error deferred to a later calibration
  pass with recorded exit criteria + rollback (docs/CALIBRATION.md). The pilot's eslint
  check carries no `--max-warnings`, so the ramp does not turn `verify` red.
- **Seed parity in the same batch:** `eslint/consumer-template.eslint.config.js` ships the
  active block at error.
- No `quality.schema.json` change — a new preset export, not a manifest shape change.

## ADR-023 — Package/module boundaries are gated by "a layer worth isolating", not consumer count

- **Status:** Accepted
- **Date:** 2026-07-17
- **Owner decision** (repo owner, 2026-07-17)

### Context

`code-conventions-template.md` §"When to add a package or module" primed the
evidence for a new boundary as "multiple real callers or an independent runtime
or release contract" — i.e. it seeded a caller-COUNT bar as the default trigger.
In an AI-written repo the dominant value of a package is structural: an explicit,
compiler-enforced boundary tells each session where code belongs and hardens the
repo against drift. That value lands at the FIRST consumer, not the second;
gating on caller count delays the boundary until retrofitting it costs multiples.
The pilot (`ai-prompter`) hit this directly — its `browser-adapters` package was
lifted out on a single consumer purely for the guardrail, an "override" of the
old ≥2-consumer rule that has now recurred enough to BE the rule.

### Decision

1. The template guidance reframes the trigger as **a new layer of logic worth
   isolating for its own sake** — to sharpen architecture and give AI sessions a
   stronger compiler-enforced boundary — which qualifies even at a single
   consumer. Caller count is no longer the default evidence.
2. **YAGNI is unchanged for runtime abstractions:** a second-vendor adapter, DI
   container, or publish pipeline still waits for a real caller. The shift is
   scoped to STRUCTURAL package/module boundaries, consistent with the
   AI-first-structure principle.
3. The template stays a fill-in: each consumer lists the concrete triggers it
   honors (portable/platform-free concern, independent runtime/release contract,
   shared wire boundary, …).

### Consequences

- Consumers filling `code-conventions.md` from the template no longer inherit a
  caller-count default; a single-consumer structural package is a first-class,
  expected outcome, not an exception needing an owner override.
- No gate/preset/schema change — this is authoring/review guidance. The pilot's
  own `.claude/code-conventions.md` already carries the concrete rule (its four
  packages are canonical instances).

---

## ADR-024 — Fix scope is every VALID finding, not only the critical ones; cost/benefit findings escalate to the developer

- **Status:** Accepted
- **Date:** 2026-07-17
- **Owner decision** (repo owner, 2026-07-17)
- **Amends:** the `deep-review-refactor` review-and-refactor fix phase (ADR-013's
  verified fix loop) — it pins WHICH findings the loop is obligated to fix.

### Context

The skill body never limited fixes to P1, but it never stated the opposite either,
so a run could plausibly fix the criticals and stop. The owner wants the fix phase
to close every VALID finding it can — a confirmed P3 left unfixed is unfinished
work, not restraint. The one real exception is economic: some mechanically-fixable
findings cost far more to fix (large, invasive, risky churn) than the benefit
justifies, and that go/no-go is the developer's call, not the skill's.

### Decision

1. **All severities are in fix scope, within the behavior-preserving-fixable set.**
   Severity ORDERS the work; it does not GATE it. `classify` routes every
   non-no-touch, non-needs-plan VALID finding whose fix is a behavior-preserving
   refactor to `fixable-now` regardless of P1/P2/P3. Fixing only P1s and leaving
   confirmed P2/P3 refactors is a collapsed fix phase. A finding whose fix would
   change observable behavior (a bug fix, a feature) is OUT of auto-fix at every
   severity — the fix phase makes only behavior-preserving slices, so such a finding
   is reported/planned, not churned in as a refactor. That behavior-preservation
   exclusion is prior to and larger than the cost/benefit carve-out below.
2. **Cost/benefit is the one ADDED carve-out, and it escalates — it does not
   auto-decide.** Among behavior-preserving-fixable findings, one whose fix is
   disproportionately large/invasive for a dubious/marginal benefit is NOT
   auto-fixed: the orchestrator sets `needs_plan = true` (→ `needs-plan`) with a
   one-line effort-vs-benefit rationale in the finding's `impact`, so `report`
   surfaces it and the developer makes the go/no-go. This is the SAME disposition
   `profile-refactoring-and-smells.md` already names "leave it / principal exceeds
   interest" — surfaced, never churned. Escalation is a third path between auto-fix
   and no-touch — never a silent fix, never a silent drop.
3. **No engine change.** The existing `classify` precedence
   (no-touch → needs-plan → fixable-now) and the non-blocking `needs-plan` handoff
   bucket already carry this; only the skill body's doctrine is new.

### Consequences

- A developer who approves an escalated finding re-enters it as a fresh
  `fixable-now` finding in a later run; a decline leaves it as a recorded plan.
- The report's `needs-plan` bucket now mixes redesign-scope findings and
  cost/benefit escalations; `FindingsFileV2` has no structured decision state (v1),
  so the per-finding effort-vs-benefit rationale in `impact` — rendered by `report`
  — is what distinguishes them and carries the developer's out-of-band go/no-go.

---

## ADR-025 — Add a distinct Codex-only six-stage deep-review skill

- **Status:** Accepted
- **Date:** 2026-07-25
- **Owner decision** (repo owner, 2026-07-25)
- **Scope:** Codex runtime only. The original Claude `deep-review-refactor`
  skill and ADR-018/020 behavior remain available and unchanged.
- **Amends:** ADR-003/010 by adding a separately named Codex canonical body and
  consumer wrapper; both bodies remain package-owned and shared across projects.

### Context

For Codex sessions, the original mixed-model workflow kept the main session
responsible for too much direct consolidation, planning, and fix-loop context.
Once that context was saturated, every further judgment became expensive and
quickly consumed model limits. The owner requires the Codex host session to
remain a thin orchestrator and wants all heavy work performed by fresh Codex
workers through durable file artifacts. The existing Claude workflow remains a
useful separate runtime path and must not be rewritten by this decision.
Projects that install dev-standards must discover the skill automatically in
Codex without copying or forking its body.

### Decision

1. **Codex workers only.** The new Codex skill has no Opus/Claude/BOTH choice.
   Every profile,
   consolidator, planner, implementer, integrator, reviewer, and repair route is
   staffed by Codex collaboration workers.
2. **Six explicit stages:** per-profile fan-out; one consolidation worker; one
   estimation/scheduling worker; implementation workers plus serialized
   integration; several independent review workers; one bounded post-review
   repair worker followed by self-review and verification.
3. **Main-context floor.** Workers exchange paths to run artifacts, not copied
   reports or patches. The main session reads compact summaries and `run.json`,
   surfacing only consent, blockers, decisions requiring new authority, and the
   final result. Host transcript anchors required by ADR-016 are the sole
   runtime-specific read exception.
4. **Fix by default after consent.** An accepted or directly invoked run uses
   `review-and-refactor`; `review-only` requires an explicit no-edit request.
   Auto-fixes remain behavior-preserving, no-touch-aware, verified, and never
   land to the base branch.
5. **Separate names and bodies.** The original Claude skill remains
   `deep-review-refactor` and points to
   `agents/skill-sources/deep-review-refactor.md`. `seed-consumer.sh` installs a
   distinct `.agents/skills/deep-review-refactor-codex/SKILL.md` pointer plus
   `agents/openai.yaml`, resolving
   `agents/skill-sources/deep-review-refactor-codex.md`. Consumers never fork
   either package-owned body.

### Consequences

- The Codex skill intentionally omits cross-model diversity in exchange for
  predictable worker availability, lower host-context pressure, and a simpler
  run contract. The original Claude skill retains its existing behavior.
- Parallel writes require isolated worktrees or patch-only workers; one
  integration worker serializes application, tests, self-review, and
  `commit-slice`.
- A consumer pin bump updates the shared logic. Consumers seeded before the
  Codex wrapper must rerun `seed-consumer.sh` once because pin-only updates do
  not create new root files.
- If no Codex worker route exists, the pass stops with an operational blocker;
  it does not collapse into a context-heavy main-session review.

---

## ADR-026 — Ship the SonarJS machinery upstream; the consumer owns the rule matrix

- **Status:** Accepted
- **Date:** 2026-07-28
- **Supersedes:** the `eslint/README.md` §"Deliberately opt-in / not shipped (v1)"
  bullet that held `sonarjs` out of the package entirely.
- **Amends:** ADR-018 (review-owned rule classes get named owners) by moving a
  bounded slice of the complexity class from the review profile to a machine gate.

### Context

`eslint-plugin-sonarjs` was held out of v1 because its value is real but its
curation is heavy: 279 rules in 4.2.0, of which `recommended` leaves 217
non-`off` — a set that, in the first adopting repo, was measured to overlap
dozens of rules already enabled by core/`typescript-eslint`/`vitest`/`react`,
and that folds the security "hotspot" family (review-not-CI semantics) in with
real bug rules. Which of those collisions apply is a property of the consuming
repo, not of this package. At the same time the roadmap requires the plugin
dev-standards-first, and names `rule disposition` a per-repo output.
The two are only in conflict if upstream ships opinions. They are compatible if
upstream ships machinery: the original README reasoning — "add a small bug
subset per repo, not a universal inheritance" — is preserved exactly by making
the per-repo subset the mandatory input rather than an optional override.

A second, weaker temptation was to let the plugin's own defaults stand for the
24 configurable rules. That would make a patch upgrade silently redefine what
the repo considers too complex, with no key changing in any repo file.

### Decision

1. **Upstream owns machinery only.** `eslint-plugin-sonarjs` becomes a
   `dependency` at an exact pin, and `eslint/sonarjs.js` exports a factory that
   takes the consumer's complete disposition map and returns a flat config. The
   factory contains no rule list, no thresholds, and never spreads
   `recommended`. Its whole job is to refuse a matrix that is incomplete or
   incoherent.
2. **The matrix is validated against the runtime catalog, not a number.** The
   map's key set must equal `Object.keys(plugin.rules)` of the installed
   version exactly — an unknown rule id and a missing disposition are equally
   red. A plugin upgrade therefore becomes an explicit dispositioning task
   instead of a silent behavior change.
3. **`error` or `off`, never `warn`.** Lifelong warnings are banned by the
   standard, and ESLint bulk suppressions act on `error` alone.
4. **Every disposition carries a closed-vocabulary reason.** `enabled`,
   `overlap:<ruleId>`, `owned-elsewhere:<gate>`, `hotspot-review`, `unproven`,
   `style-not-defect`, `cost-exceeds-value` — anything else is red, and every
   reason but `enabled` requires a non-empty note.
5. **Enabled rules restate every value the plugin would default.** Schema
   validity is not explicitness: ESLint merges `meta.defaultOptions` into
   whatever the consumer supplies, so `[]`, `[{}]`, and a partial object all
   validate while the built-in threshold silently survives. The factory reads
   the defaulted positions and properties off the installed plugin and requires
   an own, defined value for each; supplied options are additionally validated
   against the rule's own schema, so a typo'd key cannot pass as a threshold.
6. **The complexity-class transfer is bounded (DQ1-D15).**
   `profile-refactoring-and-smells.md` hands the machine gate only the counted
   forms a repo's matrix actually marks `enabled`. Essential-versus-accidental
   judgment, change amplification, cognitive load, and the
   duplication-versus-wrong-abstraction call stay with the review profile.

### Consequences

- The plugin is installed for every consumer, but inert until that consumer
  writes a matrix — the cost is install weight, not lint noise. Part of that
  weight is a `typescript` **runtime** dependency (`>=5 <6.1.0`, not a peer), so
  a consumer can end up resolving a TypeScript copy beside its own; it also
  peers `eslint ^8 || ^9 || ^10`, so it adds no new ESLint-10 blocker.
- Options validation needs a JSON-Schema validator at config-build time, so
  `ajv` moves from `devDependencies` to `dependencies`.
- Writing the first matrix is deliberately expensive: 279 reasoned entries. That
  is the price of the ADR-018 invariant, and it is paid once per repo, plus the
  delta on each upgrade.
- Because the transfer in (6) is partial, a class the matrix leaves `off` keeps
  its review-profile ceiling. A future decision that enables more rules must
  narrow the profile again, in the same batch — silence is not a transfer.

## ADR-027 — `check-new-deps` proves pnpm workspaces instead of standing down

- **Status:** Accepted
- **Date:** 2026-08-05
- **Amends:** D10 (the pnpm/yarn stand-down predicate) — pnpm is no longer
  silenced; yarn still is.
- **Amends:** the v1 scope statement in `tools/check-new-deps.mjs` and
  `docs/ADOPTION.md` §"After install", which both declared pnpm out of scope.

### Context

The stand-down was written when the gate had no pnpm proof model: a tracked
`pnpm-lock.yaml` made the tool print `npm-only check inactive` and exit 0. In
the only live consumer — a pnpm workspace — that meant the supply-chain gate
had been a no-op since adoption: every dependency it exists to inspect reached
a commit with no signal at all, while the tier reported the check green. A
silent stand-down in the single repo the gate runs in is indistinguishable from
having no gate, and it is worse than a loud one because the manifest, the
report and the tier all say the check ran.

pnpm v9 does carry a proof model, it is just not npm's. Each importer records
`specifier` (verbatim from the manifest) and `version` (what it resolved to)
per direct dependency, and `packages:` records one `resolution:` per
name@version. That is enough to bind a declared dependency to a resolution
without any registry or network access — and, unlike npm's `resolved` URL
fingerprints, it is a per-importer fact, so it extends to workspace
sub-manifests that the npm path never covered.

The constraint that shapes the implementation is that this tool imports only
`node:` builtins, in every consumer, from `vendor/`. There is no YAML parser
available and adding one is not an option; shelling out to `pnpm` would read
the working tree and break the DATA SOURCE INVARIANT.

### Decision

1. A tracked `pnpm-lock.yaml` selects a pnpm evaluation path. A tracked
   `yarn.lock` still stands the whole gate down — yarn has no proof model here,
   and mis-flagging is worse than a documented absence.
2. The npm path (`evaluate`) is left byte-identical and keeps its tests. pnpm
   gets a sibling evaluator reusing only the format-agnostic helpers. No
   abstraction over two lockfile-proof models is introduced for two
   implementations that share no shape; a third package manager may revisit it.
3. `pnpm-lock.yaml` is read by a hand-written parser restricted to an explicit
   v9 subset. Its refusal list — unknown `lockfileVersion`, tabs, anchors,
   aliases, tags, block scalars, merge keys, flow collections other than the
   empty-importer `{}`, duplicate importer/section/dependency keys, comments,
   and ANY line it cannot classify — throws `OperationalError` (exit 2). The
   refusal list is pinned by tests, not only by the header: skipping an
   unrecognised line is the one change that would convert this gate into a
   silent pass, so a future format shift must break commits loudly.
4. The proof is two-sided. Manifest side: an allowed spec plus a matching
   importer declaration. Lock side, requiring no manifest at all: every entry
   must have resolved to what its own specifier implies, an entry added or
   re-specified while its package.json stayed put is a lockfile-only injection,
   a `packages:` key whose resolution moved is the same version pointed
   elsewhere, and a `resolution:` carrying a `tarball:` or a URL is a
   redirection. The lock side is what makes a lock-only commit provable.
5. `workspace:` and `catalog:` specs are accepted by the grammar — they cannot
   reach outside the repository — but bound to the resolution each really
   produces. Moving an EXISTING dependency from a registry range onto
   `workspace:`/`catalog:` is still reported: it replaces published code with
   repo-local code, which is a review question even though it is not a remote
   swap.

### Consequences

- pnpm mode is only as strong as the consumer fileset that triggers it. A
  fileset listing a hand-maintained subset of manifests leaves the rest
  unchecked while the tier still reports green — exactly the failure this ADR
  removes. `**/package.json` plus `pnpm-lock.yaml` is therefore the required
  trigger, seeded in `templates/consumer/quality.starter.json` and stated in
  `docs/ADOPTION.md`.
- A tracked `package.json` that is NOT a pnpm workspace member gets its new
  deps reported as unpinned, because the tool cannot distinguish it from a
  workspace package whose lockfile was never regenerated. Such paths are
  excluded consumer-side, in the fileset.
- An unparsable HEAD lockfile is a FINDING, not exit 2 and not silence: the
  object under test is the STAGED lock, which is still read strictly, so the
  commit is fully judged; what is lost is the drift baseline, and a defect in
  history must not block every commit until history is rewritten.
- `link:` targets are confined lexically to the repository (the DATA SOURCE
  INVARIANT forbids asking the filesystem, and a path that escapes lexically
  escapes in fact), so a `workspace:` spec cannot be resolved to a directory
  outside the repo by editing the lock.
- The gate now reads one extra blob (the HEAD lockfile) on any commit that
  stages the lockfile. Measured on a 13-importer, ~310 KB lockfile the parse is
  ~3 ms and the whole check stays in its ~0.2 s class.

---

## ADR-028 — Shared deep-review core with adaptive tiered topology

- **Status:** Accepted
- **Date:** 2026-07-25 (renumbered from ADR-026 on merge; 026/027 were taken on
  `main` while this work was on its branch)
- **Owner decision** (repo owner, 2026-07-25)
- **Scope:** Both deep-review runtimes (Claude and Codex).
- **Amends:** ADR-003/010 (one shared core body now sits under both canonical
  runtime bodies), ADR-012/016 (the transcript Stop gate keeps anchoring only
  `review-contract.md` + required reads; each adapter enforces its own
  fail-closed core read), ADR-018/020 (the mandatory non-collapsible 8-route
  fan-out is replaced by adaptive triggered discovery), ADR-024 (the
  cost/benefit carve-out survives inside the merged triage+plan pass), and
  **supersedes the ADR-025 topology** (six fixed stages, ≥2-default-3
  reviewers, one monolithic integration worker, Codex-workers-only without
  exception). ADR-025's naming, consent, main-context-floor, and
  workers-exchange-paths rules stay in force.

### Context

The first full Codex-runtime run (PR #83, 2026-07-25) took 12h05m, dispatched
42 workers, and consumed roughly 60% of the weekly Codex usage limit for one
review. The process retrospective and an independent utility audit attribute
the cost to structural mandates, not defects: an unconditional 8-route (dual
fleet: 16) fan-out regardless of diff shape, inherited transcripts in 31 of 42
workers, a monolithic integration worker serializing 16 per-finding commits,
duplicated full-verify runs, and re-running the pipeline after head drift.
The owner requires the process to stay recall-safe on risk lenses while
scaling its cost to the diff actually under review.

### Decision

1. **Shared core + thin adapters.** Every runtime-shared rule lives once in
   `agents/skill-sources/deep-review-core.md`; each canonical runtime body is
   an adapter whose FIRST executable instruction resolves the dev-standards
   root, reads the core, and fails closed if it is missing. Frontmatter and
   wrapper metadata stay frozen; the composed core+adapter text is the
   contract the runner tests pin.
2. **Entry tiers.** The tier is fixed up front by the entry path and the
   user's explicit choice (each adapter binds its defaults), recorded with
   its inputs in the run artifacts: LIGHT (1-2 workers, review-only),
   STANDARD (3-5, review-and-refactor), DEEP (7-9, full topology, explicit
   opt-in only — never auto-selected, never silently escalated mid-run).
   Direct Codex invocation = STANDARD; LIGHT is an explicit choice for a small,
   low-risk diff; the Claude runtime keeps its run-setup ask. The process is
   invocation-gated throughout — the ADR-019 amendment of 2026-07-31 retired the
   automatic post-feature offer, so no tier is ever entered by an offer.
3. **Adaptive discovery.** The unconditional 8-route fan-out is replaced by a
   deterministic trigger table; ANY uncertainty triggers the route. Risk
   routes (security, correctness/lifecycle, tests-quality) stay
   differentiated workers; the five structural lenses run as ONE combined
   route at reduced effort. The 8-row coverage matrix survives with a new
   `NOT_TRIGGERED(+reason)` state, so a skipped lens is visible and
   deterministic, never silent.
4. **Merged triage+plan, deterministic-first verification.** One
   consolidation+estimation pass. Claims checkable by AST/grep/CodeGraph are
   verified deterministically; model falsification is reserved for P1/P2,
   PARTIAL/uncertain, and disputed claims; P3 is sample-verified; a 0-INVALID
   large cohort triggers a falsification audit, never a precision claim.
5. **Serialized thematic chunks.** A fresh worker per 2-4 same-seam findings
   authors and self-reviews, and each fix lands through `commit-slice` one
   finding at a time (each adapter binds which actor executes the CLI call).
   No monolithic integration worker; parallel authoring only with proven
   disjoint ownership in isolated worktrees/patch-only.
6. **One cross-family final reviewer.** ONE fresh read-only reviewer from the
   other runtime family (Codex run → Claude reviewer and vice versa;
   fallback = same-family + explicit disclosure). A second reviewer only on
   defined risk triggers. One bounded repair pass with targeted re-review of
   affected hunks; exactly ONE final `verify` on the final HEAD at the gate
   tier (`--full` default; `deep_review.verify_after_fix` per ADR-013), its
   attestation reusable while head, toolchain pin, deps lock, and env
   contract are unchanged.
7. **Deterministic Stage 0 preflight.** Before any model dispatch: head/base
   pin + non-mutating merge-tree, commit-slice compatibility smoke, worktree/
   deps attestation, env-contract presence (names only), findings-schema
   check, baseline fast verify. Infra red → `infra-blocked`, never
   `fix-failed`; head drift → delta-revalidation of changed files, never a
   full pipeline rerun.
8. **Caps, effort ladder, telemetry.** Hard caps (DEEP ≤9 workers, discovery
   ≤3 routes + structural, reviewers ≤2, repair 1, final verify 1, route retry
   1) and budget fail-fast before dispatch. Top reasoning effort only for
   security/correctness discovery, P1/P2 falsification, and final review.
   `run.json` records per-worker model, effort, fork mode, prompt bytes,
   duration, and finding IDs; the retrospective stage is opt-in.

### Consequences

- Cost scales with the diff: a docs-only change no longer buys an 8-route
  fan-out. Recall risk is concentrated where triggers could misfire; the
  conservative table (uncertain → trigger) plus the visible `NOT_TRIGGERED`
  matrix rows are the mitigations, and the first real run at this topology is
  the evaluation gate — usage reduction is a forecast until its telemetry
  lands (baseline: 42 workers / 12h05m, 2026-07-25).
- The Codex runtime's workers-only rule gains one named exception (the
  cross-family final reviewer); the fallback path discloses when a review was
  not cross-family.
- Consumers pick the new topology up through a pin bump; wrappers, skill
  names, and descriptions are unchanged, so no reseeding is needed.
