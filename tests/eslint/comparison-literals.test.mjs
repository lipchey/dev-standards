import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { comparisonLiterals } from "../../eslint/index.js";

const RULE_ID = "dev-standards/comparison-literals";

/* Unscoped parser so it also applies to the file the rule ignores. tseslint.parser
   is needed for the TS `as`/type-assertion/type-alias forms. */
const config = [
  { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
  ...comparisonLiterals({ files: ["**/*.ts"], ignores: ["**/src/constants/**"] }),
];

const linter = new Linter({ configType: "flat" });

function lint(code, filename = "logic.ts") {
  const messages = linter.verify(code, config, { filename });
  const fatal = messages.find((message) => message.fatal);
  assert.ok(!fatal, `parse error in fixture: ${fatal?.message ?? ""}`);
  return messages;
}

const hits = (code, filename) => lint(code, filename).filter((message) => message.ruleId === RULE_ID);
const flagged = (code, filename) => hits(code, filename).length > 0;

/* RED — every operator in both operand positions, and every wrapper the
   staticStringValue helper unwraps; deleting an operator from the set or a
   wrapper from the unwrap list turns one of these red. */

test(`flags the motivating tag === "INPUT" comparison (${RULE_ID})`, () => {
  assert.ok(flagged('const bad = element.tagName === "INPUT";'));
});

test("flags !== , == and != string comparisons, not just ===", () => {
  assert.ok(flagged('const a = s !== "open";'));
  assert.ok(flagged('const b = s == "x";'));
  assert.ok(flagged('const c = s != "y";'));
});

test("flags a magic literal on the LEFT operand", () => {
  assert.ok(flagged('const bad = "open" === state;'));
});

test("flags a switch case against a string literal", () => {
  assert.ok(flagged('switch (kind) { case "ok": break; }'));
});

test("counts every magic case in a multi-case switch (2 cases -> 2 reports)", () => {
  assert.equal(hits('switch (kind) { case "ok": case "bad": break; }').length, 2);
});

test("flags a backtick (expressionless template) comparison — no quote bypass", () => {
  assert.ok(flagged("const bad = kind === `INPUT`;"));
});

test("flags a string behind every transparent TS wrapper (as / satisfies / <T> / !)", () => {
  assert.ok(flagged('const a = tag === ("INPUT" as unknown as string);'));
  assert.ok(flagged('const b = tag === ("INPUT" satisfies string);'));
  assert.ok(flagged('const c = tag === <string>"INPUT";'));
  assert.ok(flagged('const d = tag === "INPUT"!;'));
});

test("flags a wrapped switch case operand (`case (\"ok\" as Tag):`)", () => {
  assert.ok(flagged('switch (kind) { case ("ok" as string): break; }'));
});

test('reports "a" === "b" exactly once, not once per operand', () => {
  assert.equal(hits('const bad = "a" === "b";').length, 1);
});

/* GREEN — exemptions and the shapes no gate should own. */

test("a comparison against a named constant is not flagged", () => {
  assert.ok(!flagged("const ok = tag === INPUT_TAG;"));
});

test("a comparison between two member expressions (EVENT_TYPES.VAD) is not flagged", () => {
  assert.ok(!flagged("const ok = event.type === EVENT_TYPES.VAD;"));
});

test('typeof x === "string" is not flagged, in either yoda order', () => {
  assert.ok(!flagged('const a = typeof value === "string";'));
  assert.ok(!flagged('const b = "string" === typeof value;'));
});

test("a typeof hidden behind a transparent wrapper is still exempt (no over-flag)", () => {
  assert.ok(!flagged('const ok = (typeof value as string) === "string";'));
});

test('empty-string comparison x === "" is not flagged', () => {
  assert.ok(!flagged('const ok = value === "";'));
});

test("a union type DECLARATION is not flagged (only value-position comparisons are)", () => {
  assert.ok(!flagged('type Tag = "INPUT" | "SELECT" | "TEXTAREA";'));
});

test("a string enum DECLARATION is not flagged", () => {
  assert.ok(!flagged('enum Tag { Input = "INPUT", Select = "SELECT" }'));
});

test("switch default (null test) is not flagged and does not crash", () => {
  assert.ok(!flagged("switch (kind) { default: break; }"));
});

test("dynamic comparison operands stay review-owned, not gated (documented ceilings)", () => {
  assert.ok(!flagged('const a = kind === (cond ? "on" : "off");'));
  assert.ok(!flagged("const b = kind === `pre-${suffix}`;"));
  assert.ok(!flagged("const c = kind === tag`raw`;"));
});

test("a numeric comparison is not flagged (inlineLiterals owns numbers)", () => {
  assert.ok(!flagged("const ok = count === 3;"));
});

test("the same magic comparison in an ignored file is not flagged", () => {
  assert.ok(!flagged('const bad = tag === "INPUT";', "packages/app/src/constants/tags.ts"));
});

/* The severity param, not a second override block, is why an ignored file never
   crashes. The safe factory returns clean on a matched-then-ignored declaration
   file; the unsafe split-block control (override references the plugin the
   ignored preset block never registered) throws — proving the crash the param
   design avoids is real, not hypothetical. */

test('severity:"warn" reports at severity 1 on a matched file', () => {
  const warnConfig = [
    { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
    ...comparisonLiterals({ files: ["**/*.ts"], ignores: ["**/*.d.ts"], severity: "warn" }),
  ];
  const messages = linter
    .verify('const bad = tag === "INPUT";', warnConfig, { filename: "logic.ts" })
    .filter((message) => message.ruleId === RULE_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 1);
});

test("the safe single-block warn factory does not crash on an ignored declaration file", () => {
  const warnConfig = [
    { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
    ...comparisonLiterals({ files: ["**/*.ts"], ignores: ["**/*.d.ts"], severity: "warn" }),
  ];
  const messages = linter.verify("export declare const tag: string;", warnConfig, {
    filename: "types/globals.d.ts",
  });
  assert.equal(messages.filter((message) => message.ruleId === RULE_ID).length, 0);
  assert.ok(!messages.some((message) => message.fatal));
});

test('the UNSAFE split-block control throws "Could not find plugin" on the ignored file', () => {
  const unsafeConfig = [
    { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
    ...comparisonLiterals({ files: ["**/*.ts"], ignores: ["**/*.d.ts"] }),
    { files: ["**/*.ts"], rules: { [RULE_ID]: "warn" } },
  ];
  assert.throws(
    () => linter.verify("export declare const tag: string;", unsafeConfig, { filename: "types/globals.d.ts" }),
    /Could not find plugin/,
  );
});
