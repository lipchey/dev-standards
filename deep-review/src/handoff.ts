// E6 — the landing handoff, read through ADR-012. There is NO local merge verb and
// NO local merge gate for this engine to call: ADR-012 replaced those with the
// GitHub PR ship cycle. `decideHandoff` is therefore a CONTEXT-DETECT +
// INSTRUCTION-EMITTER ONLY — it lands nothing, invokes nothing that mutates, and
// names no merge verb. deep-review ALWAYS lands the standalone way: it leaves a
// committed `deep-review/<slug>` branch for a human to open and review as a PR
// (that branch has no workflow feature record, so no automated ship cycle could
// operate on it anyway).
//
// The ONLY effect this module performs is a single read-only branch lookup behind
// the injected `getBranch` seam (default `git rev-parse --abbrev-ref HEAD`, fixed
// argv, `shell: false`). NO git mutation, NO network. A failed branch read fails
// closed with a §2.4 MachineError naming step "rev-parse" (mirrors the slice.ts /
// worktree.ts GitStepError idiom).

import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from './types.ts';
import type { FindingRecord, FindingsFile, FindingStatus, MachineError } from './types.ts';

// Bound the machine-readable stderr_tail (mirrors slice.ts / worktree.ts).
const STDERR_TAIL_MAX = 2000;

export type HandoffMode = 'standalone';

// ── Effects seam ───────────────────────────────────────────────────────────────

// The injected effects. `getBranch` is the SINGLE read-only branch lookup — it may
// THROW on a git read failure (not a repo / detached HEAD), which decideHandoff
// catches and converts to a §2.4 MachineError. It is a READ; there is deliberately
// NO mutating seam on this interface.
export interface HandoffDeps {
  cwd: string;
  getBranch: () => string;
}

// What `decideHandoff` returns at the command edge. Optional fields are OMITTED
// (never undefined) under exactOptionalPropertyTypes via conditional spreads.
export interface HandoffResult {
  exitCode: number;
  mode?: HandoffMode;
  instruction?: string;
  machineError?: MachineError;
}

// ── Branch-read edge (read-only; fixed argv, shell:false) ──────────────────────

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

// A failed branch read, carrying the §2.4 MachineError fields (mirrors slice.ts /
// worktree.ts GitStepError). `kind` is a cross-realm tag so a bundled copy is still
// recognizable. The `step` is always "rev-parse" for this module.
class GitStepError extends Error {
  readonly kind = 'handoff-git-error' as const;
  readonly command: string;
  readonly stderr_tail: string;
  readonly step: string;
  constructor(command: string, stderrTail: string, message: string) {
    super(message);
    this.name = 'GitStepError';
    this.step = 'rev-parse';
    this.command = command;
    this.stderr_tail = stderrTail;
    Object.setPrototypeOf(this, GitStepError.prototype);
  }
}

// Converts ANY branch-read throw into a §2.4 MachineError naming step "rev-parse".
// A GitStepError (the real seam) carries the git command + stderr tail; a generic
// throw (a stubbed seam, an unexpected error) is wrapped with empty tail so the
// failure path never crashes.
function branchReadError(error: unknown): MachineError {
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

// The real default branch read: a single fixed-argv `git rev-parse --abbrev-ref
// HEAD` (`shell: false`, no mutation, no network). Throws a GitStepError when git
// fails to spawn, exits non-zero, or reports no resolvable branch (empty or the
// detached-HEAD sentinel "HEAD") — the fail-closed path the §2.4 contract requires.
function defaultGetBranch(cwd: string): string {
  const command = 'git rev-parse --abbrev-ref HEAD';
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  if (r.error !== undefined) {
    const message = r.error instanceof Error ? r.error.message : String(r.error);
    throw new GitStepError(command, '', `${command} failed to spawn: ${message}`);
  }
  if (r.status !== 0) {
    throw new GitStepError(command, tailOf(r.stderr ?? ''), `${command} failed (status ${r.status})`);
  }
  const branch = (r.stdout ?? '').trim();
  if (branch === '' || branch === 'HEAD') {
    throw new GitStepError(command, tailOf(r.stderr ?? ''), `${command} resolved no branch (detached or unborn HEAD)`);
  }
  return branch;
}

// The production deps: the real read-only branch lookup. Mirrors slice.ts
// `realSliceDeps` / worktree.ts `realWorktreeDeps`.
export function realHandoffDeps(cwd: string): HandoffDeps {
  return {
    cwd,
    getBranch: () => defaultGetBranch(cwd),
  };
}

// ── Findings status summary (metadata only — counts + ids, never code) ─────────

// The rejected buckets, in a fixed display order after the fixed count. Each is a
// recorded `status` the slice/classify passes assign (§2.3).
const REJECTED_STATUSES: readonly FindingStatus[] = ['no-touch', 'needs-plan', 'fix-failed', 'invalid'];

// A concise one-line-per-bucket summary: the count of `status: "fixed"` slices
// plus each rejected bucket with its count. Ids (slugs) are included for
// traceability — metadata only, NEVER raw code (the §2.3 metadata-only floor).
function summarizeFindings(findings: readonly FindingRecord[]): string {
  const line = (status: FindingStatus): string => {
    const ids = findings.filter((f) => f.status === status).map((f) => f.id);
    const suffix = ids.length > 0 ? ` (${ids.join(', ')})` : '';
    return `  - ${status}: ${ids.length}${suffix}`;
  };
  const lines = [line('fixed'), ...REJECTED_STATUSES.map(line)];
  return `Findings status:\n${lines.join('\n')}`;
}

// ── Instruction emitters ────────────────────────────────────────────────────────

// standalone: deep-review leaves a committed branch for a human to open and review
// as a PR — and MUST NOT suggest the automated ship cycle (no feature record
// exists, so it could not operate on this branch).
function standaloneInstruction(branch: string, summary: string): string {
  return [
    'Landing mode: standalone (a human owns landing).',
    `The deep-review helper has landed nothing and mutates nothing. It leaves a committed branch \`${branch}\` for a human to open and review as a PR. This branch has no workflow feature record, so a human drives the PR review and landing directly.`,
    '',
    summary,
  ].join('\n');
}

// ── The decision ────────────────────────────────────────────────────────────────

export function decideHandoff(findingsFile: FindingsFile, deps: HandoffDeps): HandoffResult {
  // 1. Mode gate FIRST — landing is a fix-flow step; a review-only run changes
  // nothing, so refuse BEFORE any git read (no getBranch call).
  if (findingsFile.mode !== 'review-and-refactor') {
    return { exitCode: EXIT_WRONG_STATE };
  }

  // 2. The ONLY effect: a read-only branch lookup behind the injected seam. A failed
  // read (not a repo / detached HEAD) fails closed with a §2.4 MachineError.
  let branch: string;
  try {
    branch = deps.getBranch();
  } catch (error) {
    return { exitCode: EXIT_FAILURE, machineError: branchReadError(error) };
  }

  // 3. Findings status summary (metadata only) + the standalone landing instruction.
  // deep-review always leaves a committed branch for a human to open as a PR.
  const summary = summarizeFindings(findingsFile.findings);
  return { exitCode: EXIT_OK, mode: 'standalone', instruction: standaloneInstruction(branch, summary) };
}
