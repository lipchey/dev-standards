# Security Review (review guide template)

Seed template - CATALOG SEED. Adapted as short, paraphrased excerpts from the
`codex-security-skills` source recorded in `agents/skill-catalog.json`
(`feeds_guides: ["security-review.md"]`). The `deep-review-refactor` skill loads
it as a conditional lens, gated by the conditionality banner below - so it seeds
the security lens an adopting repo wires into its own review chain.
STARTING template: each adopting repo copies it into `.agents/review-guides/` and
then owns its final body. The prompts below are review-only JUDGMENT PROMPTS for
a human or reviewing agent - never an instruction to edit. Security is one place
laziness never applies: a "probably fine" input path is a finding.

## How to apply this guide (conditional by repo type)

Security scope is broad but the *emphasis* shifts by surface:

- CLI tools / runners (this repo's own kind): the trust boundary is argv, env,
  file contents, and everything handed to a subprocess or `git`. Injection via
  argv/pathspec/OID and path escape are the live risks - weight them hardest.
- Services / web: add request input, authn/authz, session, and output encoding.
- Bash/n8n glue: shell-injection, unquoted expansions, and secret handling
  dominate; module-depth prompts do not apply, these do.

A rule that does not map to any real boundary in this repo is not a finding - but
the *absence* of validation at a boundary that DOES exist always is.

## Input validation at trust boundaries

Judgment prompts:

- Is every crossing from outside-controlled to inside-trusted data validated at
  the boundary - argv, env vars, stdin, file contents, network payloads, and any
  value later interpolated into a path, a command, or a query? Validate at the
  edge, once, not scattered deep in callers.
- Is validation allow-list (accept a known-good shape) rather than deny-list
  (block known-bad)? Deny-lists miss the next encoding.
- Are length, type, range, and charset bounded before use, so a hostile input
  cannot drive resource exhaustion or reach an unexpected code path?

## Injection (argv / path / pathspec / OID)

Judgment prompts:

- Does user/argument data flow into a subprocess? Require argv-array spawning
  (never a shell string); flag any `sh -c`, string concatenation into a command,
  or `shell: true` carrying external data.
- For `git`: is caller-supplied text passed as a pathspec/ref/OID without a `--`
  separator or `^{object}`-style validation, so a value starting with `-` is
  parsed as an OPTION (argument injection)? Require the `--` end-of-options
  guard and reject leading-dash inputs.
- Is a path built from external input used to open/write/delete without
  canonicalization? A `..`, an absolute path, or a symlink component is a
  traversal vector - see path confinement below.
- Is external data interpolated into SQL, a regex (ReDoS), a format string, or
  serialized output without the boundary's proper escaping/parameterization?

## Path confinement

Judgment prompts:

- Before any filesystem write/delete driven by external input, is each path
  component `lstat`-checked and the resolved real path confined to an intended
  root (realpath starts-with root, checked on the resolved path, not the raw
  string)?
- Is a symlink component that escapes the root rejected, and is the leaf written
  no-follow — exclusive/no-follow creation (`wx` / `O_CREAT|O_EXCL|O_NOFOLLOW`)
  or atomic replacement via a temp file + `rename` through a verified directory —
  so a swapped symlink cannot redirect the write? A bare unlink-then-create is
  NOT safe: another process can install a symlink between the unlink and the
  ordinary create and redirect it. The dangerous path is deletion/orphan-cleanup
  - it must be confined too, not just the create path.
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

## Output expectations

Emit findings in the shape defined by `review-output-format.md`. A concrete
exploitable path (data loss, escape, injection, secret exposure) is a **P1**;
missing defense-in-depth with no proven exploit is P2/P3 with the residual risk
named. For each: location, the prompt/class it triggered, the concrete attack or
failure case, the risk, and the smallest hardening slice. Do not duplicate a
finding a scanner (gitleaks, CodeQL, `npm audit`) already owns - reference it.
