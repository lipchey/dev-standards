// §6 (spec) durable-authority trailers: the `Workflow-Phase: <state>` git-commit
// trailer is the DURABLE/recovery authority (the runtime READ authority is the
// planning-file front-matter `state`). This module is the trailer half of that
// two-role contract (ADR-012, Phase 3): a PURE formatter + a PURE reader, with
// the single git invocation isolated at the edge in `runGit` so the parsing
// logic is unit-testable without git and the recover/divergence integration is
// tested against real ephemeral repos.
//
// Written from day one: `complete` builds EVERY transition commit message
// through `withWorkflowPhaseTrailer`, so the durable record exists from the very
// first transition. The two-commit `implement-plan` shape can leave an untrailed
// CODE commit on top of the trailed planning-file commit, so "HEAD's trailer"
// means the MOST RECENT `Workflow-Phase` trailer reachable from HEAD — the reader
// searches back past untrailed commits, it never looks only at HEAD's own message.

import { spawnSync } from 'node:child_process';
import { WORKFLOW_STATES } from './types.ts';
import type { WorkflowState } from './types.ts';
import { CorruptStateError } from './front-matter.ts';

// The exact trailer key (§6). Pinned so call sites read by name and never drift.
export const WORKFLOW_PHASE_TRAILER_KEY = 'Workflow-Phase';

const STATE_SET: ReadonlySet<string> = new Set<string>(WORKFLOW_STATES);

// A git-trailer-shaped line: `Token: value` (RFC-822-ish). Used to decide whether
// the last paragraph of a message is already a trailer block (so a new trailer is
// appended WITHIN it, with no extra blank line) vs ordinary body text.
const TRAILER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*: .+$/;
// Our specific trailer; the value is captured and trimmed of surrounding blanks.
const WORKFLOW_PHASE_LINE_RE = /^Workflow-Phase:[ \t]*(.+?)[ \t]*$/;

// Record separator placed after each commit body by the git-log format, so the
// reader can split bodies apart without a body's own blank lines being ambiguous.
const RECORD_SEP = '\x1e';

export function isWorkflowState(value: string): value is WorkflowState {
  return STATE_SET.has(value);
}

// ── Pure formatter ───────────────────────────────────────────────────────────

// Appends a NORMALIZED `Workflow-Phase: <state>` trailer onto a commit message.
// Idempotent in the key: any existing Workflow-Phase trailer line is removed
// first, so re-applying replaces the value rather than duplicating the trailer.
// If the last paragraph is already a trailer block (e.g. a Co-Authored-By line),
// the new trailer joins that block; otherwise it is separated from the body by a
// blank line, per git's trailer convention. The result has no trailing newline.
export function withWorkflowPhaseTrailer(message: string, state: WorkflowState): string {
  const trailer = `${WORKFLOW_PHASE_TRAILER_KEY}: ${state}`;
  // Drop trailing whitespace/newlines, then strip any existing Workflow-Phase
  // trailer line(s) so the key is single-valued (normalize).
  const lines = message.replace(/\s+$/, '').split('\n');
  const kept = lines.filter((line) => !WORKFLOW_PHASE_LINE_RE.test(line));

  // Nothing left (the message was empty or only a Workflow-Phase trailer): the
  // trailer stands alone.
  if (kept.every((line) => line.trim() === '')) {
    return trailer;
  }

  // The last paragraph is the block of lines after the final blank line.
  const lastBlank = kept.lastIndexOf('');
  const lastParagraph = kept.slice(lastBlank + 1);
  const lastIsTrailerBlock =
    lastParagraph.length > 0 && lastParagraph.every((line) => TRAILER_LINE_RE.test(line));

  // Join within an existing trailer block (single newline); otherwise open a new
  // trailer paragraph (blank-line separated).
  const separator = lastIsTrailerBlock ? '\n' : '\n\n';
  return `${kept.join('\n')}${separator}${trailer}`;
}

// ── Pure reader ──────────────────────────────────────────────────────────────

// The Workflow-Phase trailer value in a single commit body, or null. Reads the
// trailer ONLY from the FINAL trailer block — the last paragraph (after the final
// blank line) that consists ENTIRELY of git-trailer-shaped lines. This mirrors the
// WRITER (`withWorkflowPhaseTrailer`, which places the trailer in the final block)
// and git's own trailer semantics: a `Workflow-Phase:` line that is ordinary body
// text (e.g. followed by more prose, so the last paragraph is NOT a pure trailer
// block) is NOT a trailer and must not be mistaken for the durable authority.
function trailerInBody(body: string): string | null {
  // Drop trailing blank lines so the "final paragraph" is the real last block.
  const lines = body.replace(/\s+$/, '').split('\n');
  if (lines.every((line) => line.trim() === '')) return null;
  // The final paragraph: the lines after the last blank line.
  const lastBlank = lines.lastIndexOf('');
  const lastParagraph = lines.slice(lastBlank + 1);
  // It is a trailer block only when non-empty AND every line is trailer-shaped.
  const isTrailerBlock =
    lastParagraph.length > 0 && lastParagraph.every((line) => TRAILER_LINE_RE.test(line));
  if (!isTrailerBlock) return null;
  // Scan the final trailer block bottom-up for the Workflow-Phase trailer.
  for (let i = lastParagraph.length - 1; i >= 0; i -= 1) {
    const line = lastParagraph[i];
    if (line === undefined) continue;
    const match = WORKFLOW_PHASE_LINE_RE.exec(line);
    if (match !== null && match[1] !== undefined) return match[1];
  }
  return null;
}

