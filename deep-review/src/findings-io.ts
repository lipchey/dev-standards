// Untrusted-input IO for the deep-review findings file (schema v2). The findings
// file is produced by the review pass and re-read/mutated by the classify, slice,
// verify and handoff passes; an adversarial or corrupt file must NEVER reach a
// shell, a writer, or git as a path. This module is the validating boundary:
// `readFindings` parses + runs an ENGINE-LOCAL hand validator (in the STYLE of
// runner/src/validate.ts, with its own private rule set), and `mutateFindings` is
// the SOLE writer — every findings write (bind, classify, verification, slice
// status) goes through it under a lock file, with a confined atomic write.
//
// Effects (fs read/write/lock, realpath, clock, pid) live behind injectable seams
// (default real fs/process), so the validator/serializer/lock logic are
// unit-testable without touching disk.

import { closeSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeConfined } from '../../runner/src/report.ts';
import { EXIT_FINDINGS_CONFLICT } from './types.ts';
import type {
  FindingRecord,
  FindingsFileV2,
  FindingStatus,
  SelfReviewRecord,
  TestRef,
  VerificationRecord,
} from './types.ts';

// ── Errors ───────────────────────────────────────────────────────────────────

// The engine-local rule vocabulary. Distinct from runner's RuleName union (which
// is private to that module); this is the deep-review findings set.
export type FindingsRule =
  | 'required'
  | 'type'
  | 'enum'
  | 'additional-property'
  | 'non-empty'
  | 'path-unsafe'
  | 'schema-version'
  | 'removed-field'
  | 'duplicate-id'
  | 'immutable'
  | 'status-coupling';

// A validation failure carrying the offending rule + JSON path. `kind` is a
// cross-realm tag (a bundled copy can defeat `instanceof`), mirroring the sibling
// modules' error-tag idiom (slice.ts / worktree.ts GitStepError). Tests assert `.rule`.
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

// A findings-write contention that must map to EXIT_FINDINGS_CONFLICT (a bare throw
// would collapse to EXIT_FAILURE). Raised on a live lock holder, an unreadable lock
// (a competitor mid-create), a lost takeover race, OR a failed optimistic-revision
// check (F2 CAS: the file changed between a verb's read and its write). `kind` is the
// cross-realm tag the CLI edge matches on; `reason` overrides the default message.
export class FindingsConflictError extends Error {
  readonly kind = 'findings-conflict-error' as const;
  readonly exitCode = EXIT_FINDINGS_CONFLICT;
  readonly lockPath: string;
  constructor(lockPath: string, holderPid: number | null, reason?: string) {
    super(
      reason ??
        `findings file is locked by ${
          holderPid === null ? 'an unreadable lock' : `a live process (pid ${holderPid})`
        }: ${lockPath}`,
    );
    this.name = 'FindingsConflictError';
    this.lockPath = lockPath;
    Object.setPrototypeOf(this, FindingsConflictError.prototype);
  }
}

function fail(rule: FindingsRule, path: string, message: string): never {
  throw new FindingsValidationError(rule, path, message);
}

// ── IO / lock seams ──────────────────────────────────────────────────────────

// The read-only seam (readFindings). Superset objects (a full MutateFindingsDeps)
// are structurally assignable.
export interface FindingsIoDeps {
  readFile: (filePath: string) => string;
}

// The findings-lock seam. `create` is an O_EXCL create (false when the file
// already exists); `read` returns the lock body or null; `remove` best-effort
// unlinks; `isAlive` reports whether a pid is a live process.
interface FindingsLockDeps {
  create: (lockPath: string, content: string) => boolean;
  read: (lockPath: string) => string | null;
  remove: (lockPath: string) => void;
  isAlive: (pid: number) => boolean;
}

// The full seam mutateFindings needs: read + confined atomic write + realpath (for
// confinement) + lock + clock + pid (for the lock body).
export interface MutateFindingsDeps {
  readFile: (filePath: string) => string;
  writeConfined: (rootDir: string, relPath: string, content: string) => string;
  realpath: (p: string) => string;
  lock: FindingsLockDeps;
  now: () => string;
  pid: () => number;
}

const realReadFile = (filePath: string): string => readFileSync(filePath, 'utf8');

const realLock: FindingsLockDeps = {
  create(lockPath, content) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  },
  read(lockPath) {
    try {
      return readFileSync(lockPath, 'utf8');
    } catch {
      return null;
    }
  },
  remove(lockPath) {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* best-effort; a leftover lock is cleared on the next dead-holder retry */
    }
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH = no such process (dead); EPERM = alive but not signalable by us.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

