// §2.11 planning-file front matter: a zero-dependency (ADR-006), hand-written
// parser / schema-validator / canonical serializer for a STRICT YAML subset —
// exactly the planning-file schema's shapes, NOTHING more. This file is security
// sensitive (untrusted file parsing) and a frozen-contract surface.
//
// Two layers, kept deliberately separate:
//   1. GENERIC subset layer (parseSubset / serializeSubset). A strict whitelist
//      over the subset. It round-trips ALL subset-valid keys it sees — including
//      keys it does not recognize — so it can be reused as-is for the STATE.md
//      feature records (§2.4 / Task 12.2) without dropping unrelated keys.
//   2. FrontMatter SCHEMA layer (parseFrontMatter / serializeFrontMatter). The
//      planning-file-specific validation: correct keys, correct scalar types,
//      `state` ∈ WorkflowState, `needs_human_reason` ∈ the §2.1 vocabulary,
//      reason caps. It builds the canonical (stable key order) serialization.
//
// The parser is a WHITELIST, not a permissive YAML reader: anything outside the
// subset (anchors `&`, aliases `*`, flow `{...}`/`[...]`, tags `!!`, block
// scalars `|`/`>`, extra document markers, tabs-as-indent, over-deep nesting,
// duplicate keys, bare/implicit scalars, ...) is rejected with a typed
// CorruptStateError — the recover path detects it via `instanceof` (or the
// cross-realm-safe `err.kind === 'corrupt-state'`, which is also the matching
// §2.1 needs_human_reason value).
//
// Scalar subset = string / int / null / timestamp (plan §2.11) PLUS `bool`,
// which is added beyond the plan's list solely to carry the §2.9 `auto_advanced`
// phase marker (also documented in types.ts). As a generic floor, every string
// scalar must be free of control characters (U+0000..U+001F, U+007F).

import {
  NEEDS_HUMAN_REASONS,
  WORKFLOW_PHASES,
  WORKFLOW_STATES,
} from './types.ts';
import type {
  ForcedAction,
  FrontMatter,
  NeedsHumanReason,
  PhaseRecord,
  WorkflowPhase,
  WorkflowState,
} from './types.ts';

// ── Typed error ───────────────────────────────────────────────────────────

// The recover path catches this and maps it to `needs_human_reason`. `kind` is
// fixed to the §2.1 value "corrupt-state" so detection survives across module
// realms (where `instanceof` can fail); `code` names the specific rule violated.
export class CorruptStateError extends Error {
  readonly kind = 'corrupt-state' as const;
  readonly code: string;
  readonly line: number | undefined;

  constructor(code: string, message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = 'CorruptStateError';
    this.code = code;
    this.line = line;
    Object.setPrototypeOf(this, CorruptStateError.prototype);
  }
}

function corrupt(code: string, message: string, line?: number): CorruptStateError {
  return new CorruptStateError(code, message, line);
}

// ── Generic subset model ────────────────────────────────────────────────────

export type SubsetScalar =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'timestamp'; value: string }; // raw ISO-8601 UTC text

export interface SubsetMap {
  kind: 'map';
  entries: Array<[string, SubsetNode]>;
}

// Sequence items are block maps whose values are scalars (the subset's only list
// shape: "a list of block maps with scalar values").
export interface SubsetSeqItem {
  kind: 'map';
  entries: Array<[string, SubsetScalar]>;
}

export interface SubsetSeq {
  kind: 'seq';
  items: SubsetSeqItem[];
}

export type SubsetNode = SubsetScalar | SubsetMap | SubsetSeq;

// Container nesting cap. The deepest legal shape is a 3-container path:
//   root map (1) -> `phases` map (2) -> a phase map (3) -> scalar fields, or
//   root map (1) -> `forced_actions` seq (2) -> an item map (3) -> scalars.
// A 4th container is out of subset.
const MAX_DEPTH = 3;

