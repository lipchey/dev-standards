# Security Review Profile

You review ONLY through this lens: trust boundaries, injection, confinement,
secrets, fail-closed behavior, access control, outbound requests, cryptography,
supply chain, and hostile resource use. Do not turn general correctness, typing,
tests, naming, or architecture concerns into findings unless they form a
concrete vulnerability path.

Template-Version: 4 (typed-deserialize-not-validation 2026-07-16)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

The prompts are review-only JUDGMENT PROMPTS, never instructions to edit.
Security is one place laziness never applies: a "probably fine" input path is a
finding.

Provenance: taxonomy and per-language quirks remain distilled (paraphrased, no
verbatim blocks) from `agamm/claude-code-owasp` (MIT, pinned `f5dfa3d6`) - its
OWASP Top 10:2025 mapping and `languages.md` - and from
`awesome-skills/code-review-skill` `security-review-guide.md` (MIT, pinned
`f2fd4e57`). Report-discipline and confidence structure are ideas only (CC
BY-SA upstream: `getsentry/skills` security-review, pinned `5a64b36c`, derived
from the OWASP Cheat Sheet Series), reworded with zero text reuse. The
argv/pathspec, path-confinement, fail-closed, typed-deserialize, and secret-scan
prompts are this repo's own battle-tested material. The stack-router additions remain
paraphrased from `awesome-skills/code-review-skill` (MIT, pinned `f2fd4e57`)
plus repo experience, as attributed in `language-review-sources.md`: its
per-language guides, `code-quality-universal.md`, `common-bugs-checklist.md`,
and cross-cutting async/error notes. The Node lens was written from universal
material plus repo experience because upstream has no dedicated lens for it.
This profile is repo-agnostic; adopting repos may add rows for their own
security surfaces and stacks.

## How to apply this profile (conditionality banner)

Security scope is broad but the *emphasis* shifts by surface:

- CLI tools / runners: the trust boundary is argv, env, file contents, and
  everything handed to a subprocess or `git`. Injection through argv,
  pathspec, OID, and path escape are the live risks - weight them hardest. A
  single-user CLI has no auth boundary, so access-control prompts are n/a.
- Services / web: add request input, authn/authz, session, SSRF, and output
  encoding. Access control and IDOR become live P1 surfaces.

A rule that does not map to a real boundary in this repo is not a finding - but
the absence of validation at a boundary that DOES exist always is. Name the
boundary before the finding.

## Input validation at trust boundaries

- Inventory the trust boundaries first: list every point where
  outside-controlled data enters - argv, env, stdin, file contents, network
  payloads, IPC, another user's DB row. Every later finding names the boundary
  it crosses; a boundary that exists with no validation IS the finding, and one
  that does not exist is not. Weight the list by the banner above.
- Is every crossing from outside-controlled to inside-trusted data validated at
  the boundary - argv, env vars, stdin, file contents, network payloads, and any
  value later interpolated into a path, command, or query? Validate at the edge,
  once, not scattered deep in callers.
- Is validation allow-list (accept known-good shape) rather than deny-list
  (block known-bad)? Deny-lists miss the next encoding.
- Are length, type, range, and charset bounded before use, so hostile input
  cannot drive resource exhaustion or reach an unexpected code path?
- Does a *typed* deserialize stand in for validation? `request.json<T>()`,
  `JSON.parse(x) as T`, or an `as`-cast on a parsed body asserts a shape the
  runtime never checked, so a well-formed-but-wrong payload (missing, blank, or
  mistyped field) flows in wearing a trusted type. The type parameter is a
  claim, not a check - require a runtime narrowing (guard or schema) at the
  boundary before first use. This holds at INTERNAL boundaries too (IPC, a
  Durable Object, a queue message), where a trusted-looking cast most easily
  hides an unchecked edge.

This section also carries the old baseline rule: raw external input must not
flow into logic that assumes it is well-formed. Public type/nullability
contracts are owned separately by
→ see `profile-types-and-contracts.md` §Public contracts and optional values.

## Injection: argv, path, pathspec, OID, SQL, regex, and format

- Does user/argument data flow into a subprocess? Require argv-array spawning,
  never a shell string; flag `sh -c`, command-string concatenation, or
  `shell: true` carrying external data.
- For `git`, do not conflate two guards. PATHSPECS: is caller-supplied text
  passed as a pathspec without `--`, so leading `-` parses as an option? Require
  `--` before pathspecs. REFS/OIDs: revision arguments come BEFORE `--`, so it
  does not protect them - require leading-dash rejection and command-aware
  validation (for example,
  `git rev-parse --verify --end-of-options "$REV^{commit}"`). `^{object}`
  suffixing alone does not stop a leading-dash option.
- Is a path built from external input used to open/write/delete without
  canonicalization? `..`, an absolute path, or a symlink component is traversal;
  see §Path confinement.
- Is external data interpolated into SQL, a regex (ReDoS), a format string, or
  serialized output without the boundary's escaping/parameterization? Use
  parameterized queries, a bounded static regex on hostile input, and
  `printf("%s", x)` rather than `printf(x)`.