const realMutateDeps: MutateFindingsDeps = {
  readFile: realReadFile,
  writeConfined,
  realpath: (p) => realpathSync(p),
  lock: realLock,
  now: () => new Date().toISOString(),
  pid: () => process.pid,
};

// ── Allowed shapes ───────────────────────────────────────────────────────────

const TOP_REQUIRED = [
  'schema',
  'mode',
  'generated_at',
  'run_id',
  'base_sha',
  'revision',
  'verification',
  'findings',
] as const;
const TOP_ALLOWED = [...TOP_REQUIRED, 'self_review'] as const;
const MODES = ['review-only', 'review-and-refactor'] as const;

const FINDING_REQUIRED = [
  'id',
  'severity',
  'file',
  'line',
  'title',
  'impact',
  'needs_plan',
  'test_ref',
  'classification',
  'status',
  'sha',
] as const;
const FINDING_ALLOWED = [...FINDING_REQUIRED, 'slice_files', 'infra_error'] as const;

const VERIFICATION_KEYS = ['sha', 'scope', 'completed_at'] as const;
const SELF_REVIEW_REQUIRED = ['sha', 'verdict', 'noted_at'] as const;
const SELF_REVIEW_ALLOWED = [...SELF_REVIEW_REQUIRED, 'note'] as const;

const SEVERITIES = ['P1', 'P2', 'P3'] as const;
const CLASSIFICATIONS = ['fixable-now', 'no-touch', 'needs-plan', ''] as const;
const STATUSES = [
  'pending',
  'fixed',
  'fix-failed',
  'no-touch',
  'needs-plan',
  'invalid',
  'infra-blocked',
] as const;
const TEST_REFS = ['verify:fast', 'verify:full'] as const;
const SELF_REVIEW_VERDICTS = ['clean', 'violation'] as const;

// §F5: statuses that only ever originate inside a bound run (a slice attempt's
// outcome). An unbound draft carrying one is corrupt.
const BOUND_ONLY_STATUSES: readonly FindingStatus[] = ['fixed', 'fix-failed', 'infra-blocked'];

// A Windows drive prefix (`C:`), treated as absolute.
const WINDOWS_DRIVE_RE = /^[A-Z]:/i;
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
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'symbol':
    case 'undefined':
    case 'function':
      return String(value);
    default:
      /* typeof === 'object' (null/array handled above). The object case sits in
         `default` because TS neither narrows `unknown` through negated typeof
         guards nor proves typeof-switch exhaustiveness — a positive-case-only
         switch fails TS2366. */
      return 'an object';
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

