# dev-standards backlog

Non-blocking, dated. Newest first.

## 2026-07-10 — Descriptor-relative confinement for skill-wrapper generation

**Deferred from the core-hardening Gate C round (finding #1, P1).**

`generate-skill-wrappers.ts` confines every wrapper write/delete with an
`assertConfined` lstat-walk preflight plus a `wx` (O_EXCL, no-follow) leaf create
and no-follow `rename`. This defends **static** symlink attacks: a symlinked
skills dir or a symlinked `SKILL.md` is refused, and the leaf is never followed.

It does **not** defend a **concurrent-swap TOCTOU**: a local process that replaces
`dir` (or an ancestor) with a symlink *between* the `assertConfined` preflight and
the subsequent `mkdirSync` / `writeFileSync` / `renameSync` / `rmSync` can still
redirect the operation outside the target root. The orphan-cleanup `rmSync` path is
the most dangerous (deletion through a swapped inode).

**Decision:** out of scope for the trusted single-user pilot — exploiting it needs a
local adversary running concurrently during generation, and the static-symlink
attack (the realistic one) is already closed.

**Upgrade path (when the threat model widens):** perform the create/rename/unlink as
**descriptor-relative, no-follow** operations (`openat`/`unlinkat`/`renameat` under
verified directory handles, or `O_NOFOLLOW` fds), and re-check the generated-marker
on that same inode rather than by path. **Effort:** M (rewrite the write/delete core
around fd-relative syscalls; Node needs `fs.opendir`/`dir`-fd plumbing or a small
native/`node:fs` `openat` shim).

## 2026-07-10 — Remove the workflow (L3) subsystem entirely

**Decision (owner):** drop the workflow feature from dev-standards altogether.

**Why.** The workflow engine is built around an autonomous, **write-capable
Codex "reviewer seat"** (ADR-008): a second-model agent that reviews, commits
trailers, and drives the feature state machine forward on its own. That is the
opposite trust model from how these standards are actually used — **Codex is a
read-only advisor; a human/Claude producer verifies and commits** (the
Cross-Check Gates). The subsystem is therefore adopted-disabled by the first
pilot (ai-prompter sets `workflow.enabled:false`) and is expected to stay off.
Meanwhile it carries the largest defect + maintenance surface in the repo
(the deep review found 21 P1s concentrated in `workflow/`: STATE-across-worktrees,
lock split-brain, git option-injection, secret-in-history, fail-open scanners),
none of which is worth fixing for a feature no one runs. Removing it also
realigns the code with the README's stated "Phase 1a Scope" (runner +
disabled-workflow manifest only), which the built-out workflow silently
contradicts (INT-05).

**Scope of removal (do at execution time, not now):**
- Delete `workflow/src/**`, `workflow/dist/`, `tests/workflow/**` (~261 tests),
  the `build:workflow` esbuild target, and the workflow globs in the `test`
  script (`package.json`).
- Remove the `workflow` block from `schemas/quality.schema.json` (ADR-012) and
  `validateWorkflow` + reviewer-independence checks from `runner/src/validate.ts`.
- Drop workflow-only config fields (`cmux_mode`, `loopback_mode`,
  `reviewer_independence`, ship/notify, workflow timeouts/budget).
- Prune workflow references from `agents/` (skill-catalog, skill-sources) and
  fix/retire ADR-008 / ADR-012.
- **Verify deep-review does not import from `workflow/`** before deletion; if it
  shares a util, lift the util into `runner/` or `deep-review/` first.
- Update README to match (it already claims workflow is unimplemented).

**Effort:** L (large deletion + schema/validator surgery + doc realignment).
**Blocks nothing.** Does not affect the runner (L1) or deep-review adoption.
Independent of the in-flight core-hardening batch (which already leaves
`workflow/` untouched).

## Related core-backlog (from ai-prompter pilot, non-blocking)

- Commit an ADR decision log — ADR ids/§ currently hang inline in code with no
  canonical record.
- Resolve ADR-011 "review-chain" naming collision with the downstream
  `codex-chain` skill.
