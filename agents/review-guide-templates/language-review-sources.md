# Language Review Sources (review guide template)

Template-Version: 2 (guides-revamp 2026-07-11)

STARTING template: each adopting repo copies this into `.claude/review-guides/`
and then owns its final body. The prompts below are review-only JUDGMENT
PROMPTS for a human or reviewing agent — they say what to look for and how to
weigh it, never an instruction to edit.

Provenance: lenses distilled (paraphrased excerpts, no verbatim blocks) from
`awesome-skills/code-review-skill` (MIT, pinned `f2fd4e57`) — its per-language
guides, `code-quality-universal.md`, `common-bugs-checklist.md`, and the
cross-cutting async/error notes. Shell, n8n, and Node lenses are written from
that source's universal material plus repo experience (upstream has no
dedicated lens for them). Repo-agnostic: adopting repos add rows and sections
for their own stacks.

## Purpose: a router, not a checklist

This file is a DISPATCH TABLE, not one exhaustive per-language list. Identify
the surface under review, then load ONLY the one section that matches it and
ignore the rest. Loading every lens at once produces noise and cross-language
false positives — a React rule fired at a Bash script is not a finding, it is
a distraction. Conditionality is the whole point: a TypeScript service, a
React UI, and Bash/n8n glue each get a different lens, never the same blanket
checklist.

The `## Cross-cutting` section below is the one exception — its bug classes
apply WITH every lens, not instead of one.

## Dispatch table

Each row points at exactly ONE embedded `##` section in THIS file. Pick the
single matching row for the surface, load that section, stop.

| Surface under review                              | Load this section                    | This lens is NOT the fit when                         |
| ------------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| TypeScript service / shared module (long-lived)   | `TypeScript shared module / service` | the file is really a one-off script (use the row below) |
| Script-style TS / one-off pipeline                | `Script-style TS / one-off pipeline` | the module is a reused service (use the row above)    |
| React / UI (`.tsx`, hooks, components)            | `React / UI TS`                      | reviewing server-only or CLI code                     |
| Node / backend TS (server, daemon, CLI runtime)   | `Node / backend TS`                  | the code is browser/UI React                          |
| Bash / shell glue                                 | `Bash / shell glue`                  | tempted to judge module depth or SOLID on glue        |
| n8n / workflow JS glue                            | `n8n / workflow JS glue`             | it is a real TS module, not an expression/Code node   |
| Python script                                     | `Python scripts`                     | —                                                     |

Adopting repos add rows for their own stacks; keep each row pointing at exactly
one section to load.

**This router routes stack lenses only.** It does NOT decide whether an area
guide (`clean-architecture.md`, `architecture-deepening.md`,
`refactoring-checklist.md`, `security-review.md`) applies — that call belongs
to each area guide's own conditionality banner (deep-review-refactor skill,
review-only step 4c), never to this table. Do not re-add cross-guide
load/skip directives here.

## How to use this router

1. Identify the surface — one file or one slice at a time, by what the code
   actually is, not by its extension alone (a `.ts` can be a service or a
   throwaway script).
2. Pick the single matching row and load only that section.
3. If a file mixes stacks (a TS wrapper around a shell call, a Code node with
   real logic), review each part with its own lens; do not blanket-apply one.
4. Apply the `## Cross-cutting` bug classes alongside whichever lens you loaded.
5. Record, with each finding, which lens you loaded — so a reviewer can see the
   conditional choice was deliberate and can challenge a mis-routed lens.

## Cross-cutting (apply WITH every lens)

Language-agnostic bug classes. These are not a lens of their own — run them on
top of whichever section you loaded, on any stack.

- **Off-by-one / boundaries** — Check: are first/last element, empty input,
  zero/one/many, and inclusive-vs-exclusive bounds all handled? The non-happy
  path is where these hide.
- **Null / undefined flow** — Check: is an optional read behind a guard, and is
  `arr[i]` / `map.get(k)` treated as possibly-absent? Indexed access is
  `T | undefined` under strict settings for a reason.
- **Resource leaks** — Check: is every handle, socket, subprocess, timer, and
  listener released on ALL paths, especially the error path? A leak survives
  the happy path and only shows under load.
- **TOCTOU** — Check: is `if exists → act` replaced by `try act → catch`? The
  state can change between the check and the use; act and handle the failure.
- **Reuse before writing** — Check: does this new helper/util/type duplicate one
  already in the repo (adjacent files, `shared/`, `utils/`)? Reinvented local
  code drifts out of sync.
- **No-op update / redundant state** — Check: does a poll/interval/handler write
  unconditionally even when nothing changed, or store a field derivable from
  others? Both cause churn and staleness.
- **Over-broad reads** — Check: does the code load a whole collection or file to
  use a slice? Push the filter/limit to the source (DB query, `readline`).