const INT_RE = /^(0|-?[1-9][0-9]*)$/;
// Capturing groups (year/month/day/hour/min/sec) so `isValidTimestamp` can
// re-derive the UTC components and reject JS Date rollover (e.g. Feb 30).
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

// True iff `value` matches the bare ISO-8601 UTC shape AND names a real calendar
// instant. The regex pins the shape; `Date.parse` then `new Date` would happily
// roll an out-of-range day forward (2026-02-30 -> 2026-03-02), so we compare the
// re-derived UTC components back to the literal fields and reject any mismatch.
function isValidTimestamp(value: string): boolean {
  const m = TIMESTAMP_RE.exec(value);
  if (m === null) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3]) &&
    d.getUTCHours() === Number(m[4]) &&
    d.getUTCMinutes() === Number(m[5]) &&
    d.getUTCSeconds() === Number(m[6])
  );
}

// True iff `value` carries no control character (U+0000..U+001F or U+007F). The
// generic floor for ALL string scalars: such chars (embedded newlines, DEL, ...)
// would feed downstream git/fs ops, so they are rejected as corrupt state even
// when introduced via a JSON escape that decodes to a control char.
function controlCharIndex(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return i;
  }
  return -1;
}

// ── Generic parser ──────────────────────────────────────────────────────────

interface Line {
  indent: number;
  content: string;
  lineNo: number;
}

class Cursor {
  pos = 0;
  constructor(readonly lines: Line[]) {}
  peek(): Line | undefined {
    return this.lines[this.pos];
  }
  advance(): void {
    this.pos += 1;
  }
  eof(): boolean {
    return this.pos >= this.lines.length;
  }
}

export function parseSubset(text: string): SubsetMap {
  try {
    return parseSubsetInner(text);
  } catch (e) {
    if (e instanceof CorruptStateError) throw e;
    // Defense in depth: never let a raw exception escape the untrusted parser.
    const message = e instanceof Error ? e.message : String(e);
    throw corrupt('parse-failure', `unexpected parse failure: ${message}`);
  }
}

function parseSubsetInner(text: string): SubsetMap {
  if (text.includes('\r')) {
    throw corrupt('cr-not-allowed', 'carriage returns are not in the subset');
  }
  const raw = text.split('\n');
  if (raw[0] !== '---') {
    throw corrupt('missing-open-fence', 'front matter must begin with a "---" fence');
  }
  let close = -1;
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] === '---') {
      close = i;
      break;
    }
  }
  if (close < 0) {
    throw corrupt('missing-close-fence', 'front matter must end with a "---" fence');
  }
  // Nothing but a trailing newline may follow the closing fence (a second
  // document marker or trailing content is out of subset).
  for (let i = close + 1; i < raw.length; i += 1) {
    if (raw[i] !== '') {
      throw corrupt('content-after-fence', `content after the closing fence: "${raw[i]}"`, i + 1);
    }
  }
  const body: Line[] = [];
  for (let i = 1; i < close; i += 1) {
    const rawLine = raw[i] ?? '';
    if (rawLine === '') {
      throw corrupt('blank-line', 'blank lines are not in the subset', i + 1);
    }
    if (rawLine.includes('\t')) {
      throw corrupt('tab', 'tabs are not in the subset', i + 1);
    }
    const match = /^( *)(.*)$/.exec(rawLine);
    const indentStr = match?.[1] ?? '';
    const content = match?.[2] ?? '';
    if (content.startsWith('#')) {
      throw corrupt('comment', 'comments are not in the subset', i + 1);
    }
    if (indentStr.length % 2 !== 0) {
      throw corrupt('bad-indent', 'indentation must be a multiple of two spaces', i + 1);
    }
    body.push({ indent: indentStr.length, content, lineNo: i + 1 });
  }
  const cur = new Cursor(body);
  const map = parseMap(cur, 0, 1);
  if (!cur.eof()) {
    const stray = cur.peek();
    throw corrupt('trailing-content', 'unparsed content in front matter', stray?.lineNo);
  }
  return map;
}

