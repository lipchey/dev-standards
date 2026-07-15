# Pre-commit Checklist (template)

Starting structure for the checks contributors run before committing. The
onboarding seeder copies this file to `.claude/CHECKLIST.md`; replace each
fill-in prompt with repository-specific commands and rules, then remove this
paragraph.

Sections 1 and 2 map onto the two-stage doctrine (ADR-019): section 1 is
STAGE 1's floor — machine gates that block while writing functional code;
section 2 is STAGE 2's domain — judgment rules the deep-review profiles own,
applied at review, not held in the writer's head.

## 0. Load order

Fill in the short reading order for project facts, code conventions, relevant
review guides, and the change brief. Under ADR-019 keep the Stage-1 list
MINIMAL (facts + the change brief); the full standards corpus is Stage-2
review material, not a pre-write read.

## 1. Blocks the commit or push — hard gates (Stage 1)

List each blocking command, when it runs, and the failure it owns. Keep this in
sync with `quality.json`; do not describe a check as blocking unless automation
actually enforces it.

## 2. Does not block — review flags it (Stage 2)

List the judgment-based rules reviewers must apply because deterministic gates
cannot prove them. Link to the review profile that owns each rule instead of
duplicating its full text.

## 3. Project invariants — hard must

Summarize the few boundary, data, and safety constraints that every change must
preserve. Point to `project-facts.md` for the complete layer map and no-touch
zones.

## 4. Not enforced — manual verification required

Name important checks that remain manual, including the exact trigger and the
evidence a contributor must record. This section prevents absent automation
from being mistaken for coverage.
