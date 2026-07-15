import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import {
  constantsHome,
  devStandardsPlugin,
  inlineLiterals,
  naming,
  propertyNaming,
  typesHome,
} from "../../eslint/index.js";

const FILES = ["**/*.ts"];

test("all Tier 1 presets compose on one TypeScript file", () => {
  const customPresets = [
    ...constantsHome({ files: FILES }),
    ...typesHome({ files: FILES }),
    ...propertyNaming({ files: FILES }),
    ...inlineLiterals({ files: FILES }),
    ...naming({ files: FILES }),
  ];

  for (const entry of customPresets.filter((candidate) => candidate.plugins?.["dev-standards"])) {
    assert.strictEqual(entry.plugins["dev-standards"], devStandardsPlugin);
  }

  const config = [{ ...tseslint.configs.base, files: FILES }, ...customPresets];
  const code = `
    export type RootType = { t: number };
    export const LIMIT = 2;
    export function assess(ab: number) { return ab > 3; }
  `;
  const messages = new Linter({ configType: "flat" }).verify(code, config, { filename: "src/logic.ts" });
  const ruleIds = new Set(messages.map((message) => message.ruleId));

  assert.ok(!messages.some((message) => message.fatal), messages.map((message) => message.message).join("\n"));
  assert.ok(ruleIds.has("dev-standards/constants-home"));
  assert.ok(ruleIds.has("dev-standards/types-home"));
  assert.ok(ruleIds.has("dev-standards/property-naming"));
  assert.ok(ruleIds.has("@typescript-eslint/no-magic-numbers"));
  assert.ok(ruleIds.has("no-restricted-syntax"));
});