// A `string | null` field (run_id / base_sha): null passes through; a non-null
// value must be a NON-EMPTY string (an empty bound id is nonsensical).
function requireNullableId(value: unknown, path: string): string | null {
  if (value === null) return null;
  const str = requireString(value, path);
  if (str.length === 0) fail('non-empty', path, 'must be a non-empty string when set');
  return str;
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

// True if the string carries a control char: the C0 range (0x00-0x1F, NUL at the
// head) or DEL (0x7F). A codepoint scan (NOT a regex literal) so no raw control
// byte appears in this source, mirroring the engine's other codepoint scans.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// True if the string carries a git glob metacharacter: `*` (0x2A), `?` (0x3F),
// `[` (0x5B), or `]` (0x5D). Same codepoint-scan rationale (git would expand a
// glob as a pattern rather than a literal path).
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
  if (hasControlChar(p)) {
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

  // `test_cmd` (an arbitrary argv) is a v1 field, removed in v2. Its PRESENCE is a
  // loud, specific reject — not the generic "unknown key" — so a stale file gets an
  // actionable message.
  if (Object.hasOwn(record, 'test_cmd')) {
    fail(
      'removed-field',
      `${path}.test_cmd`,
      'test_cmd was removed; use test_ref: verify:fast | verify:full',
    );
  }

  requireKeys(record, path, FINDING_REQUIRED);
  rejectUnknownKeys(record, path, FINDING_ALLOWED);

  const id = requireSlug(record['id'], `${path}.id`);
  const severity = requireEnum(record['severity'], `${path}.severity`, SEVERITIES);
  const file = requireString(record['file'], `${path}.file`);
  const line = requireInteger(record['line'], `${path}.line`);
  const title = requireString(record['title'], `${path}.title`);
  const impact = requireString(record['impact'], `${path}.impact`);
  const needs_plan = requireBoolean(record['needs_plan'], `${path}.needs_plan`);
  const test_ref = requireEnum(record['test_ref'], `${path}.test_ref`, TEST_REFS);
  // slice_files defaults to [file] when omitted.
  const slice_files = Object.hasOwn(record, 'slice_files')
    ? requireStringArray(record['slice_files'], `${path}.slice_files`)
    : [file];
  const classification = requireEnum(record['classification'], `${path}.classification`, CLASSIFICATIONS);
  const status: FindingStatus = requireEnum(record['status'], `${path}.status`, STATUSES);
  const sha = requireString(record['sha'], `${path}.sha`);
  const hasInfraError = Object.hasOwn(record, 'infra_error');
  const infra_error = hasInfraError ? requireString(record['infra_error'], `${path}.infra_error`) : undefined;

  // Path safety is LOCALIZED: an unsafe `file` or `slice_files` entry marks this
  // finding `invalid` rather than rejecting the whole file. assertSafeRepoPath
  // surfaces the `path-unsafe` rule (the primitive E3 reuses); here that rule is
  // caught and downgraded to a per-finding status; any other rule still throws.
  let unsafePath = false;
  for (const candidate of [file, ...slice_files]) {
    try {
      assertSafeRepoPath(candidate);
    } catch (error) {
      if (error instanceof FindingsValidationError && error.rule === 'path-unsafe') {
        unsafePath = true;
        break;
      }
      throw error;
    }
  }

  const common = { id, severity, file, line, title, impact, needs_plan, test_ref, slice_files, classification };

  // An unsafe path downgrades to a CLEAN `invalid`: sha cleared and infra_error dropped,
  // so the status/field coupling below is trivially satisfied on the re-write path.
  if (unsafePath) {
    return { ...common, status: 'invalid', sha: '' };
  }

  // §F5 status/field coupling. The findings file is UNTRUSTED, so an internally
  // inconsistent record (a "fixed" with no sha, a stray infra_error, etc.) is a loud
  // reject rather than a silently mishandled state.
  //   - sha is non-empty IFF status is "fixed";
  //   - infra_error is present IFF status is "infra-blocked".
  if ((sha !== '') !== (status === 'fixed')) {
    fail(
      'status-coupling',
      `${path}.sha`,
      `sha must be non-empty iff status is "fixed" (status "${status}", sha ${sha === '' ? 'empty' : 'set'})`,
    );
  }
  if (hasInfraError !== (status === 'infra-blocked')) {
    fail(
      'status-coupling',
      `${path}.infra_error`,
      `infra_error must be present iff status is "infra-blocked" (status "${status}")`,
    );
  }

  const base: FindingRecord = { ...common, status, sha };
  return infra_error === undefined ? base : { ...base, infra_error };
}

function validateVerification(value: unknown): VerificationRecord | null {
  if (value === null) return null;
  const record = requireRecord(value, 'verification');
  requireKeys(record, 'verification', VERIFICATION_KEYS);
  rejectUnknownKeys(record, 'verification', VERIFICATION_KEYS);
  const sha = requireString(record['sha'], 'verification.sha');
  const scope: TestRef = requireEnum(record['scope'], 'verification.scope', TEST_REFS);
  const completed_at = requireString(record['completed_at'], 'verification.completed_at');
  return { sha, scope, completed_at };
}

function validateSelfReview(value: unknown): SelfReviewRecord | null {
  if (value === null) return null;
  const record = requireRecord(value, 'self_review');
  requireKeys(record, 'self_review', SELF_REVIEW_REQUIRED);
  rejectUnknownKeys(record, 'self_review', SELF_REVIEW_ALLOWED);
  const sha = requireString(record['sha'], 'self_review.sha');
  if (sha.length === 0) fail('non-empty', 'self_review.sha', 'must be a non-empty string');
  const verdict = requireEnum(record['verdict'], 'self_review.verdict', SELF_REVIEW_VERDICTS);
  const noted_at = requireString(record['noted_at'], 'self_review.noted_at');
  if (!Object.hasOwn(record, 'note')) return { sha, verdict, noted_at };
  const note = requireString(record['note'], 'self_review.note');
  return { sha, verdict, noted_at, note };
}

function validateFindingsFileV2(value: unknown): FindingsFileV2 {
  const root = requireRecord(value, '');
  /* Schema gate FIRST: a v1 file is missing v2-required keys, so a
     requireKeys-first order would report a generic `required` failure and
     swallow the loud regenerate instruction. */
  if (root['schema'] !== 2) {
    fail(
      'schema-version',
      'schema',
      'schema v1 unsupported; regenerate via review/classify; old file left untouched',
    );
  }
  requireKeys(root, '', TOP_REQUIRED);
  rejectUnknownKeys(root, '', TOP_ALLOWED);
  const mode = requireEnum(root['mode'], 'mode', MODES);
  const generated_at = requireString(root['generated_at'], 'generated_at');
  const run_id = requireNullableId(root['run_id'], 'run_id');
  const base_sha = requireNullableId(root['base_sha'], 'base_sha');
  // Binding invariant: both null (unbound draft) or both set (bound to a run).
  if ((run_id === null) !== (base_sha === null)) {
    fail(
      'type',
      'run_id',
      'run_id and base_sha must both be null (unbound) or both be set (bound)',
    );
  }
  const revision = requireInteger(root['revision'], 'revision');
  if (revision < 0) fail('type', 'revision', `must be >= 0, got ${revision}`);
  const verification = validateVerification(root['verification']);
  const self_review = Object.hasOwn(root, 'self_review')
    ? validateSelfReview(root['self_review'])
    : null;

  const findingsRaw = root['findings'];
  if (!Array.isArray(findingsRaw)) {
    fail('type', 'findings', `must be an array of findings, got ${describeValue(findingsRaw)}`);
  }
  const findings = findingsRaw.map((entry: unknown, index: number) =>
    validateFinding(entry, `findings[${index}]`),
  );

  // Finding ids are unique — an invariant on BOTH read and write (a duplicate id
  // would make trailer/status routing ambiguous).
  const seen = new Set<string>();
  findings.forEach((finding, index) => {
    if (seen.has(finding.id)) {
      fail('duplicate-id', `findings[${index}].id`, `duplicate finding id "${finding.id}"`);
    }
    seen.add(finding.id);
  });

  // §F5 unbound-lifecycle coupling: `fixed`/`fix-failed`/`infra-blocked` are born ONLY
  // inside a bound run (they are the outcomes of a slice attempt). An unbound draft
  // (`run_id === null`) carrying one is corrupt — reject loudly rather than let a fix
  // verb act on a state that predates any run identity.
  if (run_id === null) {
    findings.forEach((finding, index) => {
      if (BOUND_ONLY_STATUSES.includes(finding.status)) {
        fail(
          'status-coupling',
          `findings[${index}].status`,
          `an unbound findings file (run_id null) cannot contain status "${finding.status}" (born only in a bound run)`,
        );
      }
    });
  }

  return { schema: 2, mode, generated_at, run_id, base_sha, revision, verification, self_review, findings };
}

// ── Public read API ──────────────────────────────────────────────────────────

// Reads + validates an untrusted findings file (schema v2). Throws
// FindingsValidationError (carrying `.rule`) on a structural violation; an unsafe
// path is localized to a finding's `status: "invalid"` instead. A v1 file is
// rejected loudly (rule `schema-version`) — there is no migration.
export function readFindings(path: string, deps: FindingsIoDeps = { readFile: realReadFile }): FindingsFileV2 {
  const raw = deps.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail('type', '', `findings file is not valid JSON: ${detail}`);
  }
  return validateFindingsFileV2(parsed);
}

