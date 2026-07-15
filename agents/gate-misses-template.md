# Gate-Miss Ledger

Append-only ledger of defects that an earlier quality stage could or should
have caught, but that reached a later stage instead (Gate C review,
deep-review, runtime, a user report). Two kinds of escape share it: gaps a
deterministic `verify` check should have closed, and — since ADR-018 —
judgment escapes an owning review profile missed (`judgment-missed`).
Copied into a consumer repo as `.claude/gate-misses.md` at onboarding;
entries are counted by the calibration session (`docs/CALIBRATION.md` in
dev-standards) as the **escape rate** — the primary signal that the gate or
profile configuration needs tuning.

Guides/profiles still teach reviewer judgment elsewhere; this file records
only the ESCAPES, deterministic or judgment, so each gets an owner and a
closure proof.

## Entry format

Append one checklist line per miss, newest at the bottom of `## Pending`:

```text
- [ ] <date> <stage-found> - <one-line defect> (class: check-missing |
  too-narrow | report-only-ignored | wrong-tier | judgment-missed) → <fix route>
```

- `<stage-found>` — where the escape surfaced: `gate-C`, `deep-review`,
  `runtime`, `user-report`, `owner-review`.
- `class` — why the escape happened: no check exists (`check-missing`),
  a check exists but its rule/scope missed this (`too-narrow`), a
  report-only check fired and was ignored (`report-only-ignored`), the
  check runs in a tier the workflow skipped (`wrong-tier`), or the rule is
  judgment-owned and the owning review profile missed it
  (`judgment-missed`, ADR-018).
- `<fix route>` — `consumer:<quality.json tweak / guide rule>`,
  `core:<analyzer/runner/schema change>`, or `profile:<name>` (the owning
  review profile of a `judgment-missed` escape). A core or profile route
  also gets a mirrored line in dev-standards `inbox/review-promotions.md`
  (processed only in a core session); reference it here.

Capture triggers: Gate C sessions append automatically (codex-chain
Step 4.5 asks the mechanical question for every VALID finding); any session
fixing a runtime or user-reported bug appends a line manually.

## Closing an entry

Entries are never deleted — check the box and move the line to `## Closed`
with an outcome note. Rules:

- a **deterministic fix** (quality.json tweak, analyzer/rule change) closes
  ONLY with proof the gate now catches the escape: run the check against
  the RETAINED offending state — it passed (green) before the gate fix,
  which is the miss itself, and must FAIL (red) after; the corrected
  current state must stay green. Note both runs;
- a **guide-only fix** (judgment rule, nondeterministic) closes with the
  marker `(nondeterministic-fix: guide)` so stats can separate the two;
- a **`judgment-missed` fix** closes ONLY with both: (a) a canary entry for
  the escaped case in the owning profile's registry
  (`agents/review-guide-templates/TRACEABILITY.md` — canaries are BLINDED,
  never quoted in worker-facing profile bodies or briefs), and (b) a blinded
  replay — a worker running that profile over the retained offending state
  reports the case WITHOUT being told its location. Note both;
- a **core fix** closes when the mirrored inbox entry is promoted and the
  consumer pin is bumped past it.

## Pending

## Closed
