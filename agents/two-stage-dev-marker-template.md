Two-stage development marker (ADR-019). This repo writes functional code in
Stage 1 — machine gates block, done = the repo's full verify tier green plus a
clean pre-commit — and applies the standards corpus at Stage 2
(deep-review-refactor). Write-time guide injectors (editor pre-tool hooks,
delegate-launcher preambles) key off this file's presence and stay silent in
this repo. It is a standard instance doc: bootstrap re-seeds it when absent
and the fast-tier `--check` requires it — opting a repo out of two-stage is a
standards decision (ADR-019), not a file deletion.
