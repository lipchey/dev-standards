# Correctness and Lifecycle Review Profile

You review ONLY through this lens: observable behavior, boundary and empty
cases, error semantics, async ordering, and acquisition/release symmetry across
every path. Do not turn naming, test design, type design, architecture, or
security concerns into findings from this profile unless they produce a
demonstrated runtime or lifecycle defect.

Template-Version: 3 (review-recall 2026-07-15)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

This profile carries the correctness/error-handling share of the repo-owned
`core-code-guidelines.md` baseline. Its stack lenses remain paraphrased from
`awesome-skills/code-review-skill` (MIT, pinned `f2fd4e57`) plus repo
experience, as attributed in `language-review-sources.md`. Its refactor
contract remains distilled as short paraphrased excerpts from
`ramziddin/solid-skills` (MIT, pinned `b113ce68`) `code-smells.md` and
`complexity.md`; the old tech-debt classification and execution-order material
is the repo's own material over industry-standard Fowler vocabulary.
The language material comes from that source's per-language guides,
`code-quality-universal.md`, `common-bugs-checklist.md`, and cross-cutting
async/error notes. The Node lens was written from universal material plus repo
experience because upstream has no dedicated lens for it.

## Conditionality

- Apply correctness and error-path rules at full strength on every production
  path. On one-off scripts and throwaway glue, correctness and safety still
  apply even when naming polish and test depth relax.
- Route stack checks by what the code actually is, not by extension alone. Do
  not apply React rules to server code or service abstractions to a throwaway
  script.
- Refactor behavior preservation is absolute wherever a change is called a
  refactor. A refactor changes structure, never observable behavior.

## Correctness

Judgment prompts:

- Does the change do what the plan/PR says, and only that? Scope creep beyond
  the stated intent is a finding even when each extra edit is individually
  harmless.
- Are the boundary and empty cases handled - empty input, zero/one/many, missing
  optional, first/last element, integer overflow, timezone/locale edges?
- Is every branch reachable and correct, or is there a dead branch, an inverted
  condition, or an off-by-one? Trace the non-happy path, not just the happy one.
- Does concurrent or async code have an ordering, race, or await-missing bug?
  Flag an unawaited promise, a shared mutable read-modify-write, or a check that
  can go stale before the act it guards.

## Boundary ownership cross-references

- External input validation at a trust boundary is owned by
  → see `profile-security.md` §Input validation at trust boundaries. The absence
  of any validation at an existing edge is a finding there.
- Public types, nullability, and documented pre/postconditions are owned by
  → see `profile-types-and-contracts.md` §Public contracts and optional values.
- Module-boundary leakage is owned by
  → see `profile-architecture-and-boundaries.md` §The dependency rule and
  boundary shape.

## Error handling

Judgment prompts:

- Is every fallible operation's failure handled, or is an error swallowed,
  logged-and-ignored, or caught too broadly (a bare `catch {}` that hides real
  faults)?
- On failure, does the code fail safe - no partial write left committed, no
  half-updated state, no resource leaked (file handle, lock, connection)? Prefer
  fail-closed on paths that guard data or access.
- Are error messages actionable and free of secrets/PII? A message that leaks a
  token or a full internal path is a finding. Secret exposure and attack impact
  are owned by → see `profile-security.md` §Secrets.
- Is `only ENOENT means absent` (and similar) respected - is a specific expected
  error distinguished from every other errno, rather than treating all errors
  as the benign case?

Security-specific fail-closed, timeout, process-group, and path-confinement
rules are owned by → see `profile-security.md` §Fail closed and
§Path confinement.

## Cross-cutting correctness checks

Apply these with whichever stack section is loaded:

- **Off-by-one / boundaries.** Are first/last element, empty input,
  zero/one/many, and inclusive-vs-exclusive bounds all handled? The non-happy
  path is where these hide.
- **Resource leaks.** Is every handle, socket, subprocess, timer, and listener
  released on ALL paths, especially the error path? A leak survives the happy
  path and only shows under load.