// Serializes with a stable canonical key order so write → read → write is
// byte-idempotent. Trailing newline, two-space indent (matches the repo's JSON).
// `infra_error` is emitted only when present.
function serializeFindingsV2(file: FindingsFileV2): string {
  const selfReview =
    file.self_review === null
      ? {}
      : {
          self_review:
            file.self_review.note === undefined
              ? {
                  sha: file.self_review.sha,
                  verdict: file.self_review.verdict,
                  noted_at: file.self_review.noted_at,
                }
              : {
                  sha: file.self_review.sha,
                  verdict: file.self_review.verdict,
                  noted_at: file.self_review.noted_at,
                  note: file.self_review.note,
                },
        };
  const ordered = {
    schema: file.schema,
    mode: file.mode,
    generated_at: file.generated_at,
    run_id: file.run_id,
    base_sha: file.base_sha,
    revision: file.revision,
    verification:
      file.verification === null
        ? null
        : {
            sha: file.verification.sha,
            scope: file.verification.scope,
            completed_at: file.verification.completed_at,
          },
    ...selfReview,
    findings: file.findings.map((f) => {
      const base = {
        id: f.id,
        severity: f.severity,
        file: f.file,
        line: f.line,
        title: f.title,
        impact: f.impact,
        needs_plan: f.needs_plan,
        test_ref: f.test_ref,
        slice_files: f.slice_files,
        classification: f.classification,
        status: f.status,
        sha: f.sha,
      };
      return f.infra_error === undefined ? base : { ...base, infra_error: f.infra_error };
    }),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ── The single mutator ─────────────────────────────────────────────────────────

// Confine the findings path under `reportsRootAbs` (lexical + realpath, so a `../`
// or a symlink escape is rejected) and return the path RELATIVE to the root (for
// writeConfined). Throws `path-unsafe` on escape.
function confineFindingsPath(findingsPath: string, reportsRootAbs: string, realpath: (p: string) => string): string {
  const abs = path.resolve(findingsPath);
  const relLexical = path.relative(reportsRootAbs, abs);
  if (relLexical === '' || relLexical.startsWith('..') || path.isAbsolute(relLexical)) {
    fail('path-unsafe', findingsPath, 'findings path resolves outside paths.reports');
  }
  // Symlink escape: the findings file is READ, so a symlink pointing out of the
  // reports root would leak an out-of-tree file. realpath both ends and re-check.
  const relReal = path.relative(realpath(reportsRootAbs), realpath(abs));
  if (relReal === '' || relReal.startsWith('..') || path.isAbsolute(relReal)) {
    fail('path-unsafe', findingsPath, 'findings path resolves outside paths.reports (symlink escape)');
  }
  return relLexical;
}

// A parsed lock body. `pid` identifies the holder (for liveness); `nonce` is the
// per-acquire token that proves ownership across a takeover race and a safe release.
interface LockBody {
  pid: number;
  nonce: string;
}

// Parses a lock body, or null when it is ABSENT / unreadable / incomplete (missing an
// integer pid). A null parse is NOT stale — it can be the sub-millisecond window
// between a competitor's O_EXCL create and its body write — so the caller treats it as
// a CONFLICT, never a takeover. `nonce` defaults to '' for a legacy body without one
// (still a valid parse: liveness is decided by pid).
function parseLockBody(content: string | null): LockBody | null {
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed['pid'] === 'number' && Number.isInteger(parsed['pid'])) {
      const nonce = typeof parsed['nonce'] === 'string' ? parsed['nonce'] : '';
      return { pid: parsed['pid'], nonce };
    }
  } catch {
    /* unreadable lock body → CONFLICT (a competitor may be mid-create) */
  }
  return null;
}

