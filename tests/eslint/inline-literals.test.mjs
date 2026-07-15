import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { inlineLiterals } from "../../eslint/index.js";

const RULE_ID = "@typescript-eslint/no-magic-numbers";
const TYPESCRIPT_BASE = { ...tseslint.configs.base, files: ["**/*.ts"] };
const config = [TYPESCRIPT_BASE, ...inlineLiterals({ files: ["**/*.ts"] })];

function ruleMessages(code, over = config) {
  const messages = new Linter({ configType: "flat" }).verify(code, over, { filename: "logic.ts" });
  const fatal = messages.find((message) => message.fatal);
  assert.ok(!fatal, `parse error in fixture: ${fatal?.message ?? ""}`);
  return messages.filter((message) => message.ruleId === RULE_ID);
}

test("flags a numeric literal in an expression", () => {
  assert.ok(ruleMessages("export const total = count * 12;").length > 0);
});

test("flags the vad-style threshold comparison", () => {
  assert.ok(ruleMessages("export function hasVoice(rms: number) { return rms > 0.015; }").length > 0);
});

test("flags a numeric literal passed as a call argument", () => {
  assert.ok(ruleMessages("export function schedule(callback: () => void) { setTimeout(callback, 500); }").length > 0);
});

test("flags the tracker-style millisecond arithmetic constants-home ceiling", () => {
  const messages = ruleMessages("export const TRACKER_WINDOW_MS = 45 * 60 * 1000;");
  assert.ok(messages.length >= 3);
});

test("flags a test-style inline expected number", () => {
  assert.ok(ruleMessages("assert.equal(durationMs, 250);").length > 0);
});

test("ignores zero, one, and negative one", () => {
  assert.equal(
    ruleMessages("export function clamp(value: number) { return value === 0 || value === 1 || value > -1; }").length,
    0,
  );
});

test("ignores array indexes", () => {
  assert.equal(ruleMessages("export const item = values[2];").length, 0);
});

test("ignores enum member values", () => {
  assert.equal(ruleMessages("export enum Mode { Ready = 2 }").length, 0);
});

test("ignores numeric literal types and type indexes", () => {
  assert.equal(ruleMessages("export type Port = 8080; export type Third = Values[2];").length, 0);
});

test("ignores readonly class properties", () => {
  assert.equal(ruleMessages("export class Limits { readonly retryCount = 3; }").length, 0);
});

test("consumer ignore values extend the pinned defaults", () => {
  const custom = [
    TYPESCRIPT_BASE,
    ...inlineLiterals({ files: ["**/*.ts"], ignore: [250] }),
  ];
  assert.equal(ruleMessages("assert.equal(durationMs, 250);", custom).length, 0);
  assert.equal(ruleMessages("export const first = values[0];", custom).length, 0);
});
