/* Seeded by dev-standards seed-eslint-config.sh (copy-if-absent). Now repo-owned —
   edit freely; re-seeding never overwrites it. Presets and their pinned plugin
   versions arrive through the dev-standards file: dep; the typed base and
   parserOptions stay yours (the presets never re-establish them). */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
/* Per-stack presets (node, frontend, frontendVite, frontendNext) are imported
   only when their block below is uncommented — an unused import is itself a
   lint error in the seeded file. */
import { core, regexp, test } from "dev-standards/eslint";

export default tseslint.config(
  { ignores: ["**/dist", "vendor", "node_modules", ".artifacts"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  ...core,
  ...test,
  ...regexp,
  // Node stacks — add `node` to the dev-standards/eslint import and scope to your
  // source dirs (delete for a pure frontend):
  //   ...node({ files: ["src/**/*.ts"] }),
  // Frontend — add `frontend`/`frontendVite`/`frontendNext` to the import and scope
  // to your app dirs (delete for a pure node service). frontend OWNS the react-hooks
  // rules, so do not add a separate react-hooks block:
  //   ...frontend({ files: ["src/**/*.tsx"] }),
  //   ...frontendVite({ files: ["src/**/*.tsx"] }),   // Vite app only
  //   ...frontendNext({ files: ["app/**/*.tsx"] }),   // Next site only
  // Constants-home gate — a module-scope const bound to a bare primitive literal
  // belongs in a constants home, not inline in a logic file. Add `constantsHome`
  // to the dev-standards/eslint import; scope `files` to your source and `ignores`
  // to your constants homes + non-logic files (tests, .d.ts, config homes):
  //   ...constantsHome({
  //     files: ["src/**/*.ts"],
  //     ignores: ["**/src/constants/**", "**/constants.ts", "**/*.test.ts", "**/*.d.ts"],
  //   }),
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