// Acquire `<findings>.lock` and return OUR nonce (proof of ownership for release). The
// full body is written in ONE call under O_EXCL. If the lock already exists:
//   - an unparseable/incomplete body → CONFLICT (a competitor is mid-create; NOT stale);
//   - a parseable body with a LIVE pid → CONFLICT;
//   - a parseable body with a DEAD pid → stale: take over UNDER A GUARD FILE (below).
//
// G1: the stale takeover is serialized behind an O_EXCL guard `<lock>.takeover` so a
// SECOND late taker cannot remove the fresh LIVE lock the first taker just installed
// (a plain remove+create+re-read-own-nonce loses to a remove that lands AFTER the
// re-read). Only the guard owner may remove the dead lock, and it removes it only after
// RE-CONFIRMING (under the guard) the lock is still dead — a taker that won the guard
// before us may have already installed a live lock we must leave alone. The guard is
// unlinked once our own lock is in place. A guard we cannot create is a CONFLICT (no
// recursive guards): a guard held by a DEAD pid means a taker crashed mid-takeover and
// needs manual removal (a double crash), never another layer of automatic takeover.
function acquireLock(lockPath: string, deps: MutateFindingsDeps): string {
  const nonce = randomUUID();
  const payload = JSON.stringify({ pid: deps.pid(), nonce, created_at: deps.now() });
  if (deps.lock.create(lockPath, payload)) return nonce;

  const body = parseLockBody(deps.lock.read(lockPath));
  if (body === null) throw new FindingsConflictError(lockPath, null);
  if (deps.lock.isAlive(body.pid)) throw new FindingsConflictError(lockPath, body.pid);

  // Stale (dead holder). Serialize the takeover behind a guard file.
  const guardPath = `${lockPath}.takeover`;
  if (!deps.lock.create(guardPath, payload)) {
    const guard = parseLockBody(deps.lock.read(guardPath));
    if (guard !== null && !deps.lock.isAlive(guard.pid)) {
      throw new FindingsConflictError(
        lockPath,
        guard.pid,
        `stale takeover guard "${guardPath}" from a crashed takeover; remove it manually`,
      );
    }
    throw new FindingsConflictError(lockPath, guard?.pid ?? null);
  }
  try {
    // Re-read under the guard: a taker that won the guard before us may have already
    // installed a LIVE lock. Remove ONLY a still-dead lock.
    const current = parseLockBody(deps.lock.read(lockPath));
    if (current !== null && deps.lock.isAlive(current.pid)) {
      throw new FindingsConflictError(lockPath, current.pid);
    }
    deps.lock.remove(lockPath);
    if (!deps.lock.create(lockPath, payload)) throw new FindingsConflictError(lockPath, null);
    // Defensive re-read: with the guard held no other taker can overwrite our lock, so a
    // foreign nonce here can only mean a lock writer that ignores the guard — still a CONFLICT.
    const after = parseLockBody(deps.lock.read(lockPath));
    if (after === null || after.nonce !== nonce) {
      throw new FindingsConflictError(lockPath, after?.pid ?? null);
    }
    return nonce;
  } finally {
    deps.lock.remove(guardPath);
  }
}

