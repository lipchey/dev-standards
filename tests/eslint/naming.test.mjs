import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { naming } from "../../eslint/index.js";

const SYNTAX_RULE = "no-restricted-syntax";
const ASCII_RULE = "id-match";

/* The preset ships without `files` (in a real config the consumer's typed base
   matches .ts); a bare Linter run has no other matching entry, so the fixture
   passes explicit globs — same shape as the constants-home test. */
const config = [
  { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
  ...naming({ files: ["**/*.ts"] }),
];

const linter = new Linter({ configType: "flat" });

function ruleIds(code, over = config) {
  const messages = linter.verify(code, over, { filename: "logic.ts" });
  const fatal = messages.find((message) => message.fatal);
  assert.ok(!fatal, `parse error in fixture: ${fatal?.message ?? ""}`);
  return messages.map((message) => message.ruleId);
}

/* ── RED: the floor bans short names in every lane the preset advertises ─────── */

test("flags a 2-char variable name", () => {
  assert.ok(ruleIds("const ab = 1;").includes(SYNTAX_RULE));
});

test("flags a 1-char function param", () => {
  assert.ok(ruleIds("export function run(p: string): string { return p; }").includes(SYNTAX_RULE));
});

test("flags a 2-char catch binding", () => {
  assert.ok(ruleIds("try { run(); } catch (er) { handle(er); }").includes(SYNTAX_RULE));
});

test("flags a 2-char named-import ALIAS (the alias hole)", () => {
  assert.ok(ruleIds('import { PrompterEngine as pe } from "engine"; pe();').includes(SYNTAX_RULE));
});

test("flags a 2-char default import", () => {
  assert.ok(ruleIds('import ng from "engine"; ng();').includes(SYNTAX_RULE));
});

test("flags a non-ASCII identifier via id-match", () => {
  assert.ok(ruleIds("const омега = 1; export default омега;").includes(ASCII_RULE));
});

test("flags a 2-char object-destructured binding", () => {
  assert.ok(ruleIds("const { ab } = source();").includes(SYNTAX_RULE));
});

test("flags a 2-char array-destructured binding", () => {
  assert.ok(ruleIds("const [ab] = pair();").includes(SYNTAX_RULE));
});

test("flags a 2-char class member", () => {
  assert.ok(ruleIds("export class Engine { go(): void { this.run(); } run(): void {} }").includes(SYNTAX_RULE));
});

test("flags a 2-char rest param", () => {
  assert.ok(ruleIds("export function join(...ab: string[]): string { return ab.join(); }").includes(SYNTAX_RULE));
});

test("flags a 2-char namespace import", () => {
  assert.ok(ruleIds('import * as ns from "engine"; ns.run();').includes(SYNTAX_RULE));
});

/* ── GREEN: the documented exemptions ────────────────────────────────────────── */

test("does not flag the `_` discard", () => {
  assert.ok(!ruleIds("const [_, keep] = pair();").includes(SYNTAX_RULE));
});

test("does not flag the exempt named import (vi seed)", () => {
  assert.ok(!ruleIds('import { vi } from "vitest"; vi.fn();').includes(SYNTAX_RULE));
});

test("does not flag object PROPERTY keys (wire contracts pin short keys)", () => {
  assert.ok(!ruleIds("export const packet = { t: 1, pos: 2 };").includes(SYNTAX_RULE));
});

test("does not flag files matched by ignores", () => {
  const scoped = [
    { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
    { files: ["**/*.ts"], rules: {} },
    ...naming({ files: ["**/*.ts"], ignores: ["**/generated/**"] }),
  ];
  const messages = new Linter({ configType: "flat" }).verify("const ab = 1;", scoped, {
    filename: "generated/logic.ts",
  });
  assert.ok(!messages.map((message) => message.ruleId).includes(SYNTAX_RULE));
});

test("a custom exemptNamedImports entry is honored", () => {
  const custom = [
    { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
    ...naming({ files: ["**/*.ts"], exemptNamedImports: ["vi", "of"] }),
  ];
  assert.ok(!ruleIds('import { of } from "rxjs"; of(1);', custom).includes(SYNTAX_RULE));
});

/* ── Factory contract ────────────────────────────────────────────────────────── */

test("extraRestrictedSyntax entries ride the SAME rule entry (no flat-config clobber)", () => {
  const custom = [
    { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
    ...naming({
      files: ["**/*.ts"],
      extraRestrictedSyntax: [{ selector: "DebuggerStatement", message: "no debugger" }],
    }),
  ];
  const ids = ruleIds("const ab = 1; debugger;", custom);
  assert.equal(ids.filter((id) => id === SYNTAX_RULE).length, 2, "both the floor and the extra selector fire");
});

test("a non-identifier exemption entry throws instead of corrupting the selector", () => {
  assert.throws(() => naming({ exemptNamedImports: ["a'])"] }), /not a plain identifier/);
});
