import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import {
  comparisonLiterals,
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
    ...comparisonLiterals({ files: FILES }),
    ...naming({ files: FILES }),
  ];

  for (const entry of customPresets.filter((candidate) => candidate.plugins?.["dev-standards"])) {
    assert.strictEqual(entry.plugins["dev-standards"], devStandardsPlugin);
  }

  const config = [{ ...tseslint.configs.base, files: FILES }, ...customPresets];
  const code = `
    export type RootType = { t: number };
    export const LIMIT = 2;
    export const flag = mode === "on";
    export function assess(ab: number) { return ab > 3; }
  `;
  const messages = new Linter({ configType: "flat" }).verify(code, config, { filename: "src/logic.ts" });

  assert.ok(!messages.some((message) => message.fatal), messages.map((message) => message.message).join("\n"));

  const countByRule = new Map();
  for (const message of messages) {
    /* Every Tier 1 preset ships blocking severity — a silent downgrade to warn
       (severity 1) would pass a rule-id-only assertion. */
    assert.equal(message.severity, 2, `${message.ruleId} must report at error severity`);
    countByRule.set(message.ruleId, (countByRule.get(message.ruleId) ?? 0) + 1);
  }
  assert.equal(countByRule.get("dev-standards/constants-home"), 1);
  assert.equal(countByRule.get("dev-standards/types-home"), 1);
  assert.equal(countByRule.get("dev-standards/property-naming"), 1);
  /* One magic-string hit: `mode === "on"`. The `LIMIT`/`RootType` lines carry no
     comparison, so the count proves comparison-literals composed on the same file
     without clobbering (or being clobbered by) the other custom rules. */
  assert.equal(countByRule.get("dev-standards/comparison-literals"), 1);
  /* Exactly one numeric hit: `3` in the comparison. `LIMIT = 2` is a const
     declaration, which no-magic-numbers deliberately allows (a NAMED value) —
     that is constants-home's hit instead. */
  assert.equal(countByRule.get("@typescript-eslint/no-magic-numbers"), 1);
  assert.equal(countByRule.get("no-restricted-syntax"), 1);

  /* Ownership split stays disjoint: the property key `t` (fixture line 2) is
     property-naming's alone — naming's no-restricted-syntax selectors must not
     re-cover TSPropertySignature keys (its hits here are the short `ab` param). */
  const restrictedSyntaxLines = messages
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.line);
  assert.ok(restrictedSyntaxLines.every((line) => line !== 2), "naming must not fire on the property signature");
});