- **TOCTOU.** Is `if exists → act` replaced by `try act → catch`? The state can
  change between the check and use; act and handle failure. Hostile-writer
  filesystem confinement is owned by → see `profile-security.md` §Path
  confinement.
- **No-op update / redundant state.** Does a poll/interval/handler write
  unconditionally even when nothing changed, or store a field derivable from
  others? Both cause churn and staleness.
- **Historical regression.** Blame the PRE-change lines
  (`git blame <base> -L`) or pickaxe removed code (`git log -S/-G`). Did a prior
  commit deliberately set it the other way - a bug fix, guard, or workaround?
  Re-breaking or reverting that intent is a regression the current-state view,
  CodeGraph included, cannot see. Blaming post-change lines shows only this
  diff, not the intent it overwrites.

Optional-value flow belongs to
→ see `profile-types-and-contracts.md` §Public contracts and optional values.
Reuse-before-writing and over-broad reads belong to
→ see `profile-module-depth.md` §Cross-cutting structural checks.

## Stack routing

Pick the single matching section for each surface and apply the cross-cutting
checks above alongside it. If a file mixes stacks, review each part with its
own lens. Record the loaded stack lens with each finding.
Adopting repos may add rows for their own stacks; every row points to exactly
one matching section.

| Surface under review | Load this section |
| --- | --- |
| TypeScript service / shared module (long-lived) | §TypeScript shared module / service |
| Script-style TS / one-off pipeline | §Script-style TS / one-off pipeline |
| React / UI (`.tsx`, hooks, components) | §React / UI TS |
| Node / backend TS | §Node / backend TS |

### TypeScript shared module / service

Every promise should be awaited; strict async correctness carries the weight
here.

- Is every promise awaited, returned, or deliberately detached WITH a rejection
  handler (`.catch(...)`)? A floating promise leaves its rejection unhandled (a
  process-level `unhandledRejection`) and reorders effects - and `void promise`
  only silences the linter, it attaches no handler, so the rejection stays
  unhandled at runtime.
- Does an `await` inside a `try` actually settle before the block exits, so the
  `catch` can see the rejection? Returning a promise from `try` without awaiting
  leaks the error past the handler.
- Does `Promise.all` fail the whole batch on one rejection where partial success
  was intended (use `allSettled`), or vice versa? The two have opposite error
  semantics.
- Are `===`/`!==` used everywhere, never `==`? Loose equality coerces and hides
  bugs.

Public `any`, exhaustive unions, boundary narrowing, readonly returns, and
typed error shapes are owned by
→ see `profile-types-and-contracts.md` §TypeScript shared module / service.

### Script-style TS / one-off pipeline

Correctness and readability outrank structure. Expect direct top-level flow,
explicit exit codes, and top-level `await` in an ESM module.

- Does the script exit non-zero on failure (throw, or set
  `process.exitCode`), so a caller or CI sees the error? A swallowed failure
  that exits `0` is a silent-success bug.
- Is a top-level `await` rejection handled, so the failure prints something
  actionable rather than a bare `UnhandledPromiseRejection`?
- Apply the shared-module floating-promise/missing-`await` rule; it still bites
  in scripts.
- Is the script safe to rerun after a partial failure? A step that appends
  without a guard, fails with "already exists" on a rerun, or resumes from
  leftover temporary/partial state makes the rerun itself the bug. Make each
  step idempotent or guard it explicitly.

Validation of `process.argv`/`process.env` at the trust boundary belongs to
→ see `profile-security.md` §Script-style TS / one-off pipeline.

### React / UI TS

Hooks correctness and effect discipline dominate; performance hooks are a last
resort, not a default.

- Are all hooks called unconditionally at the top level, never in an `if`, loop,
  or after an early return? Conditional hooks corrupt hook order.
- Does every `useEffect` list every REACTIVE value it reads (props, state, and
  values derived from them) in its deps, AND return a cleanup for each
  subscription/timer/in-flight fetch its setup starts? Only module constants and
  stable ref objects/state setters returned by THIS component's own hooks may be
  omitted; a ref or setter received via props is itself a reactive prop. An
  incomplete dep array reads stale state; missing cleanup leaks or races.
