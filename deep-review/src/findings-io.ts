// Untrusted-input IO for the deep-review findings file. The findings file is
// produced by the review pass and re-read by the fix/slice/report passes; an
// adversarial or corrupt file must NEVER reach a shell, a writer, or git as a
// path. This module is the validating boundary: `readFindings` parses + runs an
// ENGINE-LOCAL hand validator (written in the STYLE of runner/src/validate.ts,
// but with its own private functions and its own rule set — runner's helpers are
// not exported and are not imported here), and `writeFindings` serializes back
// with a stable canonical key order so write → read is byte-idempotent.
//
// Effects (fs read/write) live behind an injectable `deps` seam (default real
// fs), mirroring the workflow/runner edge style, so the validator/serializer are
// unit-testable without touching disk.

import { readFileSync, writeFileSync } from 'node:fs';
import type { FindingRecord, FindingsFile, FindingStatus } from './types.ts';

// ── Errors ───────────────────────────────────────────────────────────────────

// The engine-local rule vocabulary. Distinct from runner's RuleName union (which
// is private to that module); this is the deep-review findings set.
export type FindingsRule =
  | 'required'
  | 'type'
  | 'enum'
  | 'additional-property'
  | 'non-empty'
  | 'path-unsafe';

// A validation failure carrying the offending rule + JSON path. `kind` is a
// cross-realm tag (a bundled copy can defeat `instanceof`), mirroring the
// workflow module's error classes. Tests assert `.rule`.
export class FindingsValidationError extends Error {
  readonly kind = 'findings-validation-error' as const;
  readonly rule: FindingsRule;
  readonly path: string;
  constructor(rule: FindingsRule, path: string, message: string) {
    super(message);
    this.name = 'FindingsValidationError';
    this.rule = rule;
    this.path = path;
    Object.setPrototypeOf(this, FindingsValidationError.prototype);
  }
}

function fail(rule: FindingsRule, path: string, message: string): never {
  throw new FindingsValidationError(rule, path, message);
}

// ── IO seam ──────────────────────────────────────────────────────────────────

export interface FindingsIoDeps {
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
}

const realDeps: FindingsIoDeps = {
  readFile: (filePath) => readFileSync(filePath, 'utf8'),
  writeFile: (filePath, content) => {
    writeFileSync(filePath, content);
  },
};

// ── Allowed shapes ───────────────────────────────────────────────────────────

const TOP_REQUIRED = ['schema', 'mode', 'generated_at', 'findings'] as const;
const MODES = ['review-only', 'review-and-refactor'] as const;

const FINDING_REQUIRED = [
  'id',
  'severity',
  'file',
  'line',
  'title',
  'impact',
  'needs_plan',
  'test_cmd',
  'classification',
  'status',
  'sha',
] as const;
const FINDING_ALLOWED = [...FINDING_REQUIRED, 'slice_files'] as const;

const SEVERITIES = ['P1', 'P2', 'P3'] as const;
const CLASSIFICATIONS = ['fixable-now', 'no-touch', 'needs-plan', ''] as const;
const STATUSES = ['pending', 'fixed', 'fix-failed', 'no-touch', 'needs-plan', 'invalid'] as const;

// Control chars (C0 + DEL); NUL is the head of the range. Rejected in paths and
// in test_cmd argv so neither can smuggle a terminator or escape into a shell.
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;
// A Windows drive prefix (`C:`), treated as absolute.
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
// A finding id usable verbatim in a commit trailer and a filename.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── Primitive guards (throwing, validate.ts style) ───────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return 'an object';
    default:
      return String(value);
  }
}

function childPath(parentPath: string, key: string): string {
  return parentPath === '' ? key : `${parentPath}.${key}`;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  fail('type', path, `must be an object, got ${describeValue(value)}`);
}

