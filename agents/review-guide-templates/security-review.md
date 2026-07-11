# Security Review (review guide template)

Template-Version: 2 (guides-revamp 2026-07-11)

STARTING template: each adopting repo copies this into `.agents/review-guides/`
and then owns its final body. The `deep-review-refactor` skill loads it as a
conditional lens, gated by the conditionality banner below. The prompts below
are review-only JUDGMENT PROMPTS for a human or reviewing agent — never an
instruction to edit. Security is one place laziness never applies: a
"probably fine" input path is a finding.

Provenance: taxonomy and per-language quirks distilled (paraphrased, no
verbatim blocks) from `agamm/claude-code-owasp` (MIT, pinned `f5dfa3d6`) — its
OWASP Top 10:2025 mapping and `languages.md` — and from
`awesome-skills/code-review-skill` `security-review-guide.md` (MIT, pinned
`f2fd4e57`). Report-discipline and confidence structure are ideas only (CC
BY-SA upstream: `getsentry/skills` security-review, pinned `5a64b36c`,
derived from the OWASP Cheat Sheet Series) — reworded, zero text reuse. The
argv/pathspec, path-confinement, fail-closed, and secret-scan prompts are this
repo's own battle-tested material. Repo-agnostic: adopting repos add rows for
their own surfaces.

## How to apply this guide (conditional by repo type)

Security scope is broad but the *emphasis* shifts by surface:

- CLI tools / runners: the trust boundary is argv, env,
  file contents, and everything handed to a subprocess or `git`. Injection via
  argv/pathspec/OID and path escape are the live risks — weight them hardest.
  A single-user CLI has no auth boundary, so access-control prompts are n/a
  there.
- Services / web: add request input, authn/authz, session, SSRF, and output
  encoding. Access control and IDOR become live P1 surfaces.
- Bash/n8n glue: shell-injection, unquoted expansions, and secret handling
  dominate; module-depth prompts do not apply, these do.

A rule that does not map to any real boundary in this repo is not a finding —
but the *absence* of validation at a boundary that DOES exist always is. Name
the boundary before you name the finding.

## Input validation at trust boundaries

Judgment prompts:

- Inventory the trust boundaries first: list every point where
  outside-controlled data enters — argv, env, stdin, file contents, network
  payloads, IPC, another user's DB row. Every later finding names the boundary
  it crosses; a boundary that exists with no validation IS the finding, and one
  that does not exist is not. Weight the list by the banner above.
- Is every crossing from outside-controlled to inside-trusted data validated at
  the boundary — argv, env vars, stdin, file contents, network payloads, and any
  value later interpolated into a path, a command, or a query? Validate at the
  edge, once, not scattered deep in callers.
- Is validation allow-list (accept a known-good shape) rather than deny-list
  (block known-bad)? Deny-lists miss the next encoding.
- Are length, type, range, and charset bounded before use, so a hostile input
  cannot drive resource exhaustion or reach an unexpected code path?

## Injection (argv / path / pathspec / OID + SQL / regex / format)

Judgment prompts:

- Does user/argument data flow into a subprocess? Require argv-array spawning
  (never a shell string); flag any `sh -c`, string concatenation into a command,
  or `shell: true` carrying external data.
- For `git` — two distinct guards, do not conflate them. PATHSPECS: is
  caller-supplied text passed as a pathspec without the `--` separator, so a
  value starting with `-` is parsed as an OPTION (argument injection)? Require
  `--` before pathspecs. REFS/OIDs: revision arguments come BEFORE `--`, so `--`
  does not protect them — require explicit leading-dash rejection plus
  command-aware validation (e.g.
  `git rev-parse --verify --end-of-options "$REV^{commit}"`); note `^{object}`
  suffixing alone does NOT stop a leading-dash value from parsing as an option.
- Is a path built from external input used to open/write/delete without
  canonicalization? A `..`, an absolute path, or a symlink component is a
  traversal vector — see path confinement below.