- **Historical regression** — Check: blame the PRE-change lines
  (`git blame <base> -L`) or pickaxe the removed code (`git log -S/-G`) — did a
  prior commit deliberately set it the other way (a bug fix, a guard, a
  workaround)? Re-breaking or reverting that intent is a regression the
  current-state view — CodeGraph included — cannot see. Blaming the post-change
  lines shows only this diff, not the intent it overwrites.

---

## TypeScript shared module / service

Long-lived, reused code. Strict typing and async correctness carry the weight
here; structure judgments escalate to the area guides.

**Idioms to expect:** strict `tsconfig` (`strict`, `noUncheckedIndexedAccess`);
`unknown` + narrowing at inputs, concrete types within; discriminated unions
for variant/result types with exhaustive handling; `readonly` on shared data;
typed errors carrying a `cause` chain; every promise awaited.

**Common bugs on this surface:** `any` on a public signature silently disabling
checks for all callers; a non-exhaustive `switch` over a union that compiles but
drops a new variant; a bare `as` cast masking a shape mismatch; a floating
promise (missing `await`) leaving its rejection unhandled; `Promise.all` where one
rejection should not abort the batch (or `allSettled` where it should); `==`
instead of `===`.

- Check: does any exported function accept or return `any`? An `any` at a public
  boundary disables type-checking for every caller — require `unknown` + a
  narrowing guard at the edge, concrete types within.
- Check: is every `switch`/`if` chain over a discriminated union exhaustive,
  with a `never`-typed default that fails to compile when a variant is added? A
  silent fallthrough ships an unhandled case.
- Check: is boundary data typed `unknown` and narrowed rather than asserted with
  `as`? A bare `as` cast is a claim the compiler believes without proof.
- Check: is every promise awaited, returned, or deliberately detached WITH a
  rejection handler (`.catch(...)`)? A floating promise leaves its rejection
  unhandled (a process-level `unhandledRejection`) and reorders effects - and
  `void promise` only silences the linter, it attaches no handler, so the
  rejection stays unhandled at runtime.
- Check: does an `await` inside a `try` actually settle before the block exits,
  so the `catch` can see the rejection? Returning a promise from `try` without
  awaiting leaks the error past the handler.
- Check: does `Promise.all` fail the whole batch on one rejection where partial
  success was intended (use `allSettled`), or vice-versa? The two have opposite
  error semantics.
- Check: are shared or returned arrays/objects `readonly` where callers must not
  mutate them? A mutable return invites action-at-a-distance.
- Check: do thrown errors carry a typed shape and a `cause`, or is context lost
  by re-throwing a bare `Error(string)`?
- Check: `===`/`!==` everywhere, never `==`? Loose equality coerces and hides
  bugs.

---

## Script-style TS / one-off pipeline

Lighter tier: correctness and readability over structure — a one-off does not
owe you an abstraction (structural rules stay with the area guides' own
banners, which already downgrade this surface).

**Idioms to expect:** direct top-level flow; `process.argv` / `process.env`
parsing up front; explicit exit codes; top-level `await` in an ESM module.

**Common bugs on this surface:** unvalidated `argv`/`env` used deep in the
logic; failure that still exits `0`; an unhandled top-level rejection printing
only a bare stack; the same floating-promise / missing-await bugs as the
service lens.

- Check: are `process.argv` / `process.env` reads validated (present, right
  shape) at the top, or does a missing arg become `undefined` deep in the
  logic? A one-off still crosses a trust boundary.
- Check: does the script exit non-zero on failure (throw, or set
  `process.exitCode`), so a caller or CI sees the error? A swallowed failure
  that exits `0` is a silent-success bug.
- Check: is a top-level `await` rejection handled, so the failure prints
  something actionable rather than a bare `UnhandledPromiseRejection`?
- Check: floating promises / missing `await` — the same as the service lens,
  these still bite in scripts.
- Scope note: this lens judges correctness and readability only; structural and
  abstraction judgments are out of its scope (the area guides' own banners
  already downgrade or exclude one-off scripts).

---

## React / UI TS

Hooks correctness and effect discipline dominate; performance hooks are a
last resort, not a default.

**Idioms to expect:** hooks called unconditionally at the top level; complete
effect dep arrays with cleanup; effects reserved for external synchronization
(subscriptions, imperative APIs), NOT for derived state or event responses;
derived values computed in render or `useMemo`; stable list keys; `memo` only
paired with stable props.

**Common bugs on this surface:** a hook in an `if`/loop; an incomplete effect
dep array (stale closure) or a missing cleanup (leaked subscription/timer/fetch
+ race); `useEffect` computing derived state (extra render); a component defined
inside another (remounts each render); inline object/function props defeating a
`memo` child; array-index keys on a reorderable list; RSC mistakes.

