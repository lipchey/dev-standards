// E6 + Phase 5 §5.5 — the landing handoff, read through ADR-012. There is NO local
// merge verb and NO local merge gate for this engine to call. `decideHandoff` emits
// the standalone, human-opens-PR instruction — but ONLY once the run is COMPLETE:
// the completeness gate (§5.5) refuses (EXIT_WRONG_STATE) while any finding is still
// HANDOFF_BLOCKING (pending / infra-blocked), or the verification stamp is missing /
// stale (its sha != HEAD), or the worktree is dirty. The resolved dispositions
// (no-touch / needs-plan / invalid) do NOT block — handoff hands them to a human in
// the summary. deep-review leaves a committed `deep-review/<slug>` branch for a human
// to open and review as a PR; the human drives the landing directly.
//
// The effects are READ-ONLY git behind injected seams (branch / HEAD / status —
// fixed argv, `shell: false`). NO git mutation, NO network. Run identity
// (verifyDescriptor + findings binding) is enforced at the CLI edge BEFORE this runs.

import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from './types.ts';
import type { FindingRecord, FindingsFileV2, FindingStatus, MachineError } from './types.ts';
import { HANDOFF_BLOCKING_STATUSES } from './types.ts';
import { isWorktreeTooling } from './worktree.ts';
import type { Deadline } from './deadline.ts';

// Bound the machine-readable stderr_tail (mirrors slice.ts / worktree.ts).
const STDERR_TAIL_MAX = 2000;

export type HandoffMode = 'standalone';

// ── Effects seam ───────────────────────────────────────────────────────────────

// The injected READ-ONLY effects. `getBranch` / `getHead` / `getStatus` may THROW on
// a git read failure (not a repo / detached HEAD), which decideHandoff catches and
// converts to a §2.4 MachineError. There is deliberately NO mutating seam.
export interface HandoffDeps {
  cwd: string;
  getBranch: () => string;
  getHead: () => string; // HEAD sha, to compare against the verification stamp
  getStatus: () => string; // `git status --porcelain`, to detect a dirty worktree
}

// What `decideHandoff` returns at the command edge. Optional fields are OMITTED
// (never undefined) under exactOptionalPropertyTypes via conditional spreads.
export interface HandoffResult {
  exitCode: number;
  mode?: HandoffMode;
  instruction?: string;
  machineError?: MachineError;
}

// ── Read edge (read-only; fixed argv, shell:false) ─────────────────────────────

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// A failed git read, carrying the §2.4 MachineError fields (mirrors slice.ts /
// worktree.ts GitStepError). `kind` is a cross-realm tag so a bundled copy is still
// recognizable.
class GitStepError extends Error {
  readonly kind = 'handoff-git-error' as const;
  readonly command: string;
  readonly stderr_tail: string;
  readonly step: string;
  constructor(step: string, command: string, stderrTail: string, message: string) {
    super(message);
    this.name = 'GitStepError';
    this.step = step;
    this.command = command;
    this.stderr_tail = stderrTail;
    Object.setPrototypeOf(this, GitStepError.prototype);
  }
}

// Converts ANY git-read throw into a §2.4 MachineError. A GitStepError (the real
// seam) carries the git command + stderr tail + step; a generic throw (a stubbed
// seam, an unexpected error) is wrapped with an empty tail so the failure path never
// crashes.
function gitReadError(error: unknown): MachineError {
  if (error instanceof GitStepError) {
    return {
      command: error.command,
      step: error.step,
      message: error.message,
      stderr_tail: error.stderr_tail,
    };
  }
  return {
    command: 'git rev-parse --abbrev-ref HEAD',
    step: 'rev-parse',
    message: error instanceof Error ? error.message : String(error),
    stderr_tail: '',
  };
}

// §F7 per-git-call timeout cap (ms); the run deadline tightens it further per call.
const HANDOFF_GIT_CAP_MS = 15_000;