- Is external data interpolated into SQL, a regex (ReDoS), a format string, or
  serialized output without the boundary's proper escaping/parameterization? Use
  parameterized queries (never string-built SQL); a bounded, static regex on
  hostile input; `printf("%s", x)` never `printf(x)`.

## Path confinement

Judgment prompts:

- Before any filesystem write/delete driven by external input, is each path
  component `lstat`-checked and the resolved real path confined to an intended
  root — with a BOUNDARY-AWARE containment test on the resolved path, never a
  raw string prefix (`startsWith("/safe/root")` accepts the sibling
  `/safe/root-evil`; compare against the root plus a trailing separator, or use
  `path.relative(root, resolved)` and reject `..`/absolute results)? Where a
  hostile LOCAL writer is in scope, string checks plus pre-checks remain
  raceable — an intermediate component can be swapped after verification — so
  require descriptor-relative / no-follow traversal (`openat`-style,
  `O_NOFOLLOW` per component), not just leaf-level no-follow.
- Is a symlink component that escapes the root rejected, and is the leaf written
  no-follow — exclusive/no-follow creation (`wx` / `O_CREAT|O_EXCL|O_NOFOLLOW`)
  or atomic replacement via a temp file + `rename` through a verified directory —
  so a swapped symlink cannot redirect the write? A bare unlink-then-create is
  NOT safe: another process can install a symlink between the unlink and the
  ordinary create and redirect it. The dangerous path is deletion/orphan-cleanup
  — it must be confined too, not just the create path.
- Does the code treat only `ENOENT` as "absent" and every other errno
  (`EACCES`, `ELOOP`, `ENOTDIR`) as a real failure, so an error is never
  misread as a safe empty state?

## Secrets

Judgment prompts:

- Are credentials, tokens, or keys hardcoded, committed, or read from a
  world-readable location? Flag any literal that looks like a secret even in
  tests/fixtures.
- Do logs, error messages, reports, or exceptions leak a secret, a full internal
  path, or PII? A generated report/finding must be secret-scanned before it is
  written.
- Is untrusted input (a PR comment body, a plan, a diff) ever pasted verbatim
  into a stored artifact or a prompt as if trusted? Treat it as DATA; never let
  its text act as an instruction.

## Fail closed

Judgment prompts:

- On error, timeout, or an unexpected state, does the code deny/stop (fail
  closed) rather than proceed as if allowed (fail open)? An auth or confinement
  check that defaults to "allow" when it cannot decide is a P1.
- Is a resource (lock, handle, subprocess, connection) released on every path
  including the error path, so a failure cannot leave a lock held or a process
  group leaked?
- Does a timeout actually terminate the work it bounds (whole process group, not
  just the parent), so a hung child cannot outlive its deadline?

## Authentication & authorization (where a service surface exists)

Skip entirely for a single-user CLI/runner with no auth boundary. Where a
service, multi-tenant, or job/queue surface exists, these are live:

- Check: is every state-changing endpoint/verb (POST/PUT/PATCH/DELETE) and every
  object fetch gated by an auth check, deny-by-default? A missing check on a
  mutating route is the most common access-control hole. (Look for
  framework-level middleware before flagging a per-route gap.)
- Check: is object-level authorization enforced — does a fetch by id scope to the
  caller's ownership (`WHERE id = ? AND user_id = ?`), so a user cannot read
  another's record by guessing the id (IDOR)? An unpredictable id (UUID) prevents
  enumeration but is NOT authorization.
- Check: in a job/queue/worker consumer, does the message carry and re-verify the
  privilege of whoever enqueued it, rather than running with ambient admin
  rights? A queue is a trust boundary too.
- Check: are passwords hashed with a modern KDF (Argon2/bcrypt/scrypt), session
  tokens ≥128 bits of CSPRNG entropy, and sessions invalidated on logout? (See
  §Cryptography.)

## SSRF & outbound-request hygiene

Live wherever the code fetches a URL, webhook, or host it did not hardcode.