- Is `useEffect` used to compute derived state or respond to an event? Derive
  during render (or `useMemo`); put event side-effects in the handler. An effect
  for either causes an extra render or lag.
- Is any component defined inside another component's body? It gets a new
  identity every render and remounts its subtree.
- Are inline objects or functions passed as props to a `React.memo` child? They
  break memo - hoist them, or wrap in `useCallback`/`useMemo`.
- Does a list `key` use a stable id rather than array index when the list can
  reorder or insert? Index keys mis-associate state on reorder.
- For RSC/Next only: is `'use client'` at the smallest leaf that needs
  interactivity, not a layout/parent that drags the whole tree client-side? Does
  any Server Component use `useState`/`onClick`? Is `useFormStatus` inside a
  child of `<form>`, not the same component?
- Does a data-fetching effect cancel stale requests (an `AbortController` or a
  `cancelled` flag), so a slow earlier response cannot overwrite a newer one?
- Is optimistic UI (`useOptimistic`) used for an irreversible or money/critical
  action? It should not be; those need the confirmed result.

### Node / backend TS

The live risks are event-loop stalls, unbounded memory, and startup/shutdown
correctness.

- Is any CPU-bound or synchronous call (large `JSON.parse`, crypto,
  `fs.*Sync`) on the request/event-loop path? It stalls every concurrent
  request - move it to a worker or the async API.
- Are large payloads streamed with backpressure (pipe, or honor `write()`
  returning `false`), or buffered whole into memory? An unbounded read is a
  memory-exhaustion DoS at a file/network boundary.
- Does the service handle shutdown signals - stop accepting, drain in-flight
  work, close DB handles - so a deploy neither drops work nor leaks
  connections?
- Does every stream and `EventEmitter` have an `'error'` handler? An unhandled
  `'error'` event crashes the process.
- Are errors handled with context, never by a bare `catch {}` that hides a
  fault?
- Is retryable job or service work idempotent or keyed, so a retry cannot
  duplicate an insert, POST, notification, or other side effect?

Typed startup config and typed error shapes are owned by
→ see `profile-types-and-contracts.md` §Node / backend TS and §TypeScript shared
module / service. Hostile resource-exhaustion paths are also reviewed through
→ see `profile-security.md` §ReDoS and resource exhaustion.

## Behavior preservation during refactors

A refactor changes structure, never observable behavior.

- **Keep behavior tests green, unmodified.** A behavior/contract test that had
  to change to pass means behavior changed. **Check:** would the current suite
  pass as-is after this change? If a BEHAVIOR test had to change, it is a
  feature/fix, not a refactor - review it as one. Exception: a test coupled to
  internal structure (a mock mirroring the old call sequence, an import of a
  moved private) may legitimately be replaced during a refactor, with evidence
  observable behavior is unchanged and that coupling recorded as its own
  finding in `profile-tests-quality.md`.
- **Preserve inputs->outputs and effects at every boundary.** The error path is
  behavior too. **Check:** are return values, thrown error types, log lines, and
  side-effect shape identical before and after - on failure paths, not just the
  happy one?
- **Reject ride-along behavior changes.** A mixed diff is unreviewable.
  **Check:** did a "while I was in here" fix or tweak sneak in? Split it into
  its own reviewed change; a behavior-change-plus-refactor diff is a finding.

Characterization-test sufficiency is owned by
→ see `profile-tests-quality.md` §Test-cover before a refactor. Atomic slicing and
execution order are owned by
→ see `profile-refactoring-and-smells.md` §Small atomic refactor steps.

## Output

Follow `review-contract.md` exactly. Evidence should trace a concrete input and
path to the wrong output, stale effect, unreleased resource, or changed
observable contract. Report every applicable instance and include the required
per-file `COVERAGE`/`CLEAN` claims. When the behavior and lifecycle surface is
clean, say so explicitly.
