import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { constantsHome } from "../../eslint/index.js";

const RULE_ID = "dev-standards/constants-home";

/* files = a workspace src glob; ignores = the constants home (proves a hit in an
   ignored file is suppressed). The parser entry is unscoped so it also applies to
   files the rule ignores. tseslint.parser is needed for the TS `as const` form. */
const config = [
  { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
  ...constantsHome({ files: ["**/*.ts"], ignores: ["**/src/constants/**"] }),
];

const linter = new Linter({ configType: "flat" });

function lint(code, filename = "logic.ts") {
  const messages = linter.verify(code, config, { filename });
  const fatal = messages.find((m) => m.fatal);
  assert.ok(!fatal, `parse error in fixture: ${fatal?.message ?? ""}`);
  return messages.map((m) => m.ruleId);
}

const flagged = (code, filename) => lint(code, filename).includes(RULE_ID);

// ── RED: one case per advertised primitive-literal form (module scope) ──────────

test(`flags a bare numeric literal const (${RULE_ID})`, () => {
  assert.ok(flagged("const X = 500;"));
});

test(`flags an exported string literal const (${RULE_ID})`, () => {
  assert.ok(flagged('export const URL_BASE = "https://x";'));
});

test(`flags a unary-negated numeric literal const (${RULE_ID})`, () => {
  assert.ok(flagged("const MIN = -1;"));
});

test(`flags an expressionless template literal const (${RULE_ID})`, () => {
  assert.ok(flagged("const NAME = `fixed`;"));
});

test(`flags a TS as-const primitive literal (${RULE_ID})`, () => {
  // tseslint.parser is a dev dep, so the TSAsExpression form is exercised, not skipped.
  assert.ok(flagged("const TIMEOUT = 500 as const;"));
});

// ── GREEN: the review-owned ceilings and legitimate homes ───────────────────────

test("derived (arithmetic) initializer is not flagged", () => {
  assert.ok(!flagged("const D = A * B;"));
});

test("object literal (option-defaults) initializer is not flagged", () => {
  assert.ok(!flagged("export const defaults = { gap: 500 };"));
});

test("function-local literal const is not flagged", () => {
  assert.ok(!flagged("function f() { const t = 500; return t; }"));
});

test("the same literal const in an ignored file is not flagged", () => {
  // nested path so `**/src/constants/**` matches without relying on a zero-segment `**/`.
  assert.ok(!flagged("const X = 500;", "packages/app/src/constants/limits.ts"));
});