// The result of a fixed-argv read git spawn. `status` is null on a spawn fault / timeout.
export interface HandoffSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The raw git spawn seam (fixed argv, shell:false), extracted so the §F7 timeout wiring
// is unit-testable without touching the real process. `timeout` bounds the spawn.
export type HandoffGitSpawn = (args: readonly string[], cwd: string, timeout: number | undefined) => HandoffSpawnResult;

const defaultHandoffSpawn: HandoffGitSpawn = (args, cwd, timeout) => {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', shell: false, timeout });
  if (r.error !== undefined) {
    return { status: null, stdout: '', stderr: r.error instanceof Error ? r.error.message : String(r.error) };
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// The per-call timeout: the deadline's remaining budget, capped, floored at 1ms so an
// exhausted budget yields an immediate timeout. Undefined when no deadline is threaded.
function handoffTimeout(deadline: Deadline | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(1, Math.min(HANDOFF_GIT_CAP_MS, deadline.remainingMs()));
}

// A single fixed-argv read git (`shell: false`, no mutation, no network). Throws a
// GitStepError (naming `step`) on a spawn fault / timeout (null status) or non-zero exit.
function readGit(spawn: HandoffGitSpawn, cwd: string, args: string[], step: string, deadline: Deadline | undefined): string {
  const command = `git ${args.join(' ')}`;
  const r = spawn(args, cwd, handoffTimeout(deadline));
  if (r.status === null) {
    throw new GitStepError(step, command, tailOf(r.stderr), `${command} failed to spawn: ${r.stderr}`);
  }
  if (r.status !== 0) {
    throw new GitStepError(step, command, tailOf(r.stderr), `${command} failed (status ${r.status})`);
  }
  return r.stdout;
}

// The real default branch read: throws when git fails, exits non-zero, or reports no
// resolvable branch (empty or the detached-HEAD sentinel "HEAD") — the fail-closed
// path the §2.4 contract requires.
function defaultGetBranch(spawn: HandoffGitSpawn, cwd: string, deadline: Deadline | undefined): string {
  const branch = readGit(spawn, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 'rev-parse', deadline).trim();
  if (branch === '' || branch === 'HEAD') {
    throw new GitStepError('rev-parse', 'git rev-parse --abbrev-ref HEAD', '', 'git rev-parse --abbrev-ref HEAD resolved no branch (detached or unborn HEAD)');
  }
  return branch;
}

function defaultGetHead(spawn: HandoffGitSpawn, cwd: string, deadline: Deadline | undefined): string {
  const head = readGit(spawn, cwd, ['rev-parse', 'HEAD'], 'rev-parse', deadline).trim();
  if (head === '') {
    throw new GitStepError('rev-parse', 'git rev-parse HEAD', '', 'git rev-parse HEAD returned no sha');
  }
  return head;
}

function defaultGetStatus(spawn: HandoffGitSpawn, cwd: string, deadline: Deadline | undefined): string {
  return readGit(spawn, cwd, ['status', '--porcelain'], 'status', deadline);
}

// The production deps: the real read-only branch / HEAD / status lookups. §F7 the run
// deadline bounds every git spawn; `spawn` defaults to the real fixed-argv git spawn and
// is overridable so the timeout wiring is testable.
export function realHandoffDeps(cwd: string, deadline?: Deadline, spawn: HandoffGitSpawn = defaultHandoffSpawn): HandoffDeps {
  return {
    cwd,
    getBranch: () => defaultGetBranch(spawn, cwd, deadline),
    getHead: () => defaultGetHead(spawn, cwd, deadline),
    getStatus: () => defaultGetStatus(spawn, cwd, deadline),
  };
}

// ── Findings status summary (metadata only — counts + ids, never code) ─────────

// The dispositions listed in the handoff summary, in a fixed display order after the
// fixed count. The resolved dispositions (no-touch / needs-plan / invalid) are handed
// to the human here; fix-failed is included so a reverted red slice is still visible.
const SUMMARY_STATUSES: readonly FindingStatus[] = ['no-touch', 'needs-plan', 'fix-failed', 'invalid'];

// A concise one-line-per-bucket summary: the count of `status: "fixed"` slices plus
// each disposition bucket with its count + ids (slugs) for traceability — metadata
// only, NEVER raw code (the §2.3 metadata-only floor).
function summarizeFindings(findings: readonly FindingRecord[]): string {
  const line = (status: FindingStatus): string => {
    const ids = findings.filter((f) => f.status === status).map((f) => f.id);
    const suffix = ids.length > 0 ? ` (${ids.join(', ')})` : '';
    return `  - ${status}: ${ids.length}${suffix}`;
  };
  const lines = [line('fixed'), ...SUMMARY_STATUSES.map(line)];
  return `Findings status:\n${lines.join('\n')}`;
}

// ── Instruction emitter ──────────────────────────────────────────────────────────

// standalone: deep-review leaves a committed branch for a human to open and review
// as a PR — and MUST NEVER suggest any automated landing; a human drives the PR.
function standaloneInstruction(branch: string, summary: string): string {
  return [
    'Landing mode: standalone (a human owns landing).',
    `The deep-review helper has landed nothing and mutates nothing. It leaves a committed branch \`${branch}\` for a human to open and review as a PR. A human drives the PR review and landing directly.`,
    '',
    summary,
  ].join('\n');
}

// ── The decision ────────────────────────────────────────────────────────────────

// Dirty paths from `git status --porcelain` (v1), EXCLUDING the engine's own worktree-
// tooling footprint (the node_modules / .tools / submodule symlinks a consumer .gitignore
// lists as directories and so does not ignore — they always surface as dirty in a run
// worktree). The path starts at column 3; a rename's "old -> new" keeps the new path.
// Same exemption the slice scope gate applies, so handoff is not permanently blocked by
// artifacts the engine created itself.
function nonToolingDirtyPaths(status: string): string[] {
  return status
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .map((line) => line.slice(3).replace(/^.* -> /, ''))
    .filter((p) => p !== '' && !isWorktreeTooling(p));
}

export function decideHandoff(findingsFile: FindingsFileV2, deps: HandoffDeps): HandoffResult {
  // 1. Mode gate FIRST — landing is a fix-flow step; a review-only run changes
  // nothing, so refuse BEFORE any git read.
  if (findingsFile.mode !== 'review-and-refactor') {
    return { exitCode: EXIT_WRONG_STATE };
  }

  // 2. The completeness gate (§5.5). Read HEAD + porcelain status behind the seams;
  // a git-read failure fails closed with a §2.4 MachineError.
  let head: string;
  let status: string;
  try {
    head = deps.getHead();
    status = deps.getStatus();
  } catch (error) {
    return { exitCode: EXIT_FAILURE, machineError: gitReadError(error) };
  }

  const blocking = findingsFile.findings.filter((f) => HANDOFF_BLOCKING_STATUSES.includes(f.status));
  const reasons: string[] = [];
  if (blocking.length > 0) {
    const ids = blocking.map((f) => `${f.id}:${f.status}`).join(', ');
    reasons.push(`${blocking.length} finding(s) not terminal (${ids})`);
  }
  const verification = findingsFile.verification;
  if (verification === null) {
    reasons.push('no verification on record (run deep-review verify after the last slice)');
  } else if (verification.sha !== head) {
    reasons.push(`verification is stale: verified ${verification.sha}, HEAD is ${head} (re-run deep-review verify)`);
  }
  if (nonToolingDirtyPaths(status).length > 0) {
    reasons.push('the worktree is dirty (git status --porcelain is non-empty)');
  }
  if (reasons.length > 0) {
    return {
      exitCode: EXIT_WRONG_STATE,
      machineError: {
        command: 'deep-review handoff',
        message: `handoff refused: ${reasons.join('; ')}`,
        stderr_tail: '',
      },
    };
  }

  // 3. All clear: read the branch and emit the standalone landing instruction.
  let branch: string;
  try {
    branch = deps.getBranch();
  } catch (error) {
    return { exitCode: EXIT_FAILURE, machineError: gitReadError(error) };
  }
  const summary = summarizeFindings(findingsFile.findings);
  return { exitCode: EXIT_OK, mode: 'standalone', instruction: standaloneInstruction(branch, summary) };
}
