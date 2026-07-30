# Calibration playbook — turning telemetry into gate decisions

Status: **live playbook and append-only session log**.

A recurring micro-session (every 1–2 weeks, and before ANY report-only →
blocking flip) that converts accumulated evidence into configuration
decisions. Historical telemetry design:
`docs/plans/archive/2026-07-10-effectiveness-plan.md`.

## Inputs

1. `node tools/quality-stats.mjs` — per-`(repo, tier, check, branch)`
   aggregates over `~/.local/share/dev-standards/events.jsonl`
   (catch-candidates, noise, bypasses, durations, flip/prune candidates).
2. The consumer's `.claude/gate-misses.md` — escapes since the last session.
3. dev-standards `inbox/review-promotions.md` — pending rule candidates.
4. `agents/review-guide-templates/TRACEABILITY.md` — the profile canary
   registry + guide→profile migration table (ADR-018): stale ownership or
   an orphaned section surfaces here.

## Session steps

0. **Generate + open the visual report** for a quick shape-of-the-data pass
   before the detail work: `node tools/quality-report.mjs --path
   ~/.local/share/dev-standards/events.jsonl --out /tmp/quality-report.html
   --open`. Skim the KPI cards, the daily pass/blocked/aborted bars, and which
   checks carry `⚑ flip` / `✂ prune` badges — then dig into the exact numbers
   with quality-stats below.
1. Run quality-stats; read the candidate sections.
2. **Disposition every catch-candidate**: real catch / false positive /
   noise. This is a human judgment; only dispositioned catches count in
   the metrics. Note dispositions in the session summary (step 5).
3. Read pending gate-misses; verify closure proofs on entries closed since
   the last session (deterministic closures need the red→green note).
4. Decide, with the numbers as evidence:
   - **flip** a report-only check to blocking — requires ≥1 real
     (dispositioned) catch AND 0 operational noise in the window;
   - **prune / demote** a check — 0 fails over the prune window is only a
     candidate signal; pruning a test or coverage gate additionally
     requires mutation/replay evidence that surviving gates catch the
     concrete mutations ("never failed" is not evidence — testing guide).
     Sanctioned mutation-evidence tool (JS/TS): StrykerJS, run on-demand at
     the prune decision and never wired into tiers; `--incremental` is
     acceleration between sessions only — the decision itself needs a fresh
     or `--incremental --force` run scoped to the guarded invariant, since
     incremental mode reuses prior results for unchanged mutants — exactly
     the ones a prune decision asks about;
   - **tune** `quality.json` (budgets, filesets, tiers) where durations or
     misses point at a structural gap;
   - **route misses**: consumer fixes applied in-session; core routes
     mirrored into the promotions inbox (core-session processing). Consumer-only
     review rules extend the package guides through same-named files in the
     optional `.claude/review-guides/` overlay; reusable rules change the package
     templates instead of copying them into each consumer;
   - **triage `judgment-missed` escapes per owning profile** (ADR-018):
     strengthen the profile's rule text, add the blinded canary to
     TRACEABILITY.md, and verify closure replays. Any profile-file edit since
     the last session gets a canary spot-check — its registered canaries must
     still be caught by a blinded run before the edit counts as safe.
5. Append a dated summary block below: decisions + the numbers that
   justified them + open questions. Entries are append-only.

## Metrics (definitions live in effectiveness-plan.md)