interface KeyValue {
  key: string;
  inline: string;
  hasInline: boolean;
}

function splitKey(content: string, lineNo: number): KeyValue {
  const colon = content.indexOf(':');
  if (colon < 0) {
    throw corrupt('missing-colon', `line is not a "key: value" entry: "${content}"`, lineNo);
  }
  const key = content.slice(0, colon);
  if (!KEY_RE.test(key)) {
    throw corrupt('bad-key', `invalid key "${key}"`, lineNo);
  }
  const after = content.slice(colon + 1);
  if (after === '') return { key, inline: '', hasInline: false };
  if (!after.startsWith(' ')) {
    throw corrupt('bad-keyvalue', `key "${key}" must be followed by ": "`, lineNo);
  }
  const inline = after.slice(1);
  if (inline === '') {
    throw corrupt('empty-value', `key "${key}" has an empty value (use null)`, lineNo);
  }
  return { key, inline, hasInline: true };
}

function parseMap(cur: Cursor, indent: number, depth: number): SubsetMap {
  if (depth > MAX_DEPTH) {
    throw corrupt('nesting-too-deep', `nesting deeper than ${MAX_DEPTH} containers`, cur.peek()?.lineNo);
  }
  const entries: Array<[string, SubsetNode]> = [];
  const seen = new Set<string>();
  while (!cur.eof()) {
    const line = cur.peek();
    if (line === undefined) break;
    if (line.indent < indent) break; // dedent: this map is finished
    if (line.indent > indent) {
      throw corrupt('bad-indent', `unexpected indentation ${line.indent}, expected ${indent}`, line.lineNo);
    }
    if (line.content.startsWith('- ') || line.content === '-') {
      throw corrupt('unexpected-seq-item', 'sequence item where a map key was expected', line.lineNo);
    }
    const { key, inline, hasInline } = splitKey(line.content, line.lineNo);
    if (seen.has(key)) {
      throw corrupt('duplicate-key', `duplicate key "${key}"`, line.lineNo);
    }
    seen.add(key);
    cur.advance();
    let value: SubsetNode;
    if (hasInline) {
      value = parseScalar(inline, line.lineNo);
    } else {
      const child = cur.peek();
      if (child === undefined || child.indent <= indent) {
        throw corrupt('missing-value', `key "${key}" has no value`, line.lineNo);
      }
      if (child.indent !== indent + 2) {
        throw corrupt('bad-indent', `expected indent ${indent + 2} under "${key}"`, child.lineNo);
      }
      value =
        child.content.startsWith('- ') || child.content === '-'
          ? parseSeq(cur, indent + 2, depth + 1)
          : parseMap(cur, indent + 2, depth + 1);
    }
    entries.push([key, value]);
  }
  return { kind: 'map', entries };
}

function parseSeq(cur: Cursor, indent: number, depth: number): SubsetSeq {
  if (depth > MAX_DEPTH) {
    throw corrupt('nesting-too-deep', `nesting deeper than ${MAX_DEPTH} containers`, cur.peek()?.lineNo);
  }
  const items: SubsetSeqItem[] = [];
  while (!cur.eof()) {
    const line = cur.peek();
    if (line === undefined) break;
    if (line.indent < indent) break; // dedent: this sequence is finished
    if (line.indent > indent) {
      throw corrupt('bad-indent', `unexpected indentation ${line.indent}, expected ${indent}`, line.lineNo);
    }
    if (!line.content.startsWith('- ')) {
      throw corrupt('bad-seq', 'expected a "- " sequence item', line.lineNo);
    }
    items.push(parseSeqItem(cur, line, indent));
  }
  return { kind: 'seq', items };
}

