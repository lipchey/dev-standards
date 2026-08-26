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

const ALLOW_FILE = "contracts/packet.ts";
const allowConfig = [
  { languageOptions: { parser: tseslint.parser, sourceType: "module" } },
  ...propertyNaming({ files: ["**/*.ts"] }),
  ...propertyNaming({ files: [ALLOW_FILE], allow: ["id"] }),
];

function allowMessages(code, filename = ALLOW_FILE) {
  return new Linter({ configType: "flat" })
    .verify(code, allowConfig, { filename })
    .filter((message) => message.ruleId === RULE_ID);
}

test("a later file-scoped allow entry exempts only the listed key", () => {
  const messages = allowMessages("export interface Packet { id: string; t: number }");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /property 't' is too short/);
});

test("the allow entry does not reach files outside its scope", () => {
  assert.equal(allowMessages("export interface Packet { id: string }", "logic.ts").length, 1);
});

test("a quoted spelling of an allowed key is exempt too", () => {
  assert.equal(allowMessages('export interface Packet { "id": string }').length, 0);
});

test("an absent allow option leaves the rule exactly as it was", () => {
  assert.equal(ruleMessages("export type Packet = { id: string };").length, 1);
});

test("propertyNaming refuses an allow list that is not scoped to files", () => {
  assert.throws(() => propertyNaming({ allow: ["id"] }), /`allow` requires `files`/);
});

test("propertyNaming refuses even an empty unscoped allow", () => {
  assert.throws(() => propertyNaming({ allow: [] }), /`allow` requires `files`/);
});

test("propertyNaming still accepts a call that passes no allow at all", () => {
  assert.equal(propertyNaming({})[0].rules["dev-standards/property-naming"], "error");
});
