# dev-standards

Shared quality-system runner, schema, fixtures, and generated-adapter checks.

## Scope

This repo provides the core `./verify` runner (schema + hand validator, tiered
checks, skill-wrapper generation) and the optional `deep-review` refactor engine.
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
- `./tools/standards-sync --check`

`runner/dist/` is a build-on-demand artifact for `dev-standards` itself and is
git-ignored; run `npm run bootstrap` (or `npm run build`) before `./verify`. Only adopting repos vendor the
built `tools/verify-runner.mjs` — and only the `.mjs`, never the `.mjs.map`, which
embeds the original TypeScript via `sourcesContent`.
