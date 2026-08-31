import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import plugin from "eslint-plugin-testing-library";
import jestDomPlugin from "eslint-plugin-jest-dom";
import { testingLibrary } from "../../eslint/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_GLOB = ["tests/eslint/fixtures/**/*.{ts,tsx}"];

/* The disposition of every rule, restated as a literal: the preset is the subject
   under test, so reading its own matrix back would assert nothing. What goes red is a
   swapped value here or there, and a rule the installed plugin gains or drops — NOT a
   severity `flat/react` changes upstream, which the preset never inherits. */
const TESTING_LIBRARY_MATRIX = {
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

const JEST_DOM_MATRIX = {
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

const catalog = (rules, namespace) => Object.keys(rules).map((name) => `${namespace}/${name}`).sort();

test("the matrix covers the installed testing-library catalog exactly", () => {
  assert.deepStrictEqual(
    Object.keys(TESTING_LIBRARY_MATRIX).sort(),
    catalog(plugin.rules, "testing-library"),
  );
});

test("the matrix covers the installed jest-dom catalog exactly", () => {
  assert.deepStrictEqual(Object.keys(JEST_DOM_MATRIX).sort(), catalog(jestDomPlugin.rules, "jest-dom"));
});

test("jestDom: true ships both matrices verbatim", () => {
  const blocks = testingLibrary({ files: FIXTURE_GLOB, jestDom: true });
  assert.equal(blocks.length, 1);
  const [block] = blocks;
  assert.deepStrictEqual(block.files, FIXTURE_GLOB);
  assert.deepStrictEqual(block.rules, { ...TESTING_LIBRARY_MATRIX, ...JEST_DOM_MATRIX });
  assert.deepStrictEqual(Object.keys(block.plugins).sort(), ["jest-dom", "testing-library"]);
  assert.deepStrictEqual(block.settings, {
    "testing-library/utils-module": "off",
    "testing-library/custom-renders": "off",
    "testing-library/custom-queries": "off",
  });
});

test("jestDom defaults to false and then ships no jest-dom rule or plugin", () => {
  for (const options of [{ files: FIXTURE_GLOB }, { files: FIXTURE_GLOB, jestDom: false }]) {
    const blocks = testingLibrary(options);
    assert.equal(blocks.length, 1);
    const [block] = blocks;
    assert.deepStrictEqual(block.files, FIXTURE_GLOB);
    assert.deepStrictEqual(block.rules, TESTING_LIBRARY_MATRIX);
    assert.deepStrictEqual(Object.keys(block.plugins), ["testing-library"]);
    assert.equal(
      Object.keys(block.rules).some((ruleId) => ruleId.startsWith("jest-dom/")),
      false,
    );
  }
});

for (const [label, options] of [
  ["no argument at all", undefined],
  ["missing files", {}],
  ["empty files", { files: [] }],
  ["files that is not an array", { files: "tests/**/*.tsx" }],
  ["files holding a non-string", { files: ["tests/**/*.tsx", 7] }],
  ["files holding a blank glob", { files: [""] }],
  ["files holding a whitespace-only glob", { files: ["tests/**/*.tsx", "  "] }],
  ["a sparse files array", { files: new Array(1) }],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => testingLibrary(options), {
      name: "TypeError",
      message: /`files` must be a non-empty array of non-blank glob strings/,
    });
  });
}

for (const jestDom of [null, 0, "false", {}]) {
  test(`rejects jestDom: ${JSON.stringify(jestDom)}`, () => {
    assert.throws(() => testingLibrary({ files: FIXTURE_GLOB, jestDom }), {
      name: "TypeError",
      message: /`jestDom` must be a boolean/,
    });
  });
}

/* The exact-ruleId oracle: each bad fixture is built to fire exactly one rule, and the
   sibling smoke asserts only that the defect is not silent — which would still pass if
   a fixture started firing a second rule. */
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    },
    ...testingLibrary({ files: FIXTURE_GLOB, jestDom: true }),
  ],
});

const EXPECT = {
  "tests/eslint/fixtures/bad/tl-node-access.test.tsx": ["testing-library/no-node-access"],
  "tests/eslint/fixtures/bad/tl-async-utils.test.tsx": ["testing-library/await-async-utils"],
  "tests/eslint/fixtures/bad/tl-render-naming.test.tsx": [
    "testing-library/render-result-naming-convention",
  ],
  "tests/eslint/fixtures/bad/jd-enabled-disabled.test.tsx": ["jest-dom/prefer-enabled-disabled"],
  "tests/eslint/fixtures/good/tl-clean.test.tsx": [],
  "tests/eslint/fixtures/good/dom-without-rtl.test.ts": [],
};

const results = await eslint.lintFiles(Object.keys(EXPECT));
const byName = new Map(results.map((result) => [path.relative(root, result.filePath), result]));

for (const [file, ruleIds] of Object.entries(EXPECT)) {
  test(`${path.basename(file)} reports exactly ${ruleIds.join(", ") || "nothing"}`, () => {
    const result = byName.get(file);
    assert.ok(result, `no lint result for ${file}`);
    assert.deepStrictEqual(result.messages.map((message) => message.ruleId), ruleIds);
  });
}
