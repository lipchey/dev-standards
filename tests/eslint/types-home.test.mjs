import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { typesHome } from "../../eslint/index.js";

const RULE_ID = "dev-standards/types-home";
const config = [
  { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
  ...typesHome({ files: ["**/*.ts"], ignores: ["**/src/types/**", "**/*.d.ts"] }),
];

function ruleMessages(code, filename = "src/logic.ts", over = config) {
  const messages = new Linter({ configType: "flat" }).verify(code, over, { filename });
  const fatal = messages.find((message) => message.fatal);
  assert.ok(!fatal, `parse error in fixture: ${fatal?.message ?? ""}`);
  return messages.filter((message) => message.ruleId === RULE_ID);
}

test("flags a directly exported interface", () => {
  assert.equal(ruleMessages("export interface EngineState { ready: boolean }").length, 1);
});

test("flags an indirect type-only export", () => {
  assert.equal(ruleMessages("type EngineState = { ready: boolean }; export type { EngineState };").length, 1);
});

test("flags a same-file default export", () => {
  assert.equal(ruleMessages("interface EngineState { ready: boolean } export default EngineState;").length, 1);
});

test("flags a root-level exported type outside the types home", () => {
  const messages = ruleMessages("export type TrackerSnapshot = { elapsedMs: number }", "src/tracker.ts");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /dev-standards\/types-home/);
  assert.match(messages[0].message, /types home/);
});

test("does not flag a re-export from another module", () => {
  assert.equal(ruleMessages('export type { RemoteState } from "./remote.js";').length, 0);
});

test("does not flag an ambient declaration", () => {
  assert.equal(ruleMessages("export declare interface AmbientState { ready: boolean }").length, 0);
});

test("does not flag a non-exported local helper type", () => {
  assert.equal(ruleMessages("type LocalState = { ready: boolean };").length, 0);
});

test("allows names matching the seeded Props pattern", () => {
  assert.equal(ruleMessages("export interface ButtonProps { label: string }").length, 0);
});

test("does not flag files matched by the types-home or declaration ignores", () => {
  const code = "export interface EngineState { ready: boolean }";
  assert.equal(ruleMessages(code, "src/types/engine.ts").length, 0);
  assert.equal(ruleMessages(code, "src/external.d.ts").length, 0);
});

test("validates allowNamePattern while building the config", () => {
  assert.throws(() => typesHome({ allowNamePattern: 12 }), /must be a string regex/);
  assert.throws(() => typesHome({ allowNamePattern: "[" }), /invalid allowNamePattern regex/);
});

test("honors a consumer allowNamePattern", () => {
  const custom = [
    { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
    ...typesHome({ files: ["**/*.ts"], allowNamePattern: "ViewModel$" }),
  ];
  assert.equal(ruleMessages("export type DashboardViewModel = { ready: boolean };", "src/view.ts", custom).length, 0);
});
