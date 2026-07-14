# dev-standards ESLint presets

Composable ESLint 9 flat-config presets, shipped as a local package so a consumer
inherits both the rules **and** the exact plugin versions through the `file:` dep —
no per-project plugin install. Import what a stack needs; append your own layer.

```js
// consumer eslint.config.js
import { core, regexp, node, test, frontend, frontendVite, frontendNext, constantsHome } from "dev-standards/eslint";

export default tseslint.config(
  { ignores: [/* … */] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked, // consumer OWNS the typed base + parserOptions
  ...core,
  ...test,
  ...node({ files: ["packages/**/*.ts", "tools/**/*.ts"] }),
  ...frontend({ files: ["apps/web/**/*.tsx", "apps/site/**/*.tsx"] }),
  ...frontendVite({ files: ["apps/web/**/*.tsx"] }),
  ...frontendNext({ files: ["apps/site/**/*.tsx"] }),
  { /* repo-local overrides: no-restricted-imports boundaries, etc. */ },
);
```

## Design constraints (why it is shaped this way)

- **Presets are additive layers, never a base.** They set their own rule keys and
  never re-establish `typescript-eslint`'s typed config — the consumer owns that
  plus `parserOptions`, so type-checking runs once and the parser is configured once.
- **Curated subsets, not upstream `recommended`, where the preset is broad or
  opinionated** (`n`, and the frontend render rules). Where an upstream preset is
  itself tight and low-noise, it is shipped whole (`regexp` flat/recommended,
  `jsx-a11y` recommended, `react-refresh`, Next core-web-vitals).
- **No redundancy with the assumed consumer stack.** Async-promise correctness is
  left to the typed `typescript-eslint` rules; formatting to Prettier; dead code to
  knip; unused-disable to ESLint-native `reportUnusedDisableDirectives` (so
  `eslint-comments/no-unused-disable`, which upstream deprecated for that reason, is
  not used).

## Presets

| Export | Stacks | Ships |
|---|---|---|
| `core` | all | `reportUnusedDisableDirectives: error`; `eslint-comments/no-unlimited-disable` (error, bans bare `// eslint-disable`); `require-description` (warn) |
| `regexp` | all / regex-heavy | `eslint-plugin-regexp` flat/recommended — regex correctness + a best-effort ReDoS (super-linear-backtracking) guard |
| `node({files})` | node-service, n8n-ops | `n/no-unsupported-features/node-builtins` + `n/no-deprecated-api` only — cherry-picked so the preset's publish/missing-import rules do not false-fire on transpiled TS |
| `test` | all (vitest) | vitest recommended, test-glob-scoped; `no-focused-tests` error (fail CI on a stray `.only`), `no-disabled-tests` warn (skips can be legitimate) |
| `frontend({files})` | frontend-web | `jsx-a11y` recommended + `react-hooks` flat/recommended + `react-hooks/set-state-in-render`. **Owns the react-hooks rules** — drop any separate react-hooks block in the consumer or the two double-report |
| `frontendVite({files})` | frontend-web (Vite) | `react-refresh/only-export-components` — Fast-Refresh integrity. Vite only; Next runs its own |
| `frontendNext({files})` | frontend-web (Next) | `@next/eslint-plugin-next` core-web-vitals. Next site only |
| `constantsHome({files, ignores})` | all | custom `dev-standards/constants-home` (error): a module-scope `const` bound to a bare primitive literal must move to a constants home. A custom rule in an inline plugin — **not** `no-restricted-syntax` — so it never clobbers a consumer's own naming gate (see below) |

The factory presets (`node`, `frontend*`, `constantsHome`) take `{ files }` (and
`constantsHome` also `{ ignores }`) because a monorepo must scope stack rules to the
right subtree — React rules must not reach node packages, and the constants gate must
not fire in the constants homes it points people toward.

## `constantsHome` — value constants out of logic files

Turns the review-only "value constants never sit inline in logic files" rule into a
gate. It flags a **module-scope** `const` whose initializer is a bare primitive VALUE:
a number/string/boolean literal, a unary `+`/`-` on a numeric literal, an expressionless
template (`` `fixed` ``), or any of those inside a TS `as const` cast.

It ships a custom rule inside an inline plugin, **not** a `no-restricted-syntax` config:
flat config REPLACES (never merges) same-rule options, so a shared `no-restricted-syntax`
entry would silently erase a consumer's own `no-restricted-syntax` naming gate (or the
reverse). The distinct `dev-standards/constants-home` id cannot collide. The preset
hard-codes NO paths — pass your own globs:

```js
...constantsHome({
  files: ["src/**/*.ts"],                    // the workspace source (logic) globs
  ignores: [                                 // the homes the message points to, plus non-logic files
    "**/src/constants/**", "**/constants.ts",
    "**/*.test.ts", "**/*.d.ts",
    // + any repo-specific config homes that legitimately hold literals
  ],
}),
```

**Ceilings — review-owned, deliberately NOT caught:** a function-local literal
(`const t = 500;` inside a function or block) and a literal-only arithmetic initializer
(`const MS = 45 * 60 * 1000;` — a `BinaryExpression`, not a literal) both stay
review-owned. Object literals and option-defaults objects (`const defaults = { gap: 500 }`)
are intentionally left in place.

## Version pins that matter

- The plugins are `dependencies` of this package, so a consumer's `file:` install
  pins them centrally — bump here once, every consumer inherits it on the next pin.
- Everything here is ESLint-9-clean. **When moving consumers to ESLint 10**, that is
  also the moment to add `eslint-plugin-unicorn` (its ≥66 line requires ESLint 10.4;
  the ESLint-9 line is stuck at 65.x — held out of v1 to avoid a compat island).
- **ESLint 10 is blocked today** by two plugins shipped here as `dependencies`, so a
  consumer on `eslint@10` hits `ERESOLVE` on install regardless of which presets it
  uses: `eslint-plugin-jsx-a11y` (latest 6.10.2 peers `^3…^9`, no ^10) and
  `eslint-plugin-react-hooks@6` (peer `^3…^9`; ^10 lands only in 7.x — a major bump).
  Revisit the ESLint-10 move — the unicorn moment above — once both ship ^10 peer
  support.

## Deliberately opt-in / not shipped (v1)

Add per-repo only where the trigger is real; none belong in the shared default:

- **`import-x/no-cycle`** (circular deps) — graph-wide and resolver-sensitive (needs
  the TS resolver pointed at the repo's tsconfig); enable only where cycles are a
  demonstrated risk. Held out of v1 pending a stable resolver wiring.
- **`eslint-plugin-unicorn`, `sonarjs`** — real value but heavy curation; add a small
  bug subset per repo, not a universal inheritance.
- **`@eslint-react`** — its render-safety overlaps `react-hooks@6` (already shipped by
  `frontend`), and it needs Node 22; add only for its effect-leak family.
- **`@tanstack/eslint-plugin-query`** (if react-query), **`eslint-plugin-tailwindcss`**
  (if Tailwind, `no-contradicting-classname` only), **`testing-library`/`jest-dom`**
  (if RTL), **`@eslint/json`** (n8n JSON exports), **`i18next`** (scope tightly — noisy).
