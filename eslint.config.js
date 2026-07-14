/* Deliberately absent presets: `test` — core tests run on node:test (tsx --test),
   not vitest, so the vitest rules would never fire honestly here; `frontend*` —
   no frontend code in this repo. */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import { core, regexp, node } from "./eslint/index.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "node_modules",
      "reports",
      "tests/fixtures",
      "tests/eslint/fixtures",
      ".handoff",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  ...core,
  ...regexp,
  /* Codebase convention: a leading underscore marks a deliberately unused
     binding (e.g. void-swallowed spawn results); the default rule setup does
     not honor it. */
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  ...node({
    files: ["runner/src/**/*.ts", "deep-review/src/**/*.ts", "tools/**/*.mjs", "scripts/**/*.mjs"],
  }),
  /* node:test files: test()/describe() return a Promise that is conventionally
     un-awaited at top level — allow exactly those calls, keep the rule alive for
     everything else. JSON-fixture poking makes the unsafe-* family pure noise in
     tests; the typed rules still guard runner/ and deep-review/ source. */
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", name: ["test", "describe", "it", "suite"], package: "node:test" },
          ],
        },
      ],
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowBoolean: true, allowNumber: true },
      ],
    },
  },
  /* Config/tool JS live outside the tsconfig project — typed rules crash on them.
     disableTypeChecked resets the parser; globals.node keeps no-undef quiet on
     `process` etc. in every tools/*.mjs. Merge the two languageOptions: a bare
     `languageOptions: { globals }` would clobber disableTypeChecked's parser reset,
     leaving projectService on and crashing every JS file outside the tsconfig. */
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