// A sequence item is a block map of scalars. Its first field rides on the "- "
// line; subsequent fields are indented to align under that first key (indent+2).
function parseSeqItem(cur: Cursor, head: Line, indent: number): SubsetSeqItem {
  const entries: Array<[string, SubsetScalar]> = [];
  const seen = new Set<string>();
  const first = splitKey(head.content.slice(2), head.lineNo);
  if (!first.hasInline) {
    throw corrupt('seq-item-scalar-only', 'sequence item fields must be scalars', head.lineNo);
  }
  entries.push([first.key, parseScalar(first.inline, head.lineNo)]);
  seen.add(first.key);
  cur.advance();
  const fieldIndent = indent + 2;
  while (!cur.eof()) {
    const line = cur.peek();
    if (line === undefined) break;
    if (line.indent !== fieldIndent) break; // new item, dedent, or end
    if (line.content.startsWith('- ') || line.content === '-') {
      throw corrupt('seq-item-scalar-only', 'nested sequences are not in the subset', line.lineNo);
    }
    const field = splitKey(line.content, line.lineNo);
    if (!field.hasInline) {
      throw corrupt('seq-item-scalar-only', 'sequence item fields must be scalars', line.lineNo);
    }
    if (seen.has(field.key)) {
      throw corrupt('duplicate-key', `duplicate key "${field.key}"`, line.lineNo);
    }
    seen.add(field.key);
    entries.push([field.key, parseScalar(field.inline, line.lineNo)]);
    cur.advance();
  }
  return { kind: 'map', entries };
}

function parseScalar(token: string, lineNo: number): SubsetScalar {
  if (token.startsWith('"')) {
    if (!isCompleteJsonString(token)) {
      throw corrupt('bad-string', 'malformed quoted string', lineNo);
    }
    let value: unknown;
    try {
      value = JSON.parse(token);
    } catch {
      throw corrupt('bad-string', 'invalid string escaping', lineNo);
    }
    if (typeof value !== 'string') {
      throw corrupt('bad-string', 'quoted value did not decode to a string', lineNo);
    }
    const ctrl = controlCharIndex(value);
    if (ctrl >= 0) {
      throw corrupt(
        'control-char-in-string',
        `string scalar contains a control character (code ${value.charCodeAt(ctrl)}) at index ${ctrl}`,
        lineNo,
      );
    }
    return { kind: 'string', value };
  }
  if (token === 'null') return { kind: 'null' };
  if (token === 'true') return { kind: 'bool', value: true };
  if (token === 'false') return { kind: 'bool', value: false };
  if (INT_RE.test(token)) {
    const n = Number(token);
    if (!Number.isSafeInteger(n)) {
      throw corrupt('bad-int', `integer out of safe range: "${token}"`, lineNo);
    }
    return { kind: 'int', value: n };
  }
  if (TIMESTAMP_RE.test(token)) {
    if (!isValidTimestamp(token)) {
      throw corrupt('bad-timestamp', `not a real calendar instant: "${token}"`, lineNo);
    }
    return { kind: 'timestamp', value: token };
  }
  throw corrupt('out-of-subset', `value not in the subset: "${token}"`, lineNo);
}

// True iff `token` is exactly one double-quoted JSON string and nothing follows
// the closing quote (escapes are honored; JSON.parse later validates them).
function isCompleteJsonString(token: string): boolean {
  if (token.length < 2 || token[0] !== '"') return false;
  let i = 1;
  while (i < token.length) {
    const ch = token[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i === token.length - 1;
    i += 1;
  }
  return false;
}

// ── Generic serializer ──────────────────────────────────────────────────────

export function serializeSubset(map: SubsetMap): string {
  const out: string[] = ['---'];
  emitMap(map, 0, out);
  out.push('---');
  return out.join('\n') + '\n';
}

function emitMap(map: SubsetMap, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const [key, value] of map.entries) {
    if (value.kind === 'map') {
      out.push(`${pad}${key}:`);
      emitMap(value, indent + 2, out);
    } else if (value.kind === 'seq') {
      out.push(`${pad}${key}:`);
      emitSeq(value, indent + 2, out);
    } else {
      out.push(`${pad}${key}: ${emitScalar(value)}`);
    }
  }
}

