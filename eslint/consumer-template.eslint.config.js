/* Seeded by dev-standards seed-eslint-config.sh (copy-if-absent). Now repo-owned —
   edit freely; re-seeding never overwrites it. Presets and their pinned plugin
   versions arrive through the dev-standards file: dep; the typed base and
   parserOptions stay yours (the presets never re-establish them). */
/* `eslintJs`, not `js`: the active naming floor below lints THIS file too — a
   two-char import local would make the freshly seeded config red on itself. */
import eslintJs from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
/* Per-stack presets (node, frontend, frontendVite, frontendNext) are imported
   only when their block below is uncommented — an unused import is itself a
   lint error in the seeded file. */
import {
  core,
  regexp,
  test,
  naming,
  constantsHome,
  inlineLiterals,
  comparisonLiterals,
  typesHome,
  propertyNaming,
} from "dev-standards/eslint";

export default tseslint.config(
  { ignores: ["**/dist", "vendor", "node_modules", ".artifacts"] },
  eslintJs.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  ...core,
  ...test,
  ...regexp,
  /* Node stacks — add `node` to the dev-standards/eslint import and scope to your
     source dirs (delete for a pure frontend):
       ...node({ files: ["src/**\/*.ts"] }),
     Frontend — add `frontend`/`frontendVite`/`frontendNext` to the import and scope
     to your app dirs (delete for a pure node service). frontend OWNS the react-hooks
     rules, so do not add a separate react-hooks block:
       ...frontend({ files: ["src/**\/*.tsx"] }),
       ...frontendVite({ files: ["src/**\/*.tsx"] }),   (Vite app only)
       ...frontendNext({ files: ["app/**\/*.tsx"] }),   (Next site only) */
  /* Naming floor — ACTIVE from day one: every identifier the repo's authors
     choose is >=3 chars and ASCII (imports, params, destructuring and class
     members included; `_` discard and object PROPERTY keys exempt). What counts
     as MEANINGFUL lives in your .claude/code-conventions.md §Naming (blessed-
     abbreviation allowlist). The preset owns no-restricted-syntax in its scope —
     repo-specific selectors go through its extraRestrictedSyntax param, never a
     competing block on the same files: */
  ...naming(),
  /* Constants-home gate — ACTIVE from day one: a module-scope const bound to a
     bare primitive literal belongs in a constants home, not inline in a logic
     file. Widen `ignores` with repo-specific config homes; narrow `files` if
     only part of the tree is logic code: */
  ...constantsHome({
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["**/src/constants/**", "**/constants.ts", "**/*.test.ts", "**/*.d.ts"],
  }),
  /* New consumers keep these gates at error. Existing consumers should append
     temporary warn overrides during calibration, then remove them after cleanup. */
  ...inlineLiterals({
    files: ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"],
    ignores: ["**/*.d.ts"],
  }),
  /* Comparison-literals gate — ACTIVE at error from day one: a bare string
     literal in an equality comparison (`tag === "INPUT"`) or a `switch` case is a
     magic value the numeric gates never see; compare against a named constant or
     union member instead. `typeof`, empty string, and union type DECLARATIONS are
     exempt in the rule. Existing consumers ramp it in at `severity: "warn"` (the
     factory param) while triaging the hit list, then drop the param to reach
     error. Same homes as constants-home; tests start out of scope like
     constants-home — widen once the src churn is understood: */
  ...comparisonLiterals({
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["**/src/constants/**", "**/constants.ts", "**/*.test.ts", "**/*.d.ts"],
  }),
  /* Props$ is a name-based exemption: a non-component FooProps in a .ts file also
     escapes — review-owned. For a mechanical split, use two entries (tsx with
     Props$, ts with the never-matching "^(?!)"). */
  ...typesHome({
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["**/src/types/**", "**/types.ts", "**/*.d.ts"],
    allowNamePattern: "Props$",
  }),
  ...propertyNaming({
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["**/src/contracts/wire/**", "**/generated/**", "**/*.d.ts"],
  }),
  /* SonarJS — OPT-IN, and deliberately not seeded active (ADR-026): the factory
     ships no rule list, so it only builds once this repo owns a disposition for
     EVERY rule of the installed plugin. Add `sonarjs` to the dev-standards/eslint
     import, put the matrix in its own module, and uncomment:
       ...sonarjs({ dispositions, files: ["src/**\/*.ts", "src/**\/*.tsx"] }),
     Each entry is { disposition: "error" | "off", reason, note?, options? }.
     `reason` is closed: enabled | overlap:<ruleId> | owned-elsewhere:<gate> |
     hotspot-review | unproven | style-not-defect | cost-exceeds-value; every
     reason but `enabled` needs a non-empty note. An ENABLED rule must restate
     every value the plugin would merge in from meta.defaultOptions — a partial
     options object still inherits the rest. `warn` is rejected. */
  /* JS config files sit outside tsconfig — typed rules crash on them. globals.node
     keeps no-undef quiet on `process` etc.; merge the languageOptions so this block
     does not clobber disableTypeChecked's parser reset (bare `languageOptions: { globals }`
     would leave projectService on and crash every JS file outside tsconfig). */
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