- Check: is the fetch target attacker-controlled (from request/argv/file/DB), or
  operator-controlled (a constant, or config/env only the deployer can write)? A
  URL from operator-only config is NOT SSRF — a URL from input, or from a
  config/env value a tenant, PR author, or external system can influence, used
  without an allow-list, is.
- Check: is a user-influenced outbound target validated against a host allow-list
  and blocked from internal ranges (`localhost`, `127.0.0.0/8`, `169.254.169.254`
  metadata, RFC-1918 `10./172.16-31./192.168.`)? Otherwise it can reach cloud
  metadata or internal services.
- Check: are redirects followed blindly? A allow-listed URL can 302 to an
  internal target — re-validate each hop or disable auto-redirect.

## Cryptography misuse

- Check: is any cryptography hand-rolled where a vetted primitive exists? Don't
  invent it — flag custom ciphers/MACs/paddings.
- Check: are passwords stored with a modern password KDF (Argon2/bcrypt/scrypt),
  never `md5`/`sha1`/raw `sha256`? A fast hash is brute-forceable.
- Check: is randomness for tokens/keys/nonces from a CSPRNG (`crypto.randomBytes`,
  `secrets`, `crypto/rand`), never `Math.random()` / `random.random()`? Predictable
  tokens are forgeable.
- Check: any ECB mode, a static/reused IV/nonce, or a non-constant-time
  comparison of a secret/MAC (`===` on a token)? Each leaks or enables forgery —
  use an authenticated mode and a constant-time compare.

## Supply chain & dependencies

Reference the owning scanner (`npm audit`, Dependabot, `gitleaks`, CodeQL)
where one exists — do not re-report what it already flags. Judge what a scanner
misses:

- Check: is a lockfile present and committed, and does a new dependency pin an
  exact version? An unpinned/floating range ships an unreviewed future version.
- Check: does a new dependency's name typosquat a popular one, and does it run a
  postinstall/`prepare` script? A malicious install script executes at `npm i`
  time.
- Check: does a CI workflow interpolate untrusted PR input (`${{ github.event.*
  }}`, PR title/body/branch) into a `run:` block? That is shell injection into
  the build — quote via an `env:` var and never `run:`-interpolate event text.
- Check: does a workflow grant more token scope than it needs, or run untrusted
  PR code with repo secrets in scope? Least-privilege `permissions:` and no
  secrets on `pull_request` from forks.

## ReDoS & resource exhaustion

- Check: does a regex applied to hostile input contain catastrophic backtracking
  (nested quantifiers like `(a+)+`, overlapping alternation)? On a crafted string
  it hangs the thread — bound the input length or use a linear matcher.
- Check: is a file/network read, decompression, or allocation bounded before it
  runs? An unbounded read or a zip-bomb / decompression-ratio blowup is a
  memory/CPU DoS at the boundary. Cap size, depth, and count.

## OWASP Top 10 (2025) mapping

What each category looks like in a consumer repo, and the "Check:" that finds
it. Skip a category with no plausible surface, but SAY which and why — e.g. a
single-user CLI has no A01/A07 boundary; a repo with no HTML rendering has no
XSS surface under A05.