function emitSeq(seq: SubsetSeq, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  const contPad = ' '.repeat(indent + 2);
  for (const item of seq.items) {
    item.entries.forEach(([key, value], idx) => {
      const scalar = emitScalar(value);
      out.push(idx === 0 ? `${pad}- ${key}: ${scalar}` : `${contPad}${key}: ${scalar}`);
    });
  }
}

function emitScalar(scalar: SubsetScalar): string {
  switch (scalar.kind) {
    case 'string':
      return JSON.stringify(scalar.value);
    case 'int':
      return String(scalar.value);
    case 'bool':
      return scalar.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'timestamp':
      return scalar.value;
  }
}

// ── Reason validation (§2.11 / §2.12) ───────────────────────────────────────

// `--reason` strings are stored as quoted single-line scalars: ASCII only,
// length-capped at 200, control chars rejected. Same safety property as the
// spec's block scalar (data, never argv), simpler subset. Enforced on both the
// read and write paths.
export function validateReason(reason: string): void {
  if (reason.length > 200) {
    throw corrupt('reason-too-long', `reason exceeds 200 chars (${reason.length})`);
  }
  for (let i = 0; i < reason.length; i += 1) {
    const code = reason.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw corrupt('reason-bad-char', `reason has a control or non-ASCII char (code ${code}) at index ${i}`);
    }
  }
}

// ── FrontMatter schema layer ────────────────────────────────────────────────

const FM_KEY_SET = new Set<string>([
  'feature',
  'branch',
  'worktree',
  'base',
  'base_sha',
  'cmux_section',
  'state',
  'loopback_count',
  'loopback_cap',
  'claimed_by',
  'updated',
  'phases',
  'budget_spent',
  'needs_human_reason',
  'forced_actions',
]);
const STATE_SET = new Set<string>(WORKFLOW_STATES);
const PHASE_SET = new Set<string>(WORKFLOW_PHASES);
const NHR_SET = new Set<string>(NEEDS_HUMAN_REASONS);
const PHASE_FIELD_SET = new Set<string>([
  'last_success_loop',
  'attempts',
  'start_sha',
  'complete_sha',
  'auto_advanced',
]);
const FA_FIELD_SET = new Set<string>(['phase', 'loop', 'from_state', 'reason', 'at', 'claimed_by']);

export function parseFrontMatter(text: string): FrontMatter {
  return validateFrontMatter(parseSubset(text));
}

// Validates a generic subset document against the planning-file schema. Kept
// separate from parseSubset so the generic core stays reusable (STATE.md).
export function validateFrontMatter(doc: SubsetMap): FrontMatter {
  for (const [key] of doc.entries) {
    if (!FM_KEY_SET.has(key)) {
      throw corrupt('unknown-key', `unknown front-matter key "${key}"`);
    }
  }
  const m = lookup(doc);
  const state = getString(m, 'state');
  if (!STATE_SET.has(state)) {
    throw corrupt('bad-state', `state "${state}" is not a valid WorkflowState`);
  }
  const fm: FrontMatter = {
    feature: getString(m, 'feature'),
    branch: getString(m, 'branch'),
    worktree: getString(m, 'worktree'),
    base: getString(m, 'base'),
    base_sha: getString(m, 'base_sha'),
    cmux_section: getString(m, 'cmux_section'),
    state: state as WorkflowState,
    loopback_count: getNonNegativeInt(m, 'loopback_count'),
    loopback_cap: getNonNegativeInt(m, 'loopback_cap'),
    claimed_by: getString(m, 'claimed_by'),
    updated: getTimestamp(m, 'updated'),
    phases: parsePhases(m.get('phases')),
    budget_spent: parseBudget(m.get('budget_spent')),
  };
  const nhr = m.get('needs_human_reason');
  if (nhr !== undefined) {
    if (nhr.kind !== 'string') {
      throw corrupt('bad-type', 'needs_human_reason must be a quoted string');
    }
    if (!NHR_SET.has(nhr.value)) {
      throw corrupt('bad-needs-human-reason', `needs_human_reason "${nhr.value}" is not in the §2.1 vocabulary`);
    }
    fm.needs_human_reason = nhr.value as NeedsHumanReason;
  }
  const fa = m.get('forced_actions');
  if (fa !== undefined) {
    fm.forced_actions = parseForcedActions(fa);
  }
  return fm;
}

