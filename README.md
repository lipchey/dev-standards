# dev-standards

Shared quality-system runner, schema, and fixtures.

## Scope

This repo provides the core `./verify` runner (schema + hand validator, tiered
checks) and the optional `deep-review` refactor engine.
It does not implement red-main tracking, health digests, baseline-diff promotion,
or automated repo adoption.

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
git-ignored; run `npm run bootstrap` (or `npm run build`) before `./verify`. Only adopting repos vendor the
built `tools/verify-runner.mjs` — and only the `.mjs`, never the `.mjs.map`, which
embeds the original TypeScript via `sourcesContent`.

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
errno), truncated to 200 chars. **Keep no secrets in `DS_BYPASS_REASON`** — it is
persisted to the log verbatim.

Two readers sit over that sink. For a calibration session use the text report
(`node tools/quality-stats.mjs`). For a "how are the gates doing" glance, generate the
self-contained visual dashboard — one offline HTML file, no server or deps:

```
node tools/quality-report.mjs --path <events.jsonl> --out quality-report.html [--days N] [--open]
```