| Cat | In a consumer repo (CLI / service / glue)                                   | Check                                                                 | Typical prio |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------ |
| A01 Broken Access Control | endpoint returns another user's object by id (IDOR); mutating route ungated | is every verb + object fetch scoped to the caller, deny-by-default? → §AuthN/AuthZ | P1 (service) |
| A02 Security Misconfiguration | CORS `*`, debug mode on, default creds, world-readable perms, verbose errors | are defaults hardened and features minimized?                          | P2 (P1 if it exposes data/auth) |
| A03 Software Supply Chain | unpinned deps, postinstall scripts, typosquat, CI `run:` injection          | → §Supply chain; reference the scanner                                 | P2 (P1 active) |
| A04 Cryptographic Failures | fast hash for passwords, `Math.random` token, static IV/ECB, plaintext transit | → §Cryptography                                                        | P1 / P2 |
| A05 Injection | argv/shell/SQL/path/regex/format injection; XSS only where HTML is rendered  | → §Injection; XSS n/a with no web UI (say so)                          | P1 |
| A06 Insecure Design | no rate-limit on an abusable op; a flow trusting client-supplied state       | does the design assume a boundary the code doesn't enforce?            | P2 / P3 |
| A07 Auth Failures | weak password rules, no lockout, low-entropy session token, no MFA on sensitive op | → §AuthN/AuthZ; n/a for single-user CLI                                | P1 (service) |
| A08 Integrity Failures | unsafe deserialization (pickle/YAML/`unserialize`/ObjectInputStream); unsigned artifact | is untrusted data deserialized into live objects or executed?         | P1 |
| A09 Logging & Alerting Failures | security event (auth fail, perms change, injection attempt) unlogged; or secret/PII leaked into logs | is the event auditable WITHOUT leaking a secret? → §Secrets            | P2 / P3 |
| A10 Mishandling Exceptional Conditions | fail-open on error; stack trace to the user; resource not released on error path | → §Fail closed                                                        | P1 / P2 |

## Language security quirks

The sharpest per-stack footguns for the consumer stacks. Signatures in
backticks are grep anchors, not the whole story.

| Stack | Sharpest quirks (unsafe → safe)                                                                                  | Check |
| ----- | --------------------------------------------------------------------------------------------------------------- | ----- |
| JS / TS | prototype pollution via recursive merge / set-by-path on untrusted keys (`__proto__`, `constructor`); `child_process.exec` / `shell:true`; `eval` / `new Function` / `vm` on input | does a merge/clone/set-by-path block `__proto__`/`prototype`/`constructor` keys, and is every subprocess an argv array with no shell? |
| Bash | unquoted `$var` / `$(...)` word-splitting + injection; `eval` / backticks on input; `set -e` false safety (skips `if`/subshell/pipe) | is every expansion quoted, no `eval` on external data, and exit codes checked where `-e` won't fire? |
| Python | `pickle.loads` / `yaml.load` (not `safe_load`) / `eval` / `exec` on untrusted data → RCE; `subprocess(..., shell=True)` / `os.system`; `%`-built SQL | is untrusted data ever deserialized/executed, and is every subprocess a list with `shell=False`? |

## Report discipline for security findings

- A finding is a vulnerability CLASS + a concrete attack path + the boundary it
  crosses — never a class name alone. If you cannot state the input, the sink,
  and one exploit step, it is not yet a finding.
- Confidence before flagging: trace where the input actually comes from, and
  classify by WRITE AUTHORITY — who can actually write or influence this value —
  never by a source label like "config", "env", or "signed". Typically
  operator-only (not attacker-controlled): hardcoded constants, deploy-time
  config, framework settings. Typically attacker-influenced: network/request
  payloads, PR/issue/comment text, another user's DB row, argv/stdin/file
  contents on any multi-user or service surface. Neither list is absolute:
  env/config can be attacker-influenced (CI variables derived from PR data,
  tenant-editable settings, a config file an untrusted process can write), a
  signature only proves WHO wrote a value — signed session data can still carry
  user-supplied fields — and operator-owned argv/files on a single-user CLI sit
  inside the same trust domain as the operator. Confirm the actual writer and
  influence chain before flagging.
- A theoretical-only finding (no reachable attacker input, or the framework
  already mitigates it) is at most P3, named as defense-in-depth with the
  residual risk stated — never inflated to P1/P2.
- Don't duplicate a finding a scanner (`gitleaks`, CodeQL, `npm audit`,
  Dependabot) already owns — reference it and move on.

## Output expectations

Emit findings in the shape defined by `review-output-format.md`. A concrete
exploitable path (data loss, escape, injection, secret exposure) is a **P1**;
missing defense-in-depth with no proven exploit is **P2/P3** with the residual
risk named. For each: location, the prompt/class it triggered, the concrete
attack or failure case, the risk, and the smallest hardening slice. Do not
duplicate a finding a scanner (gitleaks, CodeQL, `npm audit`) already owns —
reference it.