function lookup(map: SubsetMap): Map<string, SubsetNode> {
  // Duplicates are already rejected by the parser, so a Map view is faithful.
  return new Map<string, SubsetNode>(map.entries);
}

function getString(m: Map<string, SubsetNode>, key: string): string {
  const node = required(m, key);
  if (node.kind !== 'string') {
    throw corrupt('bad-type', `key "${key}" must be a quoted string`);
  }
  return node.value;
}

function getInt(m: Map<string, SubsetNode>, key: string): number {
  const node = required(m, key);
  if (node.kind !== 'int') {
    throw corrupt('bad-type', `key "${key}" must be an integer`);
  }
  return node.value;
}

function getTimestamp(m: Map<string, SubsetNode>, key: string): string {
  const node = required(m, key);
  if (node.kind !== 'timestamp') {
    throw corrupt('bad-type', `key "${key}" must be a bare ISO-8601 timestamp`);
  }
  return node.value;
}

function getIntOrNull(m: Map<string, SubsetNode>, key: string): number | null {
  const node = required(m, key);
  if (node.kind === 'null') return null;
  if (node.kind === 'int') return node.value;
  throw corrupt('bad-type', `key "${key}" must be an integer or null`);
}

// Counter guard (S11 hardening): the persisted progress counters
// (loopback_count, loopback_cap, phase attempts, last_success_loop,
// budget_spent.total_seconds) are non-negative by construction. A negative
// persisted value is corrupt state — e.g. a negative `loopback_count` that equals
// a negative `last_success_loop` would falsely flip the gate's self-completion
// check to ALREADY_DONE — so it is rejected rather than trusted.
function getNonNegativeInt(m: Map<string, SubsetNode>, key: string): number {
  const value = getInt(m, key);
  if (value < 0) {
    throw corrupt('negative-counter', `counter "${key}" must be non-negative, got ${value}`);
  }
  return value;
}

// As getNonNegativeInt, but `last_success_loop` may also be null (never run in
// any round); the null is preserved and only a negative numeric value is rejected.
function getNonNegativeIntOrNull(m: Map<string, SubsetNode>, key: string): number | null {
  const value = getIntOrNull(m, key);
  if (value !== null && value < 0) {
    throw corrupt('negative-counter', `counter "${key}" must be non-negative or null, got ${value}`);
  }
  return value;
}

function getStringOrNull(m: Map<string, SubsetNode>, key: string): string | null {
  const node = required(m, key);
  if (node.kind === 'null') return null;
  if (node.kind === 'string') return node.value;
  throw corrupt('bad-type', `key "${key}" must be a quoted string or null`);
}

function getBoolOptional(m: Map<string, SubsetNode>, key: string): boolean | undefined {
  const node = m.get(key);
  if (node === undefined) return undefined;
  if (node.kind !== 'bool') {
    throw corrupt('bad-type', `key "${key}" must be a boolean`);
  }
  return node.value;
}

function required(m: Map<string, SubsetNode>, key: string): SubsetNode {
  const node = m.get(key);
  if (node === undefined) {
    throw corrupt('missing-key', `missing required key "${key}"`);
  }
  return node;
}

