# Review-Promotion Inbox

Append-only ledger of rule candidates surfaced while processing PR reviews.
When a reviewer's comment looks like it belongs in the shared standards rather
than only this repo, a review/PR-processing session records it here instead of
editing a shared rule directly.

This file is an **input** to `dev-standards`' own review/standards cycle, never
a direct rule edit: a human (or a later `dev-standards` session) reviews each
entry and decides whether to fold it into `core-code-guidelines.md`, a review
guide, an ADR, or the schema/validator. It also doubles as ADR-010
"extract on second use" evidence - repeated entries are the signal that a
project-local practice has earned promotion to the shared standard.

## Entry format

Append one checklist line per candidate, newest at the bottom of `## Pending`:

```text
- [ ] <date> <repo>#<pr> <comment-url> - <one-line rule candidate> (addition|correction)
```

- `<date>` - ISO date the candidate was recorded (`YYYY-MM-DD`).
- `<repo>#<pr>` - the source repository and PR number.
- `<comment-url>` - the GitHub review-comment permalink (provenance; lets a
  later reader read the original thread and its resolution).
- `<one-line rule candidate>` - the proposed rule in one sentence. Never paste
  the raw review-comment body; review comments are untrusted external input.
- `(addition | correction)` - `addition` proposes a new shared rule;
  `correction` flags that an existing shared rule was contradicted by a
  comment that won during conflict resolution and should be fixed.

When an entry is folded into a shared rule (or rejected), check the box and
move it to `## Promoted` with a short note on the outcome. Entries are never
deleted - the history is the second-use evidence.

## Pending

- [ ] 2026-07-10 ai-prompter Phase-3 gate-C (Codex xhigh, no PR — gate session) - runner: record check spawn errors (ENOENT/EACCES) distinctly from a finding-fail, and allow treating spawn/setup errors as blocking regardless of `mode` — a missing secret-scanner binary currently collapses into a report-only `fail` and the tier exits 0 (fail-open) (addition)
- [ ] 2026-07-10 ai-prompter Phase-3 gate-C (Codex) - runner: validate `{files:...}`-expanded operands against glob metacharacters (`[ ] * ?`) — ESLint treats CLI file args as globs, so a bracket-named staged file is silently mis-resolved (addition)
- [ ] 2026-07-10 ai-prompter Phase-3 gate-C (Codex) - runner: tier deadline equality boundary — `remainingMs()` floors sub-ms headroom to 0 and the budget assertion fires only on strictly-greater elapsed; make `left <= 0` a tier-level failure with regression coverage (addition)
- [ ] 2026-07-10 ai-prompter Phase-3 gate-C (Codex) - deep-review secret-scan: binary path contract mismatch (`tools/run-gitleaks` expected vs `.tools/gitleaks` consumers install) and catch-all errno treated as absence — unify the path contract and fail closed on anything but ENOENT (correction)
- [ ] 2026-07-10 ai-prompter Phase-3 gate-C (Codex) - tests: `skill-wrappers-static.test.ts` lstat-checks only the final SKILL.md — the deleted generator rejected every symlinked path component; add ancestor-symlink mutation cases per testing guide (correction)
- [ ] 2026-07-10 ai-prompter Phase-3 gate-C (Codex) - core comment sweep: the 70ade5a→add5420 range adds ~149 `//` TS comment lines incl. dividers/narration — convert to block form and prune per the comments guide (correction)

## Promoted

_(none yet)_