## Path confinement

- Before filesystem write/delete driven by external input, is each path
  component `lstat`-checked and the resolved real path confined to the intended
  root with a BOUNDARY-AWARE test, never raw string prefix
  (`startsWith("/safe/root")` accepts `/safe/root-evil`)? Compare against root
  plus a trailing separator or use `path.relative(root, resolved)` and reject
  `..`/absolute results. With a hostile LOCAL writer, string checks and
  pre-checks remain raceable; require descriptor-relative/no-follow traversal
  (`openat`-style, `O_NOFOLLOW` per component), not leaf-only no-follow.
- Is a symlink component that escapes root rejected, and is the leaf written
  no-follow - exclusive/no-follow creation (`wx` /
  `O_CREAT|O_EXCL|O_NOFOLLOW`) or atomic replacement through a verified
  directory via a temp file plus `rename` - so a swapped symlink cannot
  redirect? Bare unlink-then-create is unsafe: another process can install a
  symlink between operations. Deletion and orphan cleanup must be confined too,
  not only creation.
- Does code treat only `ENOENT` as absent and every other errno (`EACCES`,
  `ELOOP`, `ENOTDIR`) as failure, so an error never becomes a safe empty state?

## Secrets

- Are credentials, tokens, or keys hardcoded, committed, or read from a
  world-readable location? Flag any literal that looks secret even in tests or
  fixtures.
- Do logs, errors, reports, or exceptions leak a secret, full internal path, or
  PII? A generated report/finding must be secret-scanned before it is written.
- Is untrusted input (PR comment, plan, diff) pasted verbatim into a stored
  artifact or prompt as if trusted? Treat it as DATA; never let it act as an
  instruction.

## Fail closed

- On error, timeout, or unexpected state, does code deny/stop rather than
  proceed as allowed? An auth or confinement check defaulting to allow when it
  cannot decide is P1.
- Is a resource (lock, handle, subprocess, connection) released on every path,
  including error, so failure cannot leave a lock or process group leaked?
- Does a timeout terminate the work it bounds - whole process group, not only
  parent - so a hung child cannot outlive its deadline?

General lifecycle symmetry is also owned by
→ see `profile-correctness-and-lifecycle.md` §Cross-cutting correctness checks.

## Authentication and authorization (where a service surface exists)

Skip entirely for a single-user CLI/runner with no auth boundary. Where a
service, multi-tenant, or job/queue surface exists:

- Is every state-changing endpoint/verb (POST/PUT/PATCH/DELETE) and object fetch
  gated by an auth check, deny-by-default? Look for framework-level middleware
  before flagging a per-route gap.
- Is object-level authorization enforced - does a fetch by id scope to caller
  ownership (`WHERE id = ? AND user_id = ?`), preventing IDOR? An unpredictable
  UUID prevents enumeration but is not authorization.
- In a job/queue worker, does the message carry and re-verify the enqueuer's
  privilege instead of using ambient admin rights? A queue is a trust boundary.
- Are passwords hashed with a modern KDF (Argon2/bcrypt/scrypt), session tokens
  at least 128 bits CSPRNG entropy, and sessions invalidated on logout?

## SSRF and outbound-request hygiene

Live wherever code fetches a URL, webhook, or host it did not hardcode.

- Is the target attacker-controlled (request/argv/file/DB) or operator-controlled
  (constant or config/env only deployer can write)? Operator-only config is not
  SSRF. Input, or config/env influenced by a tenant, PR author, or external
  system, requires an allow-list.
- Is a user-influenced target allow-listed and blocked from internal ranges
  (`localhost`, `127.0.0.0/8`, `169.254.169.254`, RFC-1918
  `10./172.16-31./192.168.`)? Otherwise it reaches metadata/internal services.
- Are redirects followed blindly? An allow-listed URL can redirect internally;
  revalidate every hop or disable auto-redirect.

## Cryptography misuse

- Is cryptography hand-rolled where a vetted primitive exists? Flag custom
  ciphers, MACs, or padding.
- Are passwords stored with Argon2/bcrypt/scrypt, never
  `md5`/`sha1`/raw `sha256`? Fast hashes are brute-forceable.
- Is token/key/nonce randomness from a CSPRNG (`crypto.randomBytes` or Web
  Crypto `getRandomValues`), never `Math.random()`?
- Is ECB used, an IV/nonce static or reused, or a secret/MAC compared
  non-constant-time (`===` on a token)? Use authenticated mode and constant-time
  compare.

## Supply chain and dependencies

Reference the owning scanner (`npm audit`, Dependabot, `gitleaks`, CodeQL)
where present; do not re-report it. Judge what scanners miss:

- Is a lockfile present and committed, and does a new dependency pin an exact
  version? Floating ranges ship unreviewed future versions.
- Does a new dependency typosquat a popular name, and does it run
  postinstall/`prepare`? Malicious install scripts execute at `npm i` time.