// The most-recent `Workflow-Phase` trailer value across commit bodies given
// NEWEST-FIRST (git-log default order). Returns the first body that carries the
// trailer — i.e. the closest to HEAD — skipping untrailed commits on top. Returns
// the raw string value (membership is validated by `readHeadWorkflowPhase`).
export function lastWorkflowPhaseTrailer(bodiesNewestFirst: string[]): string | null {
  for (const body of bodiesNewestFirst) {
    const value = trailerInBody(body);
    if (value !== null) return value;
  }
  return null;
}

// ── Pure divergence predicate ────────────────────────────────────────────────

// Divergence (§spec-6): the durable record (last reachable Workflow-Phase
// trailer) names a state the runtime front matter does NOT reflect. The front
// matter is authoritative at runtime; this is the safety check that the durable
// record is CONSISTENT with it. A null trailer (no durable record yet, the
// pre-first-transition window) is never divergence — there is nothing to diverge
// from. An untrailed code commit on top is also not divergence: the LAST reachable
// trailer still names the recorded state (the reader looks past the untrailed
// commit). Divergence is precisely "a durable trailer exists and differs from the
// front-matter state" — e.g. the record write was lost after the trailer landed.
export function diverges(
  frontMatterState: WorkflowState,
  headTrailer: WorkflowState | null,
): boolean {
  return headTrailer !== null && headTrailer !== frontMatterState;
}

// ── Git edge ─────────────────────────────────────────────────────────────────

// The single git invocation seam. Fixed-argv spawnSync with shell:false (NEVER a
// shell string, never `git add -A`), so untrusted state never reaches a shell.
// Injectable as RunGit so recover/divergence are testable against real ephemeral
// repos while the pure trailer logic above needs no git at all.
export type RunGit = (args: string[], cwd: string) => string;

// The §2.7 machine-readable error payload (design §5). The CLI emits this as the
// LAST line of stderr on any gh/git/network failure; S14's gh adapter reuses the
// SAME shape. `step` is optional (named only where the call site knows it).
export interface MachineReadableError {
  command: string;
  step?: string;
  message: string;
  stderr_tail: string;
}

// Structured git failure: a non-zero git exit (or a spawn error). Carries the
// fields the §2.7 machine-readable error object needs — `command` (the git argv,
// never a shell string) and `stderr_tail` (the trailing stderr) — plus an optional
// `step`. `kind` is a cross-realm tag (a bundled copy can defeat `instanceof`),
// mirroring CorruptStateError / LockBusyError / CommitScopeError.
export class GitError extends Error {
  readonly kind = 'git-error' as const;
  readonly command: string;
  readonly stderr_tail: string;
  step?: string;
  constructor(command: string, stderrTail: string, message: string, step?: string) {
    super(message);
    this.name = 'GitError';
    this.command = command;
    this.stderr_tail = stderrTail;
    if (step !== undefined) this.step = step;
    Object.setPrototypeOf(this, GitError.prototype);
  }
}

// The shared `GitError` predicate (its home, next to GitError/MachineReadableError).
// Cross-realm-safe: a bundled copy can defeat `instanceof`, so it also matches the
// documented `kind` tag. Imported by every command that maps a caught git failure
// to the §2.7 machine-readable error (ship, fetch-review) instead of re-copying it.
export function isGitError(error: unknown): error is GitError {
  return error instanceof GitError || (typeof error === 'object' && error !== null && (error as { kind?: unknown }).kind === 'git-error');
}

// Projects a `GitError` onto the §2.7 machine-readable error object. Keys are in
// the documented order (command, [step,] message, stderr_tail); `step` is present
// only when the call site named it. Shared with ship/fetch-review (no local copy).
export function machineGitError(error: GitError): MachineReadableError {
  return error.step === undefined
    ? { command: error.command, message: error.message, stderr_tail: error.stderr_tail }
    : { command: error.command, step: error.step, message: error.message, stderr_tail: error.stderr_tail };
}

// Keep the machine-readable `stderr_tail` bounded so a runaway stderr cannot
// bloat the emitted JSON line. The trailing bytes are the most diagnostic.
const STDERR_TAIL_MAX = 2000;

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

export function runGit(args: string[], cwd: string): string {
  const command = `git ${args.join(' ')}`;
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    // A spawn-level failure (git missing, cwd gone): no exit status, no stderr.
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    throw new GitError(command, tailOf(message), `${command} failed to spawn: ${message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new GitError(
      command,
      tailOf(result.stderr ?? ''),
      `${command} failed (status ${result.status}): ${detail}`,
    );
  }
  return result.stdout;
}

// Reads HEAD's durable Workflow-Phase trailer: the most recent reachable trailer
// value, validated against WORKFLOW_STATES. Returns null when no commit reachable
// from HEAD carries the trailer. A present-but-invalid trailer value is a corrupt
// durable record (the recovery authority is unusable) and raises CorruptStateError.
export function readHeadWorkflowPhase(cwd: string, run: RunGit = runGit): WorkflowState | null {
  const out = run(['log', `--format=%B${RECORD_SEP}`], cwd);
  // git appends a newline after each commit's formatted output; the leading
  // newline of each record (after the prior separator) is trimmed below.
  const bodies = out
    .split(RECORD_SEP)
    .map((body) => body.replace(/^\n+/, ''))
    .filter((body) => body.trim() !== '');
  const raw = lastWorkflowPhaseTrailer(bodies);
  if (raw === null) return null;
  if (!isWorkflowState(raw)) {
    throw new CorruptStateError(
      'bad-trailer-value',
      `HEAD ${WORKFLOW_PHASE_TRAILER_KEY} trailer value "${raw}" is not a valid WorkflowState`,
    );
  }
  return raw;
}
