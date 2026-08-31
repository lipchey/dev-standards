import plugin from "eslint-plugin-testing-library";
import jestDomPlugin from "eslint-plugin-jest-dom";

const TESTING_LIBRARY = "testing-library";
const JEST_DOM = "jest-dom";

/* The plugin defaults to "aggressive reporting": any TL-shaped name counts as a
   Testing Library util even in a file importing none, so a node test with its own
   `renderThing()` or `screen.debug()` under the consumer's glob would report. "off"
   on all three detection settings restores the import gate. Two rules sit outside it:
   `no-node-access` demands a real Testing Library import either way, and the jest-dom
   rules match assertion shapes with no gate at all. A consumer with a real custom
   render or query wrapper names it in its own override — one repo's test-utils path
   would be wrong for every other. */
const SETTINGS = {
  "testing-library/utils-module": "off",
  "testing-library/custom-renders": "off",
  "testing-library/custom-queries": "off",
};

/* Every rule of the installed plugin is disposed explicitly and `flat/react` is
   never spread, so an upstream severity change cannot reach a consumer silently; a
   rule an upgrade adds or drops turns the catalog test red. The three option-carrying
   entries restate `flat/react`'s values verbatim. */
const RULES = {
  "testing-library/await-async-events": ["error", { eventModule: "userEvent" }],
  "testing-library/await-async-queries": "error",
  "testing-library/await-async-utils": "error",
  "testing-library/consistent-data-testid": "off",
  "testing-library/no-await-sync-events": ["error", { eventModules: ["fire-event"] }],
  "testing-library/no-await-sync-queries": "error",
  "testing-library/no-container": "error",
  "testing-library/no-debugging-utils": "error",
  "testing-library/no-dom-import": ["error", "react"],
  "testing-library/no-global-regexp-flag-in-query": "error",
  "testing-library/no-manual-cleanup": "error",
  "testing-library/no-node-access": "error",
  "testing-library/no-promise-in-fire-event": "error",
  "testing-library/no-render-in-lifecycle": "error",
  "testing-library/no-test-id-queries": "error",
  "testing-library/no-unnecessary-act": "error",
  "testing-library/no-wait-for-multiple-assertions": "error",
  "testing-library/no-wait-for-side-effects": "error",
  "testing-library/no-wait-for-snapshot": "error",
  "testing-library/prefer-explicit-assert": "error",
  "testing-library/prefer-find-by": "error",
  "testing-library/prefer-implicit-assert": "off",
  "testing-library/prefer-presence-queries": "error",
  "testing-library/prefer-query-by-disappearance": "error",
  "testing-library/prefer-query-matchers": "off",
  "testing-library/prefer-screen-queries": "error",
  "testing-library/prefer-user-event": "off",
  "testing-library/prefer-user-event-setup": "off",
  "testing-library/render-result-naming-convention": "error",
};

/* `prefer-pressed` sits outside the plugin's `recommended`; jest-dom 7 ships the
   `toBePressed()` matcher it suggests, so it is not vacuous here. */
const JEST_DOM_RULES = {
  "jest-dom/prefer-checked": "error",
  "jest-dom/prefer-empty": "error",
  "jest-dom/prefer-enabled-disabled": "error",
  "jest-dom/prefer-focus": "error",
  "jest-dom/prefer-in-document": "error",
  "jest-dom/prefer-pressed": "error",
  "jest-dom/prefer-required": "error",
  "jest-dom/prefer-to-have-attribute": "error",
  "jest-dom/prefer-to-have-class": "error",
  "jest-dom/prefer-to-have-style": "error",
  "jest-dom/prefer-to-have-text-content": "error",
  "jest-dom/prefer-to-have-value": "error",
};

/* Spread first: `Array#every` SKIPS holes, so a sparse `new Array(1)` would pass and
   scope the preset to nothing. A blank glob is the same silent no-op. */
const isGlobList = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  [...value].every((item) => typeof item === "string" && item.trim() !== "");

/* @param {{ files: string[], jestDom?: boolean }} input */
export const testingLibrary = ({ files, jestDom = false } = {}) => {
  if (!isGlobList(files)) {
    throw new TypeError(
      "testingLibrary preset: `files` must be a non-empty array of non-blank glob strings — the consumer owns which tests get RTL rules",
    );
  }
  if (typeof jestDom !== "boolean") {
    throw new TypeError(
      "testingLibrary preset: `jestDom` must be a boolean — pass true only where @testing-library/jest-dom matchers are installed",
    );
  }

  return [
    {
      files,
      plugins: jestDom
        ? { [TESTING_LIBRARY]: plugin, [JEST_DOM]: jestDomPlugin }
        : { [TESTING_LIBRARY]: plugin },
      settings: SETTINGS,
      rules: jestDom ? { ...RULES, ...JEST_DOM_RULES } : { ...RULES },
    },
  ];
};
