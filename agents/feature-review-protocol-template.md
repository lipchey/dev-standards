# Feature & review protocol - adopting-repo template

Copy this into the adopting repo and fill the `<...>` placeholders. It wires
the repo into the dev-standards feature/review workflow. It is a pointer, not
a copy: the process-review judgment rules live once in the canonical body and
must not be duplicated here (ADR-003 / ADR-010 single-source).

## Rule set (fill in for THIS repo)

The process-review phase checks every review comment against this repo's rule
set. Record where those rules live:

- `<this-repo>/<path-to>/core-code-guidelines.md` - shared code baseline.
- `<this-repo>/<path-to>/<review-guides>` - this repo's review guide(s).
- `<this-repo>/<path-to>/<dev-standards-adaptation>` - this repo's adaptation
  of the shared standards.

## Session triggers

This repo has two feature-workflow session triggers:

1. Build / ship a feature - the build session (plan, implement, quality pass,
   review chain, then `workflow ship`). A green or no-CI ship emits
   `ready_for_review`.
2. Process a submitted PR review - the human-triggered process-review
   session. Triggers: "process review" / "оброби ревью".

## Canonical body (do not copy, point)

The process-review phase - its ordered judgment steps, the mandatory
untrusted-input clause, and the CI-red ship judgment - is defined once in:

```text
<dev-standards>/agents/skill-sources/process-review.md
```

Read it there. Do not copy it into this repo; the runtime skill wrappers
point at that file.

## Session-protocol section (ready to paste)

Paste the following into this repo's session protocol so every session
honors the workflow contract. It mandates the start-of-session cleanup sweep,
the worktree question, and the two triggers above.

```markdown
### Feature workflow (per session)

1. Cleanup sweep first. At the START of every session, and on demand, run
   `workflow cleanup`. It sweeps merged features (archive a slim summary,
   remove branch and worktree, drop the record) and leaves open, awaiting,
   or ci_failed features untouched. Run it before starting new work.
2. Worktree question at start. When starting a feature, answer one question:
   separate worktree for this feature? Pass the answer to
   `workflow feature-start <slug> [--worktree]` (`--worktree` means yes; omit
   it to work in place).
3. Two triggers.
   - Build / ship: the build session ends at `workflow ship`, which emits
     `ready_for_review` on green or no-CI.
   - Process review: a session triggered by "process review" / "оброби
     ревью" runs the process-review phase (see the canonical body) and ends
     at the re-ship, which emits `work_finished`.
```
