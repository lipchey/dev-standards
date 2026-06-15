// E6 — the ship/cleanup handoff, read through ADR-012. There is NO local merge
// verb and NO local merge gate for this engine to call: ADR-012 replaced those
// with the GitHub PR ship cycle. `decideHandoff` is therefore a CONTEXT-DETECT +
// INSTRUCTION-EMITTER ONLY — it lands nothing, invokes nothing that mutates, names
// no merge verb, and never suggests the automated ship cycle in the standalone
// case (a standalone `deep-review/<slug>` branch has no workflow feature record,
// so the automated cycle could not operate on it; the body's wording is "leave a
// committed branch for a human to open and review as a PR").
//
// Two landing modes, chosen by the SAME read-only marker check E5 uses
// (`isWorkflowWorktree`, reused — never re-implemented here):
//   in-session: an active workflow session owns the worktree (its planning marker
//     is present). Driving the committed branch to base is THAT session's job,
//     through the ADR-012 ship cycle (`workflow ship` -> human PR review ->
//     `process-review` -> human merge -> `workflow cleanup`). The helper itself
//     invokes none of those and mutates nothing.
//   standalone: no marker. The helper leaves a committed branch for a human to
//     open and review as a PR — no automated ship suggestion.
//
// The ONLY effect this module performs is a READ: the marker check (`existsSync`)
// and a single read-only branch lookup behind the injected `getBranch` seam
// (default `git rev-parse --abbrev-ref HEAD`, fixed argv, `shell: false`). NO git
// mutation, NO network. A failed branch read fails closed with a §2.4 MachineError
// naming step "rev-parse" (mirrors the slice.ts / worktree.ts GitStepError idiom).

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from './types.ts';
import type { FindingRecord, FindingsFile, FindingStatus, MachineError } from './types.ts';
import { isWorkflowWorktree } from './worktree.ts';

// Bound the machine-readable stderr_tail (mirrors slice.ts / worktree.ts).
const STDERR_TAIL_MAX = 2000;

export type HandoffMode = 'in-session' | 'standalone';

// ── Effects seam ───────────────────────────────────────────────────────────────

// The injected effects. `existsSync` is the read-only marker check shared with E5
// (isWorkflowWorktree keys on it); `getBranch` is the SINGLE read-only branch
// lookup — it may THROW on a git read failure (not a repo / detached HEAD), which
// decideHandoff catches and converts to a §2.4 MachineError. Both are READS; there
// is deliberately NO mutating seam on this interface.
export interface HandoffDeps {
  cwd: string;
  existsSync: (p: string) => boolean;
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

// The production deps: real fs marker check + the real read-only branch lookup.
// Mirrors slice.ts `realSliceDeps` / worktree.ts `realWorktreeDeps`.
export function realHandoffDeps(cwd: string): HandoffDeps {
  return {
    cwd,
    existsSync: (p) => fs.existsSync(p),
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

// in-session: the active workflow session drives the ADR-012 ship cycle. Names the
// full cycle (so the operator/agent knows the next steps), states the helper itself
// mutates nothing, and deliberately never names the removed merge verb.
function inSessionInstruction(branch: string, summary: string): string {
  return [
    'Landing mode: in-session (an active workflow session owns landing).',
    `The deep-review helper has landed nothing and mutates nothing here. The committed branch \`${branch}\` is driven to base by THIS active workflow session, through the ADR-012 PR ship cycle, in order:`,
    '  1. workflow ship',
    '  2. human PR review',
    '  3. process-review',
    '  4. human merge',
    '  5. workflow cleanup',
    '',
    summary,
  ].join('\n');
}

// standalone: no active session. The helper leaves a committed branch for a human
// to open and review as a PR — and MUST NOT suggest the automated ship cycle (no
// feature record exists, so it could not operate on this branch).
function standaloneInstruction(branch: string, summary: string): string {
  return [
    'Landing mode: standalone (no active workflow session owns landing).',
    `The deep-review helper has landed nothing and mutates nothing. It leaves a committed branch \`${branch}\` for a human to open and review as a PR. This branch has no workflow feature record, so a human drives the PR review and landing directly.`,
    '',
    summary,
  ].join('\n');
}

// ── The decision ────────────────────────────────────────────────────────────────

export function decideHandoff(findingsFile: FindingsFile, deps: HandoffDeps): HandoffResult {
  // 1. Mode gate FIRST — landing is a fix-flow step; a review-only run changes
  // nothing, so refuse BEFORE any git read (no getBranch call, no marker check).
  if (findingsFile.mode !== 'review-and-refactor') {
    return { exitCode: EXIT_WRONG_STATE };
  }

  // 2. Landing-mode detection: reuse E5's read-only marker check (never
  // re-implemented). Marker present -> the active session owns landing (in-session);
  // absent -> a human owns landing (standalone).
  const mode: HandoffMode = isWorkflowWorktree(deps.cwd, deps) ? 'in-session' : 'standalone';

  // 3. The ONLY effect: a read-only branch lookup behind the injected seam. A failed
  // read (not a repo / detached HEAD) fails closed with a §2.4 MachineError.
  let branch: string;
  try {
    branch = deps.getBranch();
  } catch (error) {
    return { exitCode: EXIT_FAILURE, machineError: branchReadError(error) };
  }

  // 4. Findings status summary (metadata only) + 5. the mode-specific instruction.
  const summary = summarizeFindings(findingsFile.findings);
  const instruction =
    mode === 'in-session' ? inSessionInstruction(branch, summary) : standaloneInstruction(branch, summary);

  return { exitCode: EXIT_OK, mode, instruction };
}
