import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { propertyNaming } from "../../eslint/index.js";

const RULE_ID = "dev-standards/property-naming";
const config = [
  { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
  ...propertyNaming({ files: ["**/*.ts"], ignores: ["**/wire/**"] }),
];

function ruleMessages(code, filename = "logic.ts") {
  const messages = new Linter({ configType: "flat" }).verify(code, config, { filename });
  const fatal = messages.find((message) => message.fatal);
  assert.ok(!fatal, `parse error in fixture: ${fatal?.message ?? ""}`);
  return messages.filter((message) => message.ruleId === RULE_ID);
}

test("flags a single-character interface property signature", () => {
  const messages = ruleMessages("export interface TrackerPoint { t: number }");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /dev-standards\/property-naming/);
});

test("flags a two-character type-literal property signature", () => {
  assert.equal(ruleMessages("export type Packet = { id: string };").length, 1);
});

test("does not flag the discard property", () => {
  assert.equal(ruleMessages("export type TupleLike = { _: unknown };").length, 0);
});

test("flags a quoted string-literal property signature", () => {
  assert.equal(ruleMessages('export type Packet = { "id": string };').length, 1);
});

test("flags a computed property signature with a static string-literal key", () => {
  assert.equal(ruleMessages('export interface Packet { ["id"]: string }').length, 1);
});

test("does not flag a genuinely dynamic computed property signature", () => {
  assert.equal(ruleMessages("export interface Bag { [Symbol.iterator]: () => void }").length, 0);
});

test("does not flag the quoted discard property", () => {
  assert.equal(ruleMessages('export type TupleLike = { "_": unknown };').length, 0);
});

test("does not flag class fields", () => {
  assert.equal(ruleMessages("export class Packet { id = 1; }").length, 0);
});

test("does not flag object-literal keys", () => {
  assert.equal(ruleMessages("export const packet = { t: 1 };").length, 0);
});

test("does not flag files matched by ignores", () => {
  assert.equal(ruleMessages("export interface WirePacket { t: number }", "wire/packet.ts").length, 0);
});