function parsePhases(node: SubsetNode | undefined): Partial<Record<WorkflowPhase, PhaseRecord>> {
  const out: Partial<Record<WorkflowPhase, PhaseRecord>> = {};
  if (node === undefined) return out; // empty map is omitted on the wire
  if (node.kind !== 'map') {
    throw corrupt('bad-type', 'phases must be a block map');
  }
  for (const [phaseKey, phaseVal] of node.entries) {
    if (!PHASE_SET.has(phaseKey)) {
      throw corrupt('unknown-phase', `unknown phase "${phaseKey}"`);
    }
    if (phaseVal.kind !== 'map') {
      throw corrupt('bad-type', `phase "${phaseKey}" must be a block map`);
    }
    for (const [field] of phaseVal.entries) {
      if (!PHASE_FIELD_SET.has(field)) {
        throw corrupt('unknown-phase-field', `unknown phase field "${field}" in "${phaseKey}"`);
      }
    }
    const pm = lookup(phaseVal);
    const record: PhaseRecord = {
      last_success_loop: getNonNegativeIntOrNull(pm, 'last_success_loop'),
      attempts: getNonNegativeInt(pm, 'attempts'),
      start_sha: getStringOrNull(pm, 'start_sha'),
      complete_sha: getStringOrNull(pm, 'complete_sha'),
    };
    const autoAdvanced = getBoolOptional(pm, 'auto_advanced');
    if (autoAdvanced !== undefined) {
      record.auto_advanced = autoAdvanced;
    }
    // `phaseKey` passed the PHASE_SET membership check above, so it is a
    // WorkflowPhase at runtime (Set.has does not narrow the static type).
    out[phaseKey as WorkflowPhase] = record;
  }
  return out;
}

function parseBudget(node: SubsetNode | undefined): { total_seconds: number } {
  if (node === undefined) {
    throw corrupt('missing-key', 'missing required key "budget_spent"');
  }
  if (node.kind !== 'map') {
    throw corrupt('bad-type', 'budget_spent must be a block map');
  }
  for (const [field] of node.entries) {
    if (field !== 'total_seconds') {
      throw corrupt('unknown-budget-field', `unknown budget_spent field "${field}"`);
    }
  }
  return { total_seconds: getNonNegativeInt(lookup(node), 'total_seconds') };
}

function parseForcedActions(node: SubsetNode): ForcedAction[] {
  if (node.kind !== 'seq') {
    throw corrupt('bad-type', 'forced_actions must be a block sequence');
  }
  const out: ForcedAction[] = [];
  for (const item of node.items) {
    for (const [field] of item.entries) {
      if (!FA_FIELD_SET.has(field)) {
        throw corrupt('unknown-forced-action-field', `unknown forced_actions field "${field}"`);
      }
    }
    const im = new Map<string, SubsetNode>(item.entries);
    const phase = getString(im, 'phase');
    if (!PHASE_SET.has(phase)) {
      throw corrupt('bad-phase', `forced_actions phase "${phase}" is not a valid phase`);
    }
    const fromState = getString(im, 'from_state');
    if (!STATE_SET.has(fromState)) {
      throw corrupt('bad-state', `forced_actions from_state "${fromState}" is not a valid WorkflowState`);
    }
    const reason = getString(im, 'reason');
    validateReason(reason);
    out.push({
      phase: phase as WorkflowPhase,
      loop: getInt(im, 'loop'),
      from_state: fromState as WorkflowState,
      reason,
      at: getTimestamp(im, 'at'),
      claimed_by: getString(im, 'claimed_by'),
    });
  }
  return out;
}

// ── FrontMatter canonical serializer ────────────────────────────────────────

export function serializeFrontMatter(fm: FrontMatter): string {
  return serializeSubset(frontMatterToSubset(fm));
}