function requireKeys(record: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      fail('required', childPath(path, key), `missing required key "${key}"`);
    }
  }
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(
        'additional-property',
        childPath(path, key),
        `unknown key "${key}" (allowed keys: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail('type', path, `must be a string, got ${describeValue(value)}`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    fail('type', path, `must be a boolean, got ${describeValue(value)}`);
  }
  return value;
}

function requireInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('type', path, `must be an integer, got ${describeValue(value)}`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  fail('enum', path, `must be one of: ${allowed.join(', ')}; got ${describeValue(value)}`);
}

// id: a non-empty slug. Non-string → type; empty → non-empty; bad shape → type.
function requireSlug(value: unknown, path: string): string {
  const slug = requireString(value, path);
  if (slug.length === 0) {
    fail('non-empty', path, 'must be a non-empty slug');
  }
  if (!ID_RE.test(slug)) {
    fail('type', path, 'must be a slug matching ^[a-z0-9][a-z0-9-]*$');
  }
  return slug;
}

// test_cmd: a NON-EMPTY array of NON-EMPTY control-free strings.
function requireTestCmd(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail('type', path, `must be an array of strings, got ${describeValue(value)}`);
  }
  if (value.length === 0) {
    fail('non-empty', path, 'must contain at least one argument');
  }
  return value.map((item: unknown, index: number): string => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== 'string') {
      fail('type', itemPath, `must be a string, got ${describeValue(item)}`);
    }
    if (item.length === 0) {
      fail('non-empty', itemPath, 'must be a non-empty string');
    }
    if (CONTROL_CHAR_RE.test(item)) {
      fail('type', itemPath, 'must not contain control or NUL characters');
    }
    return item;
  });
}

// A plain array of strings (slice_files). Non-array or non-string item → type.
function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail('type', path, `must be an array of strings, got ${describeValue(value)}`);
  }
  return value.map((item: unknown, index: number): string => {
    if (typeof item !== 'string') {
      fail('type', `${path}[${index}]`, `must be a string, got ${describeValue(item)}`);
    }
    return item;
  });
}

// True if the string carries a git glob metacharacter: `*` (0x2A), `?` (0x3F),
// `[` (0x5B), or `]` (0x5D). Detected by codepoint (NOT a regex literal) so the
// source carries no glob bytes, mirroring the engine's codepoint scans.
function hasGlobMeta(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x2a || code === 0x3f || code === 0x5b || code === 0x5d) return true;
  }
  return false;
}

// ── Path safety (exported; E3 reuses it) ─────────────────────────────────────

// Rejects, with rule `path-unsafe`, any repo-relative string that is not a plain
// in-repo file path — i.e. anything that could escape the repo, be misread as a
// CLI flag, or be interpreted by git as a non-file pathspec (magic or glob):
//   - a control/NUL character;
//   - the EMPTY string;
//   - a leading `-` (could be read as a CLI flag);
//   - a leading `:` (a git magic pathspec, e.g. `:(exclude)…`, `:/…`);
//   - a glob metacharacter `* ? [ ]` (git would expand it as a pattern);
//   - an absolute path (leading `/`, leading `\`, or a Windows drive prefix);
//   - an empty or `.` path SEGMENT (so `.`, `./`, `a/./b`, `foo//bar`, a trailing
//     slash) or a `..` segment.
// Pure and dependency-free; the slice engine (E3) calls it before handing a path
// to git or a writer, and every path-bearing git argv additionally runs under
// `--literal-pathspecs` as belt-and-suspenders.
export function assertSafeRepoPath(p: string): void {
  if (CONTROL_CHAR_RE.test(p)) {
    fail('path-unsafe', p, 'path contains a control or NUL character');
  }
  if (p === '') {
    fail('path-unsafe', p, 'path is empty');
  }
  if (p.startsWith('-')) {
    fail('path-unsafe', p, 'path has a leading "-" (could be read as a CLI flag)');
  }
  if (p.startsWith(':')) {
    fail('path-unsafe', p, 'path has a leading ":" (a git magic pathspec)');
  }
  if (hasGlobMeta(p)) {
    fail('path-unsafe', p, 'path contains a glob metacharacter (* ? [ ])');
  }
  if (p.startsWith('/') || p.startsWith('\\') || WINDOWS_DRIVE_RE.test(p)) {
    fail('path-unsafe', p, 'path is absolute');
  }
  for (const segment of p.split(/[/\\]/)) {
    if (segment === '' || segment === '.') {
      fail('path-unsafe', p, 'path contains an empty or "." segment');
    }
    if (segment === '..') {
      fail('path-unsafe', p, 'path contains a ".." segment');
    }
  }
}

// ── Finding + file validation ────────────────────────────────────────────────

function validateFinding(value: unknown, path: string): FindingRecord {
  const record = requireRecord(value, path);
  requireKeys(record, path, FINDING_REQUIRED);
  rejectUnknownKeys(record, path, FINDING_ALLOWED);

  const id = requireSlug(record['id'], `${path}.id`);
  const severity = requireEnum(record['severity'], `${path}.severity`, SEVERITIES);
  const file = requireString(record['file'], `${path}.file`);
  const line = requireInteger(record['line'], `${path}.line`);
  const title = requireString(record['title'], `${path}.title`);
  const impact = requireString(record['impact'], `${path}.impact`);
  const needs_plan = requireBoolean(record['needs_plan'], `${path}.needs_plan`);
  const test_cmd = requireTestCmd(record['test_cmd'], `${path}.test_cmd`);
  // slice_files defaults to [file] when omitted.
  const slice_files = Object.hasOwn(record, 'slice_files')
    ? requireStringArray(record['slice_files'], `${path}.slice_files`)
    : [file];
  const classification = requireEnum(record['classification'], `${path}.classification`, CLASSIFICATIONS);
  let status: FindingStatus = requireEnum(record['status'], `${path}.status`, STATUSES);
  const sha = requireString(record['sha'], `${path}.sha`);

  // Path safety is LOCALIZED: an unsafe `file` or `slice_files` entry marks this
  // finding `invalid` rather than rejecting the whole file. assertSafeRepoPath
  // surfaces the `path-unsafe` rule (the primitive E3 reuses); here that rule is
  // caught and downgraded to a per-finding status; any other rule still throws.
  for (const candidate of [file, ...slice_files]) {
    try {
      assertSafeRepoPath(candidate);
    } catch (error) {
      if (error instanceof FindingsValidationError && error.rule === 'path-unsafe') {
        status = 'invalid';
        break;
      }
      throw error;
    }
  }

  return {
    id,
    severity,
    file,
    line,
    title,
    impact,
    needs_plan,
    test_cmd,
    slice_files,
    classification,
    status,
    sha,
  };
}

function validateFindingsFile(value: unknown): FindingsFile {
  const root = requireRecord(value, '');
  requireKeys(root, '', TOP_REQUIRED);
  rejectUnknownKeys(root, '', TOP_REQUIRED);

  if (root['schema'] !== 1) {
    fail('enum', 'schema', `must be 1 (the supported findings schema version), got ${describeValue(root['schema'])}`);
  }
  const mode = requireEnum(root['mode'], 'mode', MODES);
  const generated_at = requireString(root['generated_at'], 'generated_at');

  const findingsRaw = root['findings'];
  if (!Array.isArray(findingsRaw)) {
    fail('type', 'findings', `must be an array of findings, got ${describeValue(findingsRaw)}`);
  }
  const findings = findingsRaw.map((entry: unknown, index: number) =>
    validateFinding(entry, `findings[${index}]`),
  );

  return { schema: 1, mode, generated_at, findings };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Reads + validates an untrusted findings file. Throws FindingsValidationError
// (carrying `.rule`) on a structural violation; an unsafe path is localized to a
// finding's `status: "invalid"` instead.
export function readFindings(path: string, deps: FindingsIoDeps = realDeps): FindingsFile {
  const raw = deps.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail('type', '', `findings file is not valid JSON: ${detail}`);
  }
  return validateFindingsFile(parsed);
}

// Serializes with a stable canonical key order so write → read → write is
// byte-idempotent. Trailing newline, two-space indent (matches the repo's JSON).
function serializeFindings(file: FindingsFile): string {
  const ordered = {
    schema: file.schema,
    mode: file.mode,
    generated_at: file.generated_at,
    findings: file.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      file: f.file,
      line: f.line,
      title: f.title,
      impact: f.impact,
      needs_plan: f.needs_plan,
      test_cmd: f.test_cmd,
      slice_files: f.slice_files,
      classification: f.classification,
      status: f.status,
      sha: f.sha,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function writeFindings(path: string, file: FindingsFile, deps: FindingsIoDeps = realDeps): void {
  deps.writeFile(path, serializeFindings(file));
}
