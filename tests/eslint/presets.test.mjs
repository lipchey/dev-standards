import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import {
  core,
  regexp,
  node,
  test as testPreset,
  frontend,
  frontendVite,
  frontendNext,
  sonarjs,
  testingLibrary,
} from "../../eslint/index.js";
import { SMOKE_DISPOSITIONS, SMOKE_RULE } from "./sonarjs-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/* One config exercising every preset; the frontend-variant presets are scoped to
   their own fixture subdirs so a bad-<preset> file is judged by that preset only. */
const config = [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  ...core,
  ...regexp,
  ...node({ files: ["**/*.ts"] }),
  ...testPreset,
  ...frontend({ files: ["**/*.tsx"] }),
  ...frontendVite({ files: ["**/fixtures/bad/vite/**/*.tsx"] }),
  ...frontendNext({ files: ["**/fixtures/bad/next/**/*.tsx"] }),
  /* The disposition matrix belongs to the consumer (DQ1-D1); this smoke passes a
     generated all-off map with exactly one rule enabled, so the fixture proves
     the factory really wires the plugin in. */
  ...sonarjs({ dispositions: SMOKE_DISPOSITIONS, files: ["**/*.{ts,tsx}"] }),
  /* `{ts,tsx}`, not `tsx`: the import-gate fixture is a .ts file, and the preset
     reaches only what its own glob names. */
  ...testingLibrary({ files: ["tests/eslint/fixtures/**/*.{ts,tsx}"], jestDom: true }),
];

const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
const results = await eslint.lintFiles(["tests/eslint/fixtures/**/*.{ts,tsx}"]);
const byName = new Map(results.map((r) => [path.relative(root, r.filePath), r]));

/* Each bad fixture MUST be flagged by exactly this rule — if a preset silently
   stops catching its defect, the assertion goes red (the point of the smoke). */
const EXPECT = {
  "tests/eslint/fixtures/bad/blank-disable.ts": "@eslint-community/eslint-comments/no-unlimited-disable",
  "tests/eslint/fixtures/bad/redos.ts": "regexp/no-super-linear-backtracking",
  "tests/eslint/fixtures/bad/focused.test.ts": "vitest/no-focused-tests",
  "tests/eslint/fixtures/bad/set-state.tsx": "react-hooks/set-state-in-render",
  "tests/eslint/fixtures/bad/deprecated-node.ts": "n/no-deprecated-api",
  "tests/eslint/fixtures/bad/a11y.tsx": "jsx-a11y/alt-text",
  "tests/eslint/fixtures/bad/vite/bad-export.tsx": "react-refresh/only-export-components",
  "tests/eslint/fixtures/bad/next/img.tsx": "@next/next/no-img-element",
  "tests/eslint/fixtures/bad/sonarjs.ts": `sonarjs/${SMOKE_RULE}`,
  "tests/eslint/fixtures/bad/tl-node-access.test.tsx": "testing-library/no-node-access",
  "tests/eslint/fixtures/bad/tl-async-utils.test.tsx": "testing-library/await-async-utils",
  "tests/eslint/fixtures/bad/tl-render-naming.test.tsx": "testing-library/render-result-naming-convention",
  "tests/eslint/fixtures/bad/jd-enabled-disabled.test.tsx": "jest-dom/prefer-enabled-disabled",
};

for (const [file, ruleId] of Object.entries(EXPECT)) {
  test(`flags ${ruleId} in ${path.basename(file)}`, () => {
    const r = byName.get(file);
    assert.ok(r, `no lint result for ${file}`);
    /* presence at any severity — some upstream presets ship a rule as warn
       (Next's no-img-element); the smoke only proves the defect is not silent. */
    const hit = r.messages.some((m) => m.ruleId === ruleId);
    assert.ok(hit, `expected ${ruleId}; got: ${r.messages.map((m) => m.ruleId).join(", ") || "(none)"}`);
  });
}

for (const file of [
  "tests/eslint/fixtures/good/clean.ts",
  "tests/eslint/fixtures/good/component.tsx",
  "tests/eslint/fixtures/good/tl-clean.test.tsx",
  /* No `@testing-library/*` import: direct DOM access and a home-grown render helper
     both stay clean, which is the import gate the preset's settings restore. */
  "tests/eslint/fixtures/good/dom-without-rtl.test.ts",
]) {
  test(`no errors in ${path.basename(file)}`, () => {
    const r = byName.get(file);
    assert.ok(r, `no lint result for ${file}`);
    assert.equal(r.errorCount, 0, `unexpected errors: ${r.messages.filter((m) => m.severity === 2).map((m) => m.ruleId).join(", ")}`);
  });
}