- Check: are all hooks called unconditionally at the top level (never in an
  `if`, loop, or after an early return)? Conditional hooks corrupt hook order.
- Check: does every `useEffect` list every REACTIVE value it reads (props,
  state, and values derived from them) in its deps, AND return a cleanup for
  each subscription/timer/in-flight fetch its setup starts? Only module
  constants and the stable ref objects / state setters returned by THIS
  component's own hooks may be omitted — a ref or setter received via props is
  itself a reactive prop. An incomplete dep array reads stale state; a missing
  cleanup for a created resource leaks or races.
- Check: is `useEffect` being used to compute derived state or to respond to an
  event? Derive during render (or `useMemo`); put event side-effects in the
  handler — an effect for either causes an extra render or a lag.
- Check: is any component defined inside another component's body? It gets a new
  identity every render and remounts its subtree.
- Check: are inline objects or functions passed as props to a `React.memo`
  child? They break memo — hoist them, or wrap in `useCallback`/`useMemo`.
- Check: does a list `key` use a stable id rather than the array index, when the
  list can reorder or insert? Index keys mis-associate state on reorder.
- Check (RSC / Next only): is `'use client'` at the smallest leaf that needs
  interactivity, not a layout/parent that drags the whole tree client-side? Does
  any Server Component use `useState`/`onClick`? Is `useFormStatus` inside a
  child of `<form>`, not the same component?
- Check: does a data-fetching effect cancel stale requests (an `AbortController`
  or a `cancelled` flag), so a slow earlier response cannot overwrite a newer
  one?
- Check: is optimistic UI (`useOptimistic`) used for an irreversible or
  money/critical action? It should not — those need the confirmed result.

---

## Node / backend TS

Server, daemon, or CLI runtime. The live risks are the event loop, unbounded
memory, and startup/shutdown correctness.

**Idioms to expect:** streaming with backpressure; CPU-bound work kept off the
event loop; config/env validated once at startup (fail fast); graceful shutdown
(stop accepting, drain, close handles); an `'error'` handler on every stream and
emitter.

**Common bugs on this surface:** synchronous or CPU-heavy work on the request
path; buffering a whole stream/file into memory instead of piping; ignoring
backpressure; no startup config validation (late `undefined` crash); no graceful
shutdown (dropped work, leaked connections); an unhandled stream `'error'` event
crashing the process.

- Check: is any CPU-bound or synchronous call (large `JSON.parse`, crypto,
  `fs.*Sync`) on the request / event-loop path? It stalls every concurrent
  request — move it to a worker or the async API.
- Check: are large payloads streamed with backpressure (pipe, or honor `write()`
  returning `false`), or buffered whole into memory? An unbounded read is a
  memory-exhaustion DoS at a file/network boundary.
- Check: is required config/env validated once at startup (present, parsed,
  typed), so the process fails fast instead of hitting `undefined` mid-request?
- Check: does the service handle shutdown signals — stop accepting, drain
  in-flight work, close DB handles — so a deploy neither drops work nor leaks
  connections?
- Check: does every stream and `EventEmitter` have an `'error'` handler? An
  unhandled `'error'` event crashes the process.
- Check: typed errors with a `cause`, and never a bare `catch {}` that hides a
  fault? (Baseline rule; re-check it here.)

---

## Bash / shell glue

Judge shell safety, error propagation, and idempotence. Module-depth,
structural, and DDD judgments are out of this lens's scope (the area guides'
own banners already exclude glue).

**Idioms to expect:** `set -euo pipefail` (with awareness of its limits); every
expansion double-quoted; `mktemp` + a `trap ... EXIT` for cleanup; exit codes
checked through pipes; portability to bash 3.2 when the repo targets macOS.

**Common bugs on this surface:** missing `set -euo pipefail`, or relying on `-e`
where it does not fire; unquoted `$var`/`$(...)` (word-splitting, globbing,
injection); a pipeline masking the producer's failure; predictable temp names or
no cleanup; bash-4-only syntax on macOS's bash 3.2; parsing `ls`.

- Check: does the script start with `set -euo pipefail`, and does any logic rely
  on `-e` where it does not fire: a command in an `if`/`while`/`until`
  condition, a `!`-negated command, any command in a `&&`/`||` list EXCEPT the
  one after the final operator, or a failure masked by the enclosing statement's
  status (`local x=$(cmd)` succeeds even when `cmd` fails — declare and assign
  separately)? Check the exit code explicitly in those contexts.
- Check: is every variable and command substitution double-quoted (`"$var"`,
  `"$(...)"`) unless word-splitting is deliberately wanted? Unquoted expansion
  splits and globs — a filename with a space or `*` breaks it, and external data
  injects arguments.
- Check: with a pipeline, is `pipefail` set (or the producer's status checked
  via `PIPESTATUS`) so `cmd | tee` cannot hide `cmd` failing? Without it a pipe
  reports only the last stage's status.