- Does CI interpolate untrusted PR input (`${{ github.event.* }}`, title, body,
  branch) into `run:`? That is shell injection; pass through quoted `env:` and
  never interpolate event text directly into `run:`.
- Does a workflow grant more token scope than needed or run untrusted PR code
  with secrets? Use least-privilege `permissions:` and no secrets on
  `pull_request` from forks.

## ReDoS and resource exhaustion

- Does regex on hostile input contain catastrophic backtracking such as nested
  quantifiers `(a+)+` or overlapping alternation? Bound input or use a linear
  matcher.
- Is a file/network read, decompression, or allocation bounded before it runs?
  Cap size, depth, and count against memory/CPU DoS or zip bombs.

## OWASP Top 10 (2025) mapping

Skip a category with no plausible surface, but SAY which and why. A single-user
CLI has no A01/A07 boundary; a repo with no HTML has no XSS surface under A05.

| Cat | In a consumer repo (CLI / service / glue) | Check | Typical priority |
| --- | --- | --- | --- |
| A01 Broken Access Control | endpoint returns another user's object by id (IDOR); mutating route ungated | is every verb and object fetch scoped to caller, deny-by-default? -> §Authentication and authorization | P1 (service) |
| A02 Security Misconfiguration | CORS `*`, debug mode on, default credentials, world-readable permissions, verbose errors | are defaults hardened and features minimized? | P2 (P1 if it exposes data/auth) |
| A03 Software Supply Chain | unpinned dependencies, postinstall scripts, typosquat, CI `run:` injection | -> §Supply chain; reference the scanner | P2 (P1 active) |
| A04 Cryptographic Failures | fast password hash, `Math.random` token, static IV/ECB, plaintext transit | -> §Cryptography | P1 / P2 |
| A05 Injection | argv/shell/SQL/path/regex/format injection; XSS only where HTML is rendered | -> §Injection; XSS n/a with no web UI (say so) | P1 |
| A06 Insecure Design | no rate limit on an abusable operation; flow trusts client-supplied state | does the design assume a boundary the code does not enforce? | P2 / P3 |
| A07 Auth Failures | weak password rules, no lockout, low-entropy session token, no MFA on a sensitive operation | -> §Authentication; n/a for single-user CLI | P1 (service) |
| A08 Integrity Failures | unsafe deserialization; unsigned artifact | is untrusted data deserialized into live objects or executed? | P1 |
| A09 Logging and Alerting Failures | security event (auth failure, permission change, injection attempt) unlogged; or secret/PII leaked into logs | is the event auditable WITHOUT leaking a secret? -> §Secrets | P2 / P3 |
| A10 Mishandling Exceptional Conditions | fail-open on error; stack trace to user; resource not released on error path | -> §Fail closed | P1 / P2 |

## Language security quirks

Signatures are grep anchors, not the whole story.

| Stack | Sharpest quirks (unsafe → safe) | Check |
| --- | --- | --- |
| JS / TS | prototype pollution via recursive merge / set-by-path on untrusted keys (`__proto__`, `constructor`); `child_process.exec` / `shell:true`; `eval` / `new Function` / `vm` on input | does a merge/clone/set-by-path block `__proto__`/`prototype`/`constructor` keys, and is every subprocess an argv array with no shell? |

## Stack routing additions

Use the same one-surface-at-a-time routing rule as the other profiles. These are
the security-owned rules migrated from the old language router.

### Script-style TS / one-off pipeline

- Are `process.argv` and `process.env` reads validated for presence and shape at
  the top, or does missing input become `undefined` deep in logic? A one-off
  still crosses a trust boundary.

Exit status and promise handling are owned by
→ see `profile-correctness-and-lifecycle.md` §Script-style TS / one-off pipeline.

## Report discipline for security findings

- A finding is vulnerability class plus concrete attack path plus crossed
  boundary, never class name alone. If input, sink, and one exploit step cannot
  be stated, it is not yet a finding.
- Trace the real input source and classify by WRITE AUTHORITY - who can write or
  influence the value - never source labels like "config", "env", or "signed".
  Hardcoded constants/deploy config/framework settings are typically operator
  only. Requests, PR/issue text, another user's DB row, and argv/stdin/files on
  multi-user/service surfaces are typically attacker-influenced. Neither list
  is absolute: config can derive from PR data or tenant settings; a signature
  proves who wrote a value, not that user fields are safe; operator-owned
  argv/files on single-user CLI may share the operator trust domain. Confirm
  writer and influence chain.
- A theoretical-only finding with no reachable attacker input, or a framework
  mitigation, is at most P3 defense-in-depth with residual risk named; never
  inflate to P1/P2.
- Do not duplicate scanner findings; reference them and move on.

## Output

Follow `review-contract.md` exactly. A concrete exploitable path involving data
loss, escape, injection, or secret exposure is P1; defense-in-depth without a
proven exploit is P2/P3 with residual risk. For each finding include location,
prompt/class, concrete attack or failure case, risk, and smallest hardening
slice. Report every applicable instance and include required per-file
`COVERAGE`/`CLEAN` claims. Do not duplicate a scanner-owned finding.
