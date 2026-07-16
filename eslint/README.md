# dev-standards ESLint presets

Composable ESLint 9 flat-config presets, shipped as a local package so a consumer
inherits both the rules **and** the exact plugin versions through the `file:` dep —
no per-project plugin install. Import what a stack needs; append your own layer.

```js
// consumer eslint.config.js
import {
  core,
  regexp,
  node,
  test,
  frontend,
  frontendVite,
  frontendNext,
  constantsHome,
  inlineLiterals,
  comparisonLiterals,
  typesHome,
  propertyNaming,
  naming,
} from "dev-standards/eslint";

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
  ...naming(),
  ...constantsHome({
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}"],
    ignores: ["**/src/constants/**", "**/constants.ts", "**/*.d.ts"],
  }),
  ...inlineLiterals({
    files: ["packages/**/*.ts", "apps/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    ignores: ["**/*.d.ts"],
  }),
  ...comparisonLiterals({
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}"],
    ignores: ["**/src/constants/**", "**/constants.ts", "**/*.d.ts"],
  }),
  ...typesHome({
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}"],
    ignores: ["**/src/types/**", "**/types.ts", "**/*.d.ts"],
    allowNamePattern: "Props$",
  }),
  ...propertyNaming({
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}"],
    ignores: ["**/contracts/wire/**", "**/generated/**", "**/*.d.ts"],
  }),
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
- **One custom-plugin identity across presets.** `constantsHome`, `typesHome`, and
  `propertyNaming` all register the exported `devStandardsPlugin` object. Overlapping
  flat-config entries cannot redefine the same plugin name with different objects.
- **The consumer's TypeScript ESLint base owns its plugin registration.**
  `inlineLiterals` configures `@typescript-eslint/no-magic-numbers` without registering
  another plugin object, so place it after a `typescript-eslint` base as shown above.

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
| `constantsHome({files, ignores})` | all | custom `dev-standards/constants-home` (error): a module-scope `const` bound to a bare primitive literal must move to a constants home. A custom rule in the shared plugin — **not** `no-restricted-syntax` — so it never clobbers a consumer's own naming gate (see below) |
| `inlineLiterals({files, ignores, ignore})` | all | `@typescript-eslint/no-magic-numbers` (error), with `0`, `1`, `-1`, array indexes, enums, numeric literal types, readonly class properties, and type indexes ignored. Consumer `ignore` values extend the pinned numeric list |
| `comparisonLiterals({files, ignores, severity})` | all | custom `dev-standards/comparison-literals` (default error): a bare string literal in an equality comparison (`tag === "INPUT"`) or a `switch` case is a magic value — compare against a named constant/union member. `typeof` operands, empty string, and union type declarations exempt. `severity` (default `"error"`) exists for the WARN-first ramp — see below |
| `typesHome({files, ignores, allowNamePattern})` | all | custom `dev-standards/types-home` (error): exported top-level interfaces and type aliases belong in the consumer's types home. `allowNamePattern` defaults to `"Props$"` |
| `propertyNaming({files, ignores})` | all | custom `dev-standards/property-naming` (error): non-computed identifier keys on TypeScript property signatures must be at least three characters; `_` remains the discard convention |
| `naming({files, ignores, exemptNamedImports, extraRestrictedSyntax})` | all | the identifier floor: `no-restricted-syntax` min-3-chars over every name the repo's authors choose (vars, functions, classes, params, catch/destructured bindings, class members, ALL import locals incl. aliases) + `id-match` ASCII-only. `_` discard and object PROPERTY keys exempt. **Owns `no-restricted-syntax` in its scope** (see below) |
| `devStandardsPlugin` | advanced composition | the single plugin object containing `constants-home`, `types-home`, `property-naming`, and `comparison-literals`; preset factories already register it |

The factory presets (`node`, `frontend*`, `constantsHome`, `inlineLiterals`,
`typesHome`, `propertyNaming`, `naming`) take `{ files }` (and, where relevant,
`{ ignores }`) because a monorepo must scope stack rules to the right subtree — React
rules must not reach node packages, and repository-layout gates must not fire in the
homes or external-contract files they deliberately exempt.

## `naming` — the length/ASCII floor for identifiers

Promoted from the ai-prompter pilot (owner rules): every identifier the repo's authors
choose is ≥3 chars and ASCII. The floor deliberately does NOT judge meaning — pair it
with an OPERATIONAL naming section in the consumer's `.claude/code-conventions.md`
(blessed-abbreviation allowlist per the code-conventions template), which is where the
report message points.

Flat config REPLACES same-rule options, so this preset **owns `no-restricted-syntax`
within its scope**: a consumer block that also sets `no-restricted-syntax` on the same
files would silently erase the floor (or be erased). Repo-specific selectors therefore
go through the factory:

```js
...naming({
  exemptNamedImports: ["vi"],                       // framework-canonical short externals; extend in the PR that adds one
  extraRestrictedSyntax: [                          // repo-specific selectors ride the SAME rule entry
    { selector: "DebuggerStatement", message: "no debugger" },
  ],
}),
```

## `constantsHome` — value constants out of logic files

Turns the review-only "value constants never sit inline in logic files" rule into a
gate. It flags a **module-scope** `const` whose initializer is a bare primitive VALUE:
a number/string/boolean literal, a unary `+`/`-` on a numeric literal, an expressionless
template (`` `fixed` ``), or any of those inside a TS `as const` cast.

It ships a custom rule inside the shared plugin, **not** a `no-restricted-syntax` config:
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

**Ceilings — what this rule deliberately does NOT catch:** a function-local literal
(`const t = 500;` inside a function or block) and a literal-only arithmetic initializer
(`const MS = 45 * 60 * 1000;` — a `BinaryExpression`, not a literal). The arithmetic
case is NOT review-owned anymore — `inlineLiterals` flags each numeric operand, in any
scope. A function-local `const` bound to a bare literal is the one numeric form no gate
catches (the value is named; whether its home is right stays review-owned), alongside
inline strings and out-of-glob files. Object literals and option-defaults objects
(`const defaults = { gap: 500 }`) are intentionally left in place.

## `inlineLiterals` — named numeric values in logic and tests

Wraps `@typescript-eslint/no-magic-numbers` with a low-noise numeric floor. It ignores
`0`, `1`, and `-1`, plus array indexes, enums, numeric literal types, readonly class
properties, and type indexes. Values passed through `ignore` extend rather than replace
the pinned list:

```js
...inlineLiterals({
  files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
  ignores: ["**/*.d.ts"],
  ignore: [100],
}),
```

The preset intentionally does not register `@typescript-eslint`: the consumer's
`typescript-eslint` base must precede it and supplies the exact plugin object already in
the flat config. This preset is numeric-only; magic STRINGS in comparisons are `comparisonLiterals`'
job, and strings elsewhere stay review-owned.

## `comparisonLiterals` — magic strings out of comparisons

The string counterpart to `inlineLiterals`: a bare string literal compared for equality
(`x === "lit"`, `!==`, `==`, `!=`) or matched in a `switch` case (`case "lit":`) is a
magic value the numeric gates never see — the `tag === "INPUT"` shape a full deep-review
fan-out once marked clean. Compare against a named constant or the union/enum member the
value already declares (`x === INPUT_TAG`, `event.type === EVENT_TYPES.VAD`).

Like `constantsHome` it is a custom rule with a distinct id (`dev-standards/comparison-literals`),
**not** `no-restricted-syntax` — flat config REPLACES same-rule options, so a shared
`no-restricted-syntax` entry would clobber the `naming` floor. The rule reports once per
comparison and unwraps a transparent TS cast (`x === ("INPUT" as Tag)`) and an
expressionless backtick (`` x === `INPUT` ``) so a spelling trick cannot bypass it.

```js
...comparisonLiterals({
  files: ["src/**/*.ts", "src/**/*.tsx"],
  ignores: ["**/src/constants/**", "**/constants.ts", "**/*.test.ts", "**/*.d.ts"],
}),
```

An existing consumer adopting the gate passes `severity: "warn"` on this same block
to ramp it in, triages the hit list, then drops the param to reach error.

**Exempt in the rule (universal):** the empty string; a `typeof` operand
(`typeof x === "string"` is a language-level return, not a magic value, in either yoda
order). **Exempt by construction:** a comparison with no string literal (`x === CONST`),
and a union/enum type DECLARATION (`type Tag = "INPUT" | ...`) — the rule matches only
value-position comparison nodes, never the type's `TSLiteralType`s, so the type is the
home, not a magic use.

**The `severity` param and the WARN ramp.** Siblings hard-code `error`; this factory takes
`severity` (default `error`) so an existing consumer can adopt it at `"warn"` and triage
the hit list before flipping to error. It is a param — not a separate warn-override block —
on purpose: a second block that set the rule to warn without re-registering the plugin
would crash ESLint (`Could not find plugin "dev-standards"`) on any file the preset's own
`ignores` drop. New consumers and the seed keep the default `error`.

**Ceilings — deliberately NOT caught (review-owned or opt-in):** `.has("lit")` /
`.includes("lit")` membership checks (needs a known-set type; noisy — opt in per repo if a
demonstrated need appears); interpolated and tagged templates and ternary-valued operands
(dynamic, not a fixed magic value); and every string position outside a comparison or
switch (object values, call arguments, JSX props) — those stay with the naming-and-constants
review profile.

## `typesHome` — exported declarations in the types home

Flags top-level interfaces and type aliases exported directly or through a same-file
`export { Name }`, `export type { Name }`, or `export default Name`. Non-exported local
helpers, ambient declarations, and re-exports from another module are not flagged.
Scope out declaration files and the actual types home with `ignores`:

```js
...typesHome({
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["**/src/types/**", "**/types.ts", "**/*.d.ts"],
  allowNamePattern: "Props$",
}),
```

`allowNamePattern` is a string regular expression, defaults to `"Props$"`, and is
validated when the factory builds the config. Invalid strings throw before lint starts.

**Ceiling:** the exemption is name-based, so a non-component `StorageProps` in a plain
`.ts` file also escapes the gate — judging that misuse is the review profile's job. A
consumer wanting a mechanical split can compose two entries (the shared plugin object
makes that safe): `typesHome({files: ["**/*.tsx"], allowNamePattern: "Props$"})` plus
`typesHome({files: ["**/*.ts"], allowNamePattern: "^(?!)"})` (a never-matching regex).

## `propertyNaming` — the TypeScript property-signature floor

Flags non-computed identifier keys shorter than three characters on
`TSPropertySignature` nodes in interfaces and type literals. `_` remains allowed.
Class fields stay owned by `naming`, and object-literal keys are not checked. Exempt
externally fixed wire keys by ignoring their modules rather than creating a global key
allowlist:

```js
...propertyNaming({
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["**/contracts/wire/**", "**/generated/**", "**/*.d.ts"],
}),
```

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