// Release `<findings>.lock` — but ONLY when it still carries OUR nonce. An absent or
// FOREIGN lock (a taker-over won a race after we returned) is left untouched: unlinking
// it would free a lock we do not own.
function releaseLock(lockPath: string, nonce: string, deps: MutateFindingsDeps): void {
  const body = parseLockBody(deps.lock.read(lockPath));
  if (body !== null && body.nonce === nonce) deps.lock.remove(lockPath);
}

function assertImmutableBinding(before: FindingsFileV2, next: FindingsFileV2): void {
  if (before.run_id !== null && next.run_id !== before.run_id) {
    fail('immutable', 'run_id', `run_id is immutable once bound (${before.run_id})`);
  }
  if (before.base_sha !== null && next.base_sha !== before.base_sha) {
    fail('immutable', 'base_sha', `base_sha is immutable once bound (${before.base_sha})`);
  }
}

// The SOLE findings writer. Under `<findings>.lock`: read + validate, apply `fn`,
// enforce run_id/base_sha immutability against the pre-image, re-validate the
// result, bump `revision`, and write via a confined atomic replace. Every findings
// write (bind, classify, verification, slice status) MUST route through here.
// `ctx.reportsRootAbs` is the confinement root — the mutator does NOT compute it.
//
// §F2 optimistic-revision guard: a caller with a long read-work-write span (commit-slice
// stages + runs a throwaway-worktree test; verify spawns the shim) passes
// `expectedRevision` — the revision it read at the START of that span. If the file has
// moved on under the lock (a concurrent classify / slice write bumped it), the check
// fails with FindingsConflictError (EXIT_FINDINGS_CONFLICT) BEFORE `fn` runs, so a stale
// verb never clobbers a newer file.
export function mutateFindings(
  findingsPath: string,
  ctx: { reportsRootAbs: string },
  fn: (file: FindingsFileV2) => FindingsFileV2,
  deps: MutateFindingsDeps = realMutateDeps,
  expectedRevision?: number,
): FindingsFileV2 {
  const relPath = confineFindingsPath(findingsPath, ctx.reportsRootAbs, deps.realpath);
  const lockPath = `${findingsPath}.lock`;
  const nonce = acquireLock(lockPath, deps);
  try {
    const before = readFindings(findingsPath, { readFile: deps.readFile });
    if (expectedRevision !== undefined && before.revision !== expectedRevision) {
      throw new FindingsConflictError(
        lockPath,
        null,
        `findings changed under the CAS window: expected revision ${expectedRevision}, on disk ${before.revision} (${findingsPath}); re-run the verb`,
      );
    }
    const proposed = fn(before);
    assertImmutableBinding(before, proposed);
    // Re-validate the mutator's output exactly as a read would (structure, binding
    // invariant, unique ids), so no `fn` can persist an invalid file.
    const validated = validateFindingsFileV2(proposed);
    const next: FindingsFileV2 = { ...validated, revision: before.revision + 1 };
    deps.writeConfined(ctx.reportsRootAbs, relPath, serializeFindingsV2(next));
    return next;
  } finally {
    releaseLock(lockPath, nonce, deps);
  }
}
