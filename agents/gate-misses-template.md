# Gate-Miss Ledger

Append-only ledger of defects that a deterministic `verify` check could or
should have caught, but that reached a later stage instead (Gate C review,
deep-review, runtime, a user report). Copied into a consumer repo as
`.agents/gate-misses.md` at onboarding; entries are counted by the
calibration session (`docs/CALIBRATION.md` in dev-standards) as the
**escape rate** — the primary signal that the gate configuration needs
tuning.

This ledger is disjoint from `.agents/review-guides/`: guides teach a
reviewer judgment; this file records gaps a machine gate should have closed.

## Entry format

Append one checklist line per miss, newest at the bottom of `## Pending`:

```text
- [ ] <date> <stage-found> - <one-line defect> (class: check-missing |
  too-narrow | report-only-ignored | wrong-tier) → <fix route>
```

- `<stage-found>` — where the escape surfaced: `gate-C`, `deep-review`,
  `runtime`, `user-report`.
- `class` — why the gate did not fire: no check exists (`check-missing`),
  a check exists but its rule/scope missed this (`too-narrow`), a
  report-only check fired and was ignored (`report-only-ignored`), the
  check runs in a tier the workflow skipped (`wrong-tier`).
- `<fix route>` — `consumer:<quality.json tweak / guide rule>` or
  `core:<analyzer/runner/schema change>`. A core route also gets a
  mirrored line in dev-standards `inbox/review-promotions.md` (processed
  only in a core session); reference it here.

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
- a **core fix** closes when the mirrored inbox entry is promoted and the
  consumer pin is bumped past it.

## Pending

## Closed