- Check: are temp files created with `mktemp` and removed by a
  `trap 'rm -rf "$tmp"' EXIT`? A fixed `/tmp/name` is a predictable-path /
  symlink race and leaks on an early exit.
- Check: does the script use bash-4-only features (`${x,,}`, `declare -A`,
  `mapfile`) while targeting macOS, whose default `/bin/bash` is 3.2? Pin the
  interpreter or stay portable.
- Check: is external input passed to `eval`, backticks, or an unquoted command
  position? Never `eval` untrusted data. (This is also a `security-review.md`
  boundary — that guide applies per its own banner.)

---

## n8n / workflow JS glue

Expression and Code nodes. The lens is item-mapping correctness, idempotence,
and secret hygiene — not module design.

**Idioms to expect:** expressions reference `$json` / `$node` for nodes that ran
on this path; a Code/Function node returns items in `[{ json: ... }]` shape with
cardinality matching its mode ("Run Once for Each Item" → one output per input;
"Run Once for All Items" → deliberate aggregation/filtering with item linking
kept); side-effecting nodes are idempotent or keyed; credentials come from n8n's
credential store, never inline.

**Common bugs on this surface:** a Code node returning the wrong shape or
dropping items; an expression referencing a node that did not run on this
branch (`undefined`); a non-idempotent side effect that a retry double-applies;
a token hardcoded in a Code node or expression; a node error aborting the run
with no error branch.

- Check: does a Code/Function node's output cardinality match its MODE and
  intent — "Run Once for Each Item" preserving one output per input, "Run Once
  for All Items" aggregating/filtering deliberately with item linking kept for
  downstream mapping? An UNINTENDED collapse or drop is the bug, not a count
  change per se. Return items in `[{ json: ... }]` shape rather than relying on
  n8n's auto-wrapping of bare objects.
- Check: does an expression assume a node ran on this execution path? A reference
  to a skipped branch's node yields `undefined` — guard it.
- Check: is every side-effecting node (HTTP POST, DB insert, email) idempotent
  or keyed, so an automatic retry does not double-apply it? Workflow retries
  replay the node.
- Check: are credentials pulled from n8n's credential store, never a literal
  token in a Code node or expression? An inline secret is exported and committed
  with the workflow JSON. (Also a `security-review.md` boundary — that guide
  applies per its own banner.)
- Check: do failure-prone nodes have an error output or handled `continueOnFail`,
  rather than aborting the run with no trace?
- Scope note: this lens judges item mapping, idempotence, and secret hygiene
  only; module-depth and structural judgments are out of its scope (the area
  guides' own banners already exclude glue).

---

## Python scripts

**Idioms to expect:** type hints on public functions; `pathlib` over string path
munging; `subprocess` with a list of args and `shell=False`; specific exception
catches with `from` chaining; a venv and pinned dependencies.

**Common bugs on this surface:** a mutable default argument (`def f(x=[])`) or a
shared mutable class attribute; a bare `except:` (catches `KeyboardInterrupt`)
or `except Exception: pass`; `is` for value comparison; `subprocess(...,
shell=True)` on interpolated input; string path concatenation; unpinned deps.

- Check: any mutable default argument (`=[]`, `={}`) or mutable class attribute?
  It is shared across calls or instances and accumulates state.
- Check: is every `except` specific — never a bare `except:` (swallows
  `KeyboardInterrupt`/`SystemExit`) or `except Exception: pass` (hides faults)?
  Catch what you can handle and re-raise with `from`.
- Check: does `subprocess` use a list of args with `shell=False`, never
  `shell=True` on interpolated input? (Also a `security-review.md` boundary —
  that guide applies per its own banner.)
- Check: are filesystem paths built with `pathlib`, not string concatenation —
  and, for EXTERNAL input, resolved (`Path.resolve()`) and boundary-checked
  before use? `pathlib` alone is only construction: joining an absolute operand
  discards the base, and `..` survives until `resolve()` (confinement rules:
  `security-review.md`).
- Check: is `is`/`is not` used only for `None` and singletons, and `==` for
  values? `x is 1000` is a small-int-cache-dependent bug.
- Check: are public functions type-annotated and dependencies pinned (lockfile /
  venv), so the script is reproducible?

---

## Output expectations

Emit findings in the shape defined by `review-output-format.md`: a priority
(P1 breaks adoption/safety/behavior; P2 concrete correctness or
maintainability; P3 clarity/improvement), `file:line`, a one-line claim, the
evidence, the impact/risk (blast radius + likelihood), and the smallest
behavior-preserving fix — plus the lens you loaded, so a mis-routed lens can be
challenged. When the loaded lens is clean, say so explicitly rather than
inventing P3 noise.