function frontMatterToSubset(fm: FrontMatter): SubsetMap {
  const entries: Array<[string, SubsetNode]> = [
    ['feature', sStr(fm.feature)],
    ['branch', sStr(fm.branch)],
    ['worktree', sStr(fm.worktree)],
    ['base', sStr(fm.base)],
    ['base_sha', sStr(fm.base_sha)],
    ['cmux_section', sStr(fm.cmux_section)],
    ['state', sStr(fm.state)],
    ['loopback_count', sInt(fm.loopback_count)],
    ['loopback_cap', sInt(fm.loopback_cap)],
    ['claimed_by', sStr(fm.claimed_by)],
    ['updated', sTs(fm.updated)],
  ];
  // Object.keys widens to string[]; the keys are WorkflowPhase by construction.
  const phaseKeys = (Object.keys(fm.phases) as WorkflowPhase[]).sort(
    (a, b) => phaseOrder(a) - phaseOrder(b),
  );
  if (phaseKeys.length > 0) {
    entries.push(['phases', phasesToSubset(fm.phases, phaseKeys)]);
  }
  entries.push([
    'budget_spent',
    { kind: 'map', entries: [['total_seconds', sInt(fm.budget_spent.total_seconds)]] },
  ]);
  if (fm.needs_human_reason !== undefined) {
    entries.push(['needs_human_reason', sStr(fm.needs_human_reason)]);
  }
  if (fm.forced_actions !== undefined && fm.forced_actions.length > 0) {
    entries.push(['forced_actions', forcedActionsToSubset(fm.forced_actions)]);
  }
  return { kind: 'map', entries };
}

function phaseOrder(key: string): number {
  const i = WORKFLOW_PHASES.indexOf(key as WorkflowPhase);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

function phasesToSubset(
  phases: Partial<Record<WorkflowPhase, PhaseRecord>>,
  keys: WorkflowPhase[],
): SubsetMap {
  const entries: Array<[string, SubsetNode]> = [];
  for (const key of keys) {
    const p = phases[key];
    if (p === undefined) continue;
    const fields: Array<[string, SubsetNode]> = [
      ['last_success_loop', sIntOrNull(p.last_success_loop)],
      ['attempts', sInt(p.attempts)],
      ['start_sha', sStrOrNull(p.start_sha)],
      ['complete_sha', sStrOrNull(p.complete_sha)],
    ];
    if (p.auto_advanced !== undefined) {
      fields.push(['auto_advanced', { kind: 'bool', value: p.auto_advanced }]);
    }
    entries.push([key, { kind: 'map', entries: fields }]);
  }
  return { kind: 'map', entries };
}

function forcedActionsToSubset(actions: ForcedAction[]): SubsetSeq {
  const items: SubsetSeqItem[] = actions.map((fa) => {
    validateReason(fa.reason);
    const entries: Array<[string, SubsetScalar]> = [
      ['phase', sStr(fa.phase)],
      ['loop', sInt(fa.loop)],
      ['from_state', sStr(fa.from_state)],
      ['reason', sStr(fa.reason)],
      ['at', sTs(fa.at)],
      ['claimed_by', sStr(fa.claimed_by)],
    ];
    return { kind: 'map', entries };
  });
  return { kind: 'seq', items };
}

function sStr(value: string): SubsetScalar {
  // Write/read symmetry (S11 hardening): the reader rejects control chars in
  // string scalars, so the serializer must too — otherwise a writer could emit a
  // self-corrupt file (e.g. `branch: "feat/x\ny"`) the reader would then reject.
  // Mirrors the parseScalar guard, throwing on the WRITE path.
  const ctrl = controlCharIndex(value);
  if (ctrl >= 0) {
    throw corrupt(
      'control-char-in-string',
      `string scalar contains a control character (code ${value.charCodeAt(ctrl)}) at index ${ctrl} (on write)`,
    );
  }
  return { kind: 'string', value };
}

function sInt(value: number): SubsetScalar {
  if (!Number.isSafeInteger(value)) {
    throw corrupt('bad-int', `not a safe integer: ${value}`);
  }
  return { kind: 'int', value };
}

function sTs(value: string): SubsetScalar {
  if (!isValidTimestamp(value)) {
    throw corrupt('bad-timestamp', `not an ISO-8601 UTC timestamp: "${value}"`);
  }
  return { kind: 'timestamp', value };
}

function sIntOrNull(value: number | null): SubsetScalar {
  return value === null ? { kind: 'null' } : sInt(value);
}

function sStrOrNull(value: string | null): SubsetScalar {
  return value === null ? { kind: 'null' } : sStr(value);
}
