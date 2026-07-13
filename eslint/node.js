import n from "eslint-plugin-n";

const NODE_FILES = ["**/*.{js,mjs,cjs,ts,mts,cts}"];

/* Cherry-picked, NOT n/flat-recommended: the preset's publish/missing-import
   rules fire falsely on transpiled TS and unpublished workspace packages.
   no-unsupported-features/node-builtins reads the consuming package's own
   `engines.node` — an inaccurate/absent engines field makes the check vacuous. */
export const node = ({ files = NODE_FILES } = {}) => [
  {
    files,
    plugins: { n },
    rules: {
      "n/no-unsupported-features/node-builtins": "error",
      "n/no-deprecated-api": "error",
    },
  },
];
