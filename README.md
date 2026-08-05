# dev-standards

Shared quality tooling for repositories that want one explicit, testable verification
contract without outsourcing their project topology to the package.

## Scope

The repository ships five deliberately separate surfaces:

1. **Runner and manifest contract** — `./verify`, `schemas/quality.schema.json`,
   tier budgets, filesets, blocking/report-only checks, reports, telemetry, and the
   staged-file formatter.
2. **Standalone tools** — dependency-change policy, companion-test checks,
   test-placement reporting, diff coverage, build fingerprints, and effectiveness
   reports under `tools/`.
3. **ESLint package** — shared flat-config presets and custom rules exported as
   `dev-standards/eslint`; see [eslint/README.md](eslint/README.md).
4. **Deep review** — the optional review/fix engine, its Codex and Claude skill
   wrappers, and the canonical review-profile corpus.
5. **Adoption kit** — installer/updater scripts and copy-if-absent consumer templates.

Consumers author the actual pipeline in `quality.json`. The runner executes the named
commands and validates their contract; it does not infer Nx projects, framework
defaults, or a built-in list of mandatory gates. It also does not implement red-main
tracking, health digests, or baseline-diff promotion.

Adoption is a one-command flow — see [docs/ADOPTION.md](docs/ADOPTION.md)
(`scripts/ds-install.sh`, `scripts/ds-update-pins.sh`).

## Documentation

[docs/README.md](docs/README.md) is the documentation map. The live sources are:

- [docs/ADOPTION.md](docs/ADOPTION.md) for consumer setup and updates;
- [docs/ADR.md](docs/ADR.md) for architectural decisions;
- [docs/CALIBRATION.md](docs/CALIBRATION.md) for effectiveness metrics and tuning;
- [docs/plans/backlog.md](docs/plans/backlog.md) for open repository work.

## Getting started

Fresh clone → build → self-verify:

```sh
npm run bootstrap   # npm ci && npm run build
./verify --full
```

## Verification

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `./verify --doctor`
- `./verify --fast`
- `./verify --full`

`runner/dist/` is a build-on-demand artifact for `dev-standards` itself and is
git-ignored; run `npm run bootstrap` (or `npm run build`) before `./verify`.
Adopting repos do NOT vendor a built bundle: they pin this repo as a submodule
and build `runner/dist/` locally in `ds-bootstrap.sh`, then run a thin
`scripts/verify` shim over it (see [docs/ADOPTION.md](docs/ADOPTION.md)).

## Telemetry

Each `./verify` run appends one JSON line (event shape:
`{v, startedAt, finishedAt, repo, scope, branch, head_sha, exit, aborted, results}`)
to an append-only effectiveness log, so we can measure what the gates actually catch.

`DS_TELEMETRY_PATH` has three values:

- **unset** → default sink `~/.local/share/dev-standards/events.jsonl` (one file per
  machine, shared across consumers; parent dir auto-created `0700`, file `0600`);
- **`off`** → disabled, nothing is written;
- **any other value** → that exact file path.

The write is **fail-open**: a broken sink never blocks a tier or fails a commit — it
prints one stderr warning and moves on. Because that warning is easy to miss,
`./verify --doctor` prints the resolved sink path and flags an unwritable sink.

The event's `reason` field carries env-provided free text (`DS_BYPASS_REASON`, spawn
errno). `DS_BYPASS_REASON` is sanitized once at its ingestion point
(`runner/src/redact.ts`, redact-then-cap): it is best-effort secret-redacted against a
deterministic pattern deny-list, then capped to 200 chars — *before* it fans out, so
both sinks (the persisted verify report and the telemetry event) receive the
already-sanitized value; the telemetry-side 200-char cap stays as defense-in-depth for
reasons of any origin. The deny-list is best-effort, not a full scanner, so **keep no
secrets in `DS_BYPASS_REASON`** — redaction is insurance, not permission.

Two readers sit over that sink. For a calibration session use the text report
(`node tools/quality-stats.mjs`). On a shared long-lived sink, bound it to the current
consumer with `--repo <quality.json repo>` and add `--summary` when only aggregate
effectiveness/cost is needed. For a "how are the gates doing" glance, generate the
self-contained visual dashboard — one offline HTML file, no server or deps:

```
node tools/quality-report.mjs --path <events.jsonl> --out quality-report.html [--days N] [--open]
```