catch rate (dispositioned), escape rate (gate-misses/week by class), noise
(chronic report-only fails, bypass frequency, operational errors/timeouts),
cost (verify seconds per catch), trend (escape rate across sessions — the
loop's health indicator).

## Session log

<!-- append dated summaries below; never edit past entries -->

### 2026-07-15 — first calibration session

**Inputs.** `quality-stats` over `~/.local/share/dev-standards/events.jsonl`
(925 events, 0 malformed, 2026-07-10→07-15 ≈ 6d, flip-window 7d). No consumer
`.claude/gate-misses.md` reachable from a core session (pilot lives in a
separate repo — routed as an open question below). Inbox: 1 pending (DR-16
ordering-contract test guidance).

**Dispositions (core report-only checks; flip bar = ≥1 real catch AND 0
operational noise byp/to/err in the window).**

| check | runs | catch | byp | to | err | disposition |
|-------|------|-------|-----|----|----|-------------|
| eslint (fast+full) | 44 | 4 | 0 | 0 | 0 | **FLIP → blocking** |
| knip (full) | 20 | 1 | 0 | 0 | 0 | HOLD — bar met but thin (1 catch) + noisy-tool profile; watch next window |
| check-new-deps (fast) | 3 | 0 | 0 | 0 | 0 | HOLD — 0 catches (skip_if_empty), parked on the PR-CI index bridge |

The 4 eslint catches are all fail→pass on the same branch (a lint violation
surfaced, then fixed): `main` a899502→7999a6c (full+fast), `full` 0acf43d
(same-commit), `chore/comment-gate` b9d5867. Core was green at decision time
(`npm run lint` exit 0, `npm run knip` exit 0), so the flip does not turn
`verify` red.

**Decision.** Flipped core `eslint` (fast + full) report-only → blocking in
`quality.json` (kept `operational_exit_codes:[2]` so a config-error exit 2 stays
an unbypassable operational error, distinct from a lint finding). Everything
else held. Core-internal dogfood flip — the consumer seed is untouched, so no
seed-parity trigger.

**Not flipped (consumer-side, out of a core session's authority).** Pilot
`eslint`(fast 8 / full 6 catch, 0 noise) and `format-check`(11+7 catch, 0 noise)
are seed-flip *candidates*, but a seed flip changes a consumer-facing default
and needs the owner's friction appetite + the pilot's gate-misses ledger (the
pilot shows heavy mid-refactor lint churn — 30 fast-eslint fails — so blocking
adds real active-dev friction). Pilot `diff-coverage` (6 timeouts, 0 catch) and
`companion-tests` (15 bypasses — all legit "browser-only / refactor-only, no
unit surface") both fail the 0-noise bar; companion-tests is a fileset-tune
candidate (exclude browser-only paths), not a flip.

**Open questions / next session.**
- knip: revisit with ≥1 more window of catches before flipping (or demote-back
  path if it flaps).
- Seed/pilot eslint+format-check flip: an explicit owner decision (friction
  appetite) + read the pilot `.claude/gate-misses.md` — deferred.
- check-new-deps & diff-coverage flips stay coupled to their parked CI-bridge
  items (`docs/plans/backlog.md`) — decide together with, not before, blocking.

### 2026-07-16 — `comparisonLiterals` warn-ramp baseline (ADR-022)

**What shipped.** New gate `dev-standards/comparison-literals` (magic strings in
equality comparisons + `switch` cases). Seed + composition at error; the pilot
adopts it at `severity: "warn"` to measure before flipping.

**Measured baseline (pilot, live probe over the exact planned src globs/ignores,
ai-prompter SHA `00ccbedc`).** 71 in-scope src files → **40 hits across 15 files**.
Of 78 raw string comparisons (72 equality operands + 6 `switch` cases) the rule's
built-in exemptions removed 31 `typeof` and 7 empty strings, leaving 40 (34
equality + 6 switch — matches the Gate-P AST inventory). No `typeof`/empty/type-
declaration leaked through. Split:
- **~30 real magic strings** — engine state machine (`tracker.ts` ×10,
  `display-model.ts`, `jsonl.ts`), route/sink `case` discriminants
  (`stt-token.ts`, `console-sink.ts`), `logger` record kind, harness scenarios,
  locale (`seo.ts`/`site.ts`). Fix = a named const / union member.
- **~10 framework-canonical borderlines** — DOM `event.key` keybindings
  (`Annotator.tsx` ×4), `readyState === "ended"`, `protocol === "https:"`, Node
  `code === "ENOENT"`, vite build modes. Owner-decides in the flip pass: name
  them or add a `.key`/framework exemption if chronically noisy.

**Why warn, not error.** ~40 findings is real cleanup; the pilot's eslint check
carries no `--max-warnings`, so warn surfaces them without turning `verify` red.

**Flip-to-error exit criteria (a later calibration pass, owner-run).** Capture
the full warn list → classify EACH hit fix / rule-exemption / confirmed ceiling →
zero unexplained warnings → decide test-file scope (tests currently out of scope,
mirroring constants-home) → drop `severity: "warn"` from the pilot block → confirm
error severity + `verify --full` green.

**Rollback.** If adoption is operationally broken: revert the pilot preset block +
its pin. An upstream rule defect gets a corrective commit + a NEW tag — never a
retag of a published one.

### 2026-07-17 — `comparisonLiterals` flip-to-error executed (ai-prompter pilot, ADR-022)

**What happened.** The warn-ramp exit criteria (2026-07-16 entry above) are all
met; the pilot dropped `severity: "warn"` from its `comparisonLiterals({...})`
block, so the gate now runs at the seed/composition default (error). No seed or
composition change — those already ship at error.

**Exit criteria, each satisfied.**
- *Every hit triaged to zero.* All 40 baseline hits (plus 1 the warn list missed —
  `located !== "ambiguous"` in `tracker.ts`, a real magic string) were resolved by
  naming: each `===`/`!==`/`switch` literal became a named constant in a
  `src/constants/**` home (or a dedicated dep-free home, see caveat) or a union
  member. None needed a rule-exemption or a confirmed-ceiling waiver — including
  the ~10 "framework-canonical borderlines" (DOM `event.key`, `readyState`,
  `protocol`, Node `code`, vite modes): all read cleaner as named constants, so
  no `.key`/framework carve-out was added to the rule.
- *Test-file scope.* Tests stay OUT of scope (unchanged), mirroring
  `constants-home`. Extracting ~10 throwaway test-scaffold comparison strings adds
  no safety and churns fixtures; the flip covers `src` only.
- *Severity + green.* `severity: "warn"` param removed → default error; `./scripts/verify --full` green (13/13 blocking gates), eslint reports 0 `comparison-literals` and 0 warnings.

**One non-mechanical wrinkle (consumer-shaped, not a rule concern).** In
ai-prompter, `browser-adapters/src/stt/endpoint.ts` is deliberately dependency-
free and DOM-free (a Node Vite config imports it), so it can pull neither the
engine barrel nor a constants home that references DOM lib types. The
`protocol === "https:"` literal therefore went into a new dedicated
`browser-adapters/src/constants/url.ts` (no engine import, no DOM types) rather
than the package's main `constants/index.ts` (which uses `MediaStreamTrackState`
etc.). This is a placement decision inside the consumer's import graph — the rule
just asks for a named constant and is agnostic to which home; recorded so the next
adopter isn't surprised that "put it in the obvious constants file" can violate a
package's own dependency boundary.

**Net.** ADR-022's warn→error ramp is complete on the pilot. The rule ships at
error everywhere; the pilot is now aligned with the seed/composition default.
