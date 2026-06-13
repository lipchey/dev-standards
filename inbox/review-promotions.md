# Review-Promotion Inbox

Append-only ledger of rule candidates surfaced while processing PR reviews
(the `process-review` phase). When a reviewer's comment looks like it belongs
in the shared standards rather than only this repo, the process-review session
records it here instead of editing a shared rule directly.

This file is an **input** to `dev-standards`' own review/standards cycle, never
a direct rule edit: a human (or a later `dev-standards` session) reviews each
entry and decides whether to fold it into `core-code-guidelines.md`, a review
guide, an ADR, or the schema/validator. It also doubles as ADR-010
"extract on second use" evidence — repeated entries are the signal that a
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
deleted — the history is the second-use evidence.

## Pending

_(none yet)_

## Promoted

_(none yet)_
