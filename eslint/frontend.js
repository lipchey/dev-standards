import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import next from "@next/eslint-plugin-next";

const JSX_FILES = ["**/*.{jsx,tsx}"];

/* Consumer passes its own frontend dirs; in a monorepo the node packages must
   NOT receive React rules. react-hooks flat/recommended is OWNED here — a
   consumer spreading `frontend` drops any separate react-hooks block or the two
   configs double-report. set-state-in-render (react-hooks@6) is the one extra
   render-safety rule on by default: setState during render is an unconditional
   infinite re-render. The compiler-adjacent rules (purity/immutability/refs/
   static-components) stay opt-in — see README, they need a Compiler-clean codebase. */
export const frontend = ({ files = JSX_FILES } = {}) => [
  { files, ...jsxA11y.flatConfigs.recommended },
  /* flat/recommended is an array of config objects — scope each to `files`,
     then add the one extra render-safety rule in its own block. */
  ...reactHooks.configs["flat/recommended"].map((c) => ({ ...c, files })),
  { files, rules: { "react-hooks/set-state-in-render": "error" } },
];

/* Vite Fast-Refresh integrity: a non-component export in a component module
   silently downgrades HMR to a full reload. Vite app only — Next runs its own
   Fast Refresh, so do not spread this on the Next site. */
export const frontendVite = ({ files = JSX_FILES } = {}) => [
  { files, ...reactRefresh.configs.vite },
];

/* Next site only. core-web-vitals adds the Next footguns that neither TS nor the
   generic React rules can see (no-html-link-for-pages as error, no-img-element as
   warn — Next's own severities, left as upstream ships them). */
export const frontendNext = ({ files = JSX_FILES } = {}) => [
  { files, ...next.configs["core-web-vitals"] },
];
