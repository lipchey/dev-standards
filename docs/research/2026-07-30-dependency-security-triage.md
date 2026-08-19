# Dependency-security triage — 2026-07-30

Status: **done**. This is the point-in-time U14 evidence record for the
`dev-standards` dependency graph. The `brace-expansion` exposure it accepted
under an owner and a review date is **closed by remediation** — see
[2026-08-19 revalidation](#2026-08-19-revalidation-at-the-dq1-c1-pin-window)
below. No accepted-risk disposition is carried forward, so a new advisory has
nothing to inherit.

## Evidence and reconciliation

Evidence was collected from `origin/main` at `d064012` (`v0.34.1`) and repeated
after the compatible remediation landed as PR
[#15](https://github.com/lipchey/dev-standards/pull/15), commit `06b4613`:

- `npm audit --audit-level=high --json`;
- `npm ls brace-expansion fast-uri --all --package-lock-only --json`;
- the GitHub Dependabot alerts API for the default branch;
- `npm audit fix --package-lock-only --dry-run --json` for the supported fix
  surface.

Before remediation, npm reported **7 high, 0 critical** while GitHub exposed
**3 open high alerts**. These numbers describe different units:

- npm's seven entries are affected packages in the propagated dependency graph;
- GitHub's three entries are package/advisory alerts: one for
  `brace-expansion` and two for `fast-uri`.

The identities are therefore proven, not inferred:

| GitHub alert | npm advisory package | npm affected-package entries |
| --- | --- | --- |
| `GHSA-mh99-v99m-4gvg` | `brace-expansion` | `brace-expansion`, `minimatch`, `@eslint/config-array`, `@eslint/eslintrc`, `eslint`, `eslint-plugin-jsx-a11y` |
| `GHSA-v2hh-gcrm-f6hx` | `fast-uri` | `fast-uri` |
| `GHSA-4c8g-83qw-93j6` | `fast-uri` | the same `fast-uri` node; npm attaches both advisories to it |

## Finding inventory

`Runtime` below means reachable while consumers execute the shared ESLint/Ajv
tooling. It does **not** mean shipped in Ariadne's product runtime. `Core dev`
means used only by this repository's own verification. ESLint is both a core
dev dependency and a peer supplied at consumer-tool runtime.

| npm finding | Concrete dependency path | Exposure and exploitability | Disposition |
| --- | --- | --- | --- |
| `fast-uri@3.1.2` | `dev-standards → ajv@8.20.0 → fast-uri` | Runtime. Ajv compiles the bundled quality schema and validates repository-owned manifests; it does not resolve attacker-selected remote schemas here. The host-confusion primitives were reachable code but had no network trust boundary in this data flow. | **Remediated:** lockfile-only upgrade to `3.1.4` in PR #15 closes both `fast-uri` advisories without a manifest or API change. |
| `brace-expansion@1.1.16` | `dev-standards → eslint-plugin-jsx-a11y@6.10.2 → minimatch@3.1.5 → brace-expansion` | Runtime. Brace expansion consumes repository-owned lint glob patterns, not source text, filenames, or network input. A pull request can change those executable/config inputs and self-DoS its own CI run, but gains no capability beyond the code/config it already controls. | **Time-bounded accepted risk (closed 2026-08-19, see revalidation):** owner `@lipchey`; review/expiry **2026-08-13**. Upgrade when `eslint-plugin-jsx-a11y` supports a non-vulnerable dependency line; do not force an incompatible override. |
| `brace-expansion@5.0.7` | `dev-standards → eslint-plugin-sonarjs@4.2.0 → minimatch@10.2.5 → brace-expansion` | Runtime; the same repository-owned-pattern boundary applies. | Covered by the same `@lipchey` disposition and 2026-08-13 expiry (closed 2026-08-19, see revalidation). Re-resolve the lockfile when the compatible `minimatch` line selects `brace-expansion >=5.0.8`. |
| `minimatch` | Directly under `eslint-plugin-jsx-a11y`, `eslint-plugin-sonarjs`, `eslint`, `@eslint/config-array`, and `@eslint/eslintrc` | Runtime in consumer lint; core dev in upstream verification. This is an npm propagation entry, not a separate advisory. | Same `brace-expansion` disposition; no separate vulnerability or waiver. |
| `@eslint/config-array` | `dev-standards → eslint@9.39.5 → @eslint/config-array@0.21.2 → minimatch@3.1.5 → brace-expansion` | Consumer-tool runtime through the ESLint peer; core dev here. | Same `brace-expansion` disposition; npm's supported fix requires the coordinated ESLint-major move below. |
| `@eslint/eslintrc` | `dev-standards → eslint@9.39.5 → @eslint/eslintrc@3.3.6 → minimatch@3.1.5 → brace-expansion` | Consumer-tool runtime through the ESLint peer; core dev here. | Same `brace-expansion` disposition. |
| `eslint@9.39.5` | Direct `devDependency` and `peerDependency`; the affected descendants are the three ESLint paths above | Consumer-tool runtime plus core dev. It is an npm propagation entry, not a distinct advisory. | `npm audit fix` proposes `eslint@10.8.0`, but the current `eslint-plugin-jsx-a11y@6.10.2` peer range ends at ESLint 9. Treat the major as a coordinated compatibility change, not an automatic security patch. |
| `eslint-plugin-jsx-a11y@6.10.2` | Direct dependency; vulnerable descendant shown above | Runtime. It has no current compatible release that removes the affected `minimatch` line. | `npm audit fix` proposes a downgrade to `6.4.1`; rejected because it drops current ESLint peer support and years of plugin fixes. Owner and expiry are the `brace-expansion` disposition above. |

## Fail-closed U14 gate

U14 is green only while all of these statements remain true:

1. both `fast-uri` advisories are absent at `fast-uri >=3.1.4`;
2. every remaining high advisory maps to this inventory and has an unexpired
   owner/date disposition;
3. a new advisory, an unreadable npm/GitHub inventory, an unparseable audit
   result, or an owner/date disposition past its review date fails the entry
   check instead of being treated as empty evidence;
4. the next pin-bump window re-runs both the lockfile audit and the Dependabot
   inventory, because the consumer pin changes the reachable graph.

An expired disposition is re-decided on fresh evidence — extended, escalated,
or closed. Editing the expired row's date is forbidden, because the date is
what makes the acceptance bounded: the original disposition stays verbatim,
and the re-decision is a separate dated section carrying the commands and
results it rests on, plus its own owner and expiry when the outcome is a new
acceptance.

Since the 2026-08-19 revalidation no advisory is accepted, so the normal
security command is green on its own evidence rather than despite a waiver.
The artifact U14 requires is the fail-closed **triage**: a complete
reconciliation, explicit exposure analysis, compatible remediation where
available, and a dated decision for any bounded remainder.

## 2026-08-19 revalidation at the DQ1-`C1` pin window

Statement 4 above fired: the consumer's pin-bump window re-ran the inventory at
`aa9c8ee`. Commands and results:

- `npm audit --audit-level=high --package-lock-only` → **found 0
  vulnerabilities** (same on the installed tree);
- GitHub Dependabot alerts API, `state=open` → **0 open alerts**;
- `npm ls brace-expansion fast-uri --all --package-lock-only` → `fast-uri`
  **3.1.5**; `brace-expansion` **1.1.18** on every `minimatch@3.1.5` path and
  **5.0.9** under `minimatch@10.2.5`.

**Re-decision — the time-bounded acceptance is closed, not extended.** Both
vulnerable `brace-expansion` lines were re-resolved past their own
`GHSA-mh99-v99m-4gvg` range inside the ranges that were already declared
compatible: that advisory patches the 1.x line at **1.1.17** (affected
`< 1.1.17`) and the 4.x/5.x line at **5.0.8** (affected `>= 4.0.0, < 5.0.8`),
and the tree resolves 1.1.18 and 5.0.9 — so the closure is checkable against
the advisory itself, not only against scanner output. Neither rejected option
was needed: `eslint-plugin-jsx-a11y` stays at `6.10.2` and `eslint` at
`9.39.5` — no downgrade, no coordinated major. Extending the acceptance was
rejected because there is nothing left to accept; the owner/expiry pair retires
with the exposure instead of being re-dated. `fast-uri` remains remediated
(3.1.5 ≥ 3.1.4).
