# Calibration playbook — turning telemetry into gate decisions

A recurring micro-session (every 1–2 weeks, and before ANY report-only →
blocking flip) that converts accumulated evidence into configuration
decisions. Effectiveness telemetry design: `docs/effectiveness-plan.md`.

## Inputs

1. `node tools/quality-stats.mjs` — per-`(repo, tier, check, branch)`
   aggregates over `~/.local/share/dev-standards/events.jsonl`
   (catch-candidates, noise, bypasses, durations, flip/prune candidates).
2. The consumer's `.agents/gate-misses.md` — escapes since the last session.
3. dev-standards `inbox/review-promotions.md` — pending rule candidates.

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
     concrete mutations ("never failed" is not evidence — testing guide);
   - **tune** `quality.json` (budgets, filesets, tiers) where durations or
     misses point at a structural gap;
   - **route misses**: consumer fixes applied in-session; core routes
     mirrored into the promotions inbox (core-session processing).
5. Append a dated summary block below: decisions + the numbers that
   justified them + open questions. Entries are append-only.

## Metrics (definitions live in effectiveness-plan.md)

catch rate (dispositioned), escape rate (gate-misses/week by class), noise
(chronic report-only fails, bypass frequency, operational errors/timeouts),
cost (verify seconds per catch), trend (escape rate across sessions — the
loop's health indicator).

## Session log

<!-- append dated summaries below; never edit past entries -->
