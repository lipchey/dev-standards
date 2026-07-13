/* Additive layers only: consumers keep their own typescript-eslint typed base
   + parserOptions; these presets never re-establish it (a second base would
   double-configure the parser and run type-checking twice). */
import comments from "@eslint-community/eslint-plugin-eslint-comments";
import regexpPlugin from "eslint-plugin-regexp";

/* Directive hygiene, all stacks. no-unlimited-disable bans a bare
   `// eslint-disable` with no rule id (the silent-suppression hole a standards
   repo exists to close). Unused-disable detection is ESLint-native via
   reportUnusedDisableDirectives, so eslint-comments/no-unused-disable is
   deliberately unused (upstream deprecated it for that reason). */
export const core = [
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@eslint-community/eslint-comments": comments },
    rules: {
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/require-description": ["warn", { ignore: [] }],
    },
  },
];

/* Upstream's static super-linear-backtracking detector catches simple ReDoS
   shapes only — a guardrail, not a proof of safety. Low false-positive so it is
   safe unscoped; wrap in a `files` block for regex-heavy packages if it ever is. */
export const regexp = [regexpPlugin.configs["flat/recommended"]];
