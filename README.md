# dev-standards

Shared quality-system runner, schema, fixtures, and generated-adapter checks.

## Phase 1a Scope

This release contains the core `./verify` runner and disabled-workflow manifest
support. It does not implement the optional workflow helper, enabled workflow
validation, red-main tracking, health digests, baseline-diff promotion, or repo
adoption.

## Verification

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `./verify --doctor`
- `./verify --fast`
- `./verify --full`
- `./tools/standards-sync --check`

`runner/dist/` is a build-on-demand artifact for `dev-standards` itself and is
git-ignored; run `npm run build` before `./verify`. Only adopting repos vendor the
built `tools/verify-runner.mjs` — and only the `.mjs`, never the `.mjs.map`, which
embeds the original TypeScript via `sourcesContent`.
