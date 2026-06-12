// §2.7 CLI argv parsing -> command dispatch. This is a frozen-contract surface:
// the exit-code mapping (§2.7) is the CLI contract. For S10 the dispatch table
// wires exactly ONE command (`status`); every other command resolves to an
// unknown-command usage error (exit 2). Later phases add their rows here.
//
// The command logic is PURE over an injected IO seam (CliIO): it does no real
// fs/git/process IO and never calls `process.exit`. The runner edge
// (./workflow-runner.ts) supplies the real seams and maps the returned numeric
// exit code to `process.exit`, so the dispatched commands stay unit-testable
// without touching the filesystem or the process streams.

import path from 'node:path';
import {
  EXIT_FAILURE,
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_USAGE,
  WORKFLOW_PHASES,
} from './types.ts';
import type { ForcedAction, FrontMatter, WorkflowPhase } from './types.ts';
import {
  CorruptStateError,
  parseFrontMatter,
  serializeFrontMatter,
} from './front-matter.ts';
import { LockBusyError, withLock } from './lock.ts';
import type { LockSeams } from './lock.ts';
import { computeDivergence, recover, splitPlanningFile, worktreeOf } from './recover.ts';
import type { RunGit } from './trailers.ts';
import { gate } from './gate.ts';
import type { GateOptions, GateResult } from './gate.ts';
import { complete, requestChanges, start } from './transactions.ts';
import type { TransactionDeps, TransactionResult } from './transactions.ts';
import { CommitScopeError } from './commit-scope.ts';
import { runDoctor } from './doctor.ts';
import type { DoctorProbes } from './doctor.ts';
import { resume } from './resume.ts';
import type { ResumeDeps } from './resume.ts';

// The gate's --wait deadline when the caller does not configure one (the §2.8
// config default lands with the manifest wiring; the CLI uses a fixed fallback).
const DEFAULT_GATE_WAIT_SECONDS = 300;

// The planning file lives at the worktree root (spec §3). `status` reads it from
// the current working directory by default; `--file <path>` overrides for tests
// and non-conventional layouts.
const PLANNING_FILE_NAME = 'workflow-session-planning.md';

// The quality manifest (§2.8 workflow config) and the project-facts doc, both at
// the repo root by convention. `doctor` reads the manifest for the workflow config
// and checks the project-facts doc exists alongside the required review guides.
const MANIFEST_FILE_NAME = 'quality.json';
const PROJECT_FACTS_REL = '.agents/project-facts.md';

const USAGE = [
  'usage: workflow <command> [options]',
  '',
  'commands:',
  '  status [--file <path>]                      print the planning file state and per-phase summary',
  '  recover [--file <path>]                     reconcile front-matter state to HEAD\'s durable trailer',
  '  start <phase> [--file <path>]               claim a phase and advance to its in-progress state',
  '  complete <phase> [--approved] [--file ...]  finish a phase (review-plan --approved auto-advances)',
  '  request-changes <producer> --reason <text>  loop a reviewed artifact back to its producer',
  '  gate <phase> [--wait] [--force --reason t]  evaluate the three-step gate for a phase',
  '  resume [--file <path>]                      exit needs-human back to the prior state (by reason)',
  '  doctor [--arm] [--file ...] [--manifest ..] non-mutating setup/health diagnosis',
  '',
].join('\n');

// The injected IO edge. Everything side-effecting lives behind these so the
// dispatch logic is pure and testable. `writeFile` and `runGit` are the seams
// `recover` needs (it WRITES the planning file and reads HEAD's git trailer);
// the runner edge supplies the real fs/git implementations.
export interface CliIO {
  cwd: () => string;
  readFile: (filePath: string) => string; // throws on a missing/unreadable file
  writeFile: (filePath: string, content: string) => void; // recover rewrites the planning file
  runGit: RunGit; // recover/divergence read HEAD's Workflow-Phase trailer
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // The transaction/gate edge seams (the runner supplies real implementations).
  // Optional so read-only callers (status) need not provide them; the mutating
  // verbs require them and surface an internal-wiring error otherwise.
  now?: () => number; // wall clock (ms) for `updated`/budget and the gate --wait
  sleep?: (ms: number) => void; // blocking poll step for the gate --wait
  claimedBy?: string; // caller identity for the owner check / forced actions
  // doctor's injected effect edge (fs existence/writability, env reads, the
  // cmux/wrapper/gh probes). Optional so non-doctor callers need not provide it;
  // the runner edge passes `realDoctorProbes()`.
  doctorProbes?: DoctorProbes;
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`workflow: ${message}\n${USAGE}`);
  return EXIT_USAGE;
}

// `lockSeams` is the §2.10 mutex edge that state-mutating commands (recover) run
// inside. It is injected (not imported here) so cli.ts performs no direct fs/git
// IO and stays unit-testable; the runner edge passes `realLockSeams()`. Read-only
// commands (status) ignore it, so it is optional for those call sites.
export function runCli(argv: string[], io: CliIO, lockSeams?: LockSeams): number {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return usageError(io, 'missing command');
  }
  switch (command) {
    case 'status':
      return runStatus(rest, io);
    case 'recover':
      return runRecover(rest, io, lockSeams);
    case 'start':
      return runTransactionCommand('start', rest, io, lockSeams, {}, (phase, deps) => start(phase, deps));
    case 'complete':
      return runTransactionCommand('complete', rest, io, lockSeams, { approved: true }, (phase, deps, args) =>
        complete(phase, { approved: args.approved }, deps),
      );
    case 'request-changes':
      return runTransactionCommand(
        'request-changes',
        rest,
        io,
        lockSeams,
        { reason: true, reasonRequired: true },
        (phase, deps, args) => requestChanges(phase, { reason: args.reason ?? '' }, deps),
        // request-changes is the only verb that evaluates the §8 budget triggers,
        // so it threads the budget ceilings from quality.json into the deps.
        loadBudget,
      );
    case 'gate':
      return runGate(rest, io, lockSeams);
    case 'resume':
      return runResume(rest, io, lockSeams);
    case 'doctor':
      return runDoctorCommand(rest, io);
    default:
      return usageError(io, `unknown command "${command}"`);
  }
}

// Parses the shared optional `--file <path>` flag (the only flag `status` and
// `recover` take). A missing value, a repeat, or any unexpected argument is a
// usage error (exit 2) distinct from a runtime failure; on that path the carried
// `exitCode` is returned and the command stops. `command` names the offender.
type FileFlag = { ok: true; filePath: string | undefined } | { ok: false; exitCode: number };

function parseFileFlag(command: string, args: string[], io: CliIO): FileFlag {
  let filePath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--file') {
      const value = args[i + 1];
      if (value === undefined) {
        return { ok: false, exitCode: usageError(io, `${command}: missing value for --file <path>`) };
      }
      if (filePath !== undefined) {
        return { ok: false, exitCode: usageError(io, `${command}: --file may be given only once`) };
      }
      filePath = value;
      i += 1;
      continue;
    }
    return { ok: false, exitCode: usageError(io, `${command}: unexpected argument "${arg}"`) };
  }
  return { ok: true, filePath };
}

// `status` parses its own flags so an unknown flag / missing value is a usage
// error (exit 2) distinct from a runtime read failure.
function runStatus(args: string[], io: CliIO): number {
  const flag = parseFileFlag('status', args, io);
  if (!flag.ok) return flag.exitCode;

  const resolved = flag.filePath ?? path.join(io.cwd(), PLANNING_FILE_NAME);

  // A missing/unreadable planning file is a runtime failure (exit 1), not a usage
  // error: the invocation was well-formed (spec §3 "any skill that cannot find
  // the file refuses to run").
  let text: string;
  try {
    text = io.readFile(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.stderr(`status: cannot read planning file at "${resolved}": ${detail}\n`);
    return EXIT_FAILURE;
  }

  // A corrupt planning file surfaces the typed corrupt-state error path. It is a
  // `needs_human_reason` value (§2.1) resolved only by `workflow recover`, so it
  // maps to EXIT_NEEDS_HUMAN (13) — consistent with the gate's divergence verdict
  // ("stop, a human must intervene first"), not the infra-failure exit 1.
  let frontMatter: FrontMatter;
  try {
    frontMatter = parseFrontMatter(extractFrontMatter(text));
  } catch (error) {
    if (isCorruptState(error)) {
      const detail = error instanceof Error ? error.message : String(error);
      io.stderr(
        `status: planning file at "${resolved}" is corrupt (${detail}); run \`workflow recover\`\n`,
      );
      return EXIT_NEEDS_HUMAN;
    }
    throw error;
  }

  io.stdout(formatStatus(frontMatter));
  return EXIT_OK;
}

// `recover` reconciles the runtime front-matter `state` to HEAD's durable
// Workflow-Phase trailer (one-directional; the trailer wins). It is state
// mutating, so it runs inside the §2.10 worktree lock — which requires the
// injected lock seams. Exit-code contract (§2.7): OK (0) on success or no-op,
// LOCK_BUSY (14) when the mutex is held, NEEDS_HUMAN (13) for a corrupt planning
// file (recover cannot rebuild broken YAML), FAILURE (1) for a read/git failure.
function runRecover(args: string[], io: CliIO, lockSeams: LockSeams | undefined): number {
  const flag = parseFileFlag('recover', args, io);
  if (!flag.ok) return flag.exitCode;

  if (lockSeams === undefined) {
    // The runner edge always supplies the lock seams; their absence is an
    // internal wiring error, never reachable from a well-formed invocation.
    io.stderr('recover: internal error: lock seams were not provided\n');
    return EXIT_FAILURE;
  }

  const resolved = flag.filePath ?? path.join(io.cwd(), PLANNING_FILE_NAME);
  const worktree = worktreeOf(resolved);

  try {
    const result = recover({
      planningFile: resolved,
      worktree,
      readFile: io.readFile,
      writeFile: io.writeFile,
      run: io.runGit,
      lockSeams,
    });
    if (result.changed) {
      io.stdout(
        `recover: reconciled state ${result.fromState} -> ${result.toState} from HEAD Workflow-Phase trailer\n`,
      );
    } else if (result.headTrailer === null) {
      io.stdout('recover: no durable Workflow-Phase trailer reachable from HEAD; nothing to reconcile\n');
    } else {
      io.stdout(`recover: front matter already matches HEAD trailer (${result.toState}); nothing to do\n`);
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof LockBusyError) {
      io.stderr(`recover: ${error.message}\n`);
      return error.exitCode;
    }
    // A structurally corrupt planning file is a `corrupt-state` needs_human_reason
    // (§2.1): recover v1 reconciles state from the trailer, it does not rebuild
    // broken YAML, so it surfaces NEEDS_HUMAN (13) for human intervention.
    if (isCorruptState(error)) {
      const detail = error instanceof Error ? error.message : String(error);
      io.stderr(`recover: planning file at "${resolved}" is corrupt (${detail})\n`);
      return EXIT_NEEDS_HUMAN;
    }
    const detail = error instanceof Error ? error.message : String(error);
    io.stderr(`recover: failed: ${detail}\n`);
    return EXIT_FAILURE;
  }
}

// ── start / complete / request-changes (the state-mutating verbs) ────────────

// Flags a given command accepts beyond the shared `--file <path>`.
interface AllowedFlags {
  approved?: boolean; // complete
  reason?: boolean; // request-changes / gate --force
  reasonRequired?: boolean; // request-changes
  wait?: boolean; // gate
  force?: boolean; // gate
}

interface ParsedArgs {
  phase: WorkflowPhase;
  filePath: string | undefined;
  approved: boolean;
  reason: string | undefined;
  wait: boolean;
  force: boolean;
}

type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; exitCode: number };

function isWorkflowPhase(token: string): token is WorkflowPhase {
  return (WORKFLOW_PHASES as readonly string[]).includes(token);
}

// Shared parser for the phase-taking commands: one positional <phase> plus the
// command's allowed flags. A malformed invocation (missing/extra positional,
// unknown flag, missing flag value, invalid phase) is a usage error (exit 2),
// distinct from a runtime refusal.
function parseCommandArgs(
  command: string,
  argv: string[],
  io: CliIO,
  allowed: AllowedFlags,
): ParseResult {
  let phase: WorkflowPhase | undefined;
  let filePath: string | undefined;
  let reason: string | undefined;
  let approved = false;
  let wait = false;
  let force = false;

  const needValue = (i: number, flag: string): string | undefined => {
    const value = argv[i + 1];
    if (value === undefined) {
      usageError(io, `${command}: missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--file') {
      const value = needValue(i, '--file <path>');
      if (value === undefined) return { ok: false, exitCode: EXIT_USAGE };
      if (filePath !== undefined) return { ok: false, exitCode: usageError(io, `${command}: --file may be given only once`) };
      filePath = value;
      i += 1;
      continue;
    }
    if (arg === '--reason' && allowed.reason === true) {
      const value = needValue(i, '--reason <text>');
      if (value === undefined) return { ok: false, exitCode: EXIT_USAGE };
      reason = value;
      i += 1;
      continue;
    }
    if (arg === '--approved' && allowed.approved === true) {
      approved = true;
      continue;
    }
    if (arg === '--wait' && allowed.wait === true) {
      wait = true;
      continue;
    }
    if (arg === '--force' && allowed.force === true) {
      force = true;
      continue;
    }
    if (arg.startsWith('--')) {
      return { ok: false, exitCode: usageError(io, `${command}: unexpected flag "${arg}"`) };
    }
    if (phase !== undefined) {
      return { ok: false, exitCode: usageError(io, `${command}: unexpected argument "${arg}"`) };
    }
    if (!isWorkflowPhase(arg)) {
      return { ok: false, exitCode: usageError(io, `${command}: "${arg}" is not a workflow phase`) };
    }
    phase = arg;
  }

  if (phase === undefined) {
    return { ok: false, exitCode: usageError(io, `${command}: missing <phase> argument`) };
  }
  if (allowed.reasonRequired === true && reason === undefined) {
    return { ok: false, exitCode: usageError(io, `${command}: --reason <text> is required`) };
  }
  return { ok: true, args: { phase, filePath, approved, reason, wait, force } };
}

// The mutating verbs need the lock seams plus the clock + caller identity. The
// runner edge always supplies them; their absence is an internal wiring error
// (never reachable from a well-formed invocation), surfaced like recover's.
interface MutationEdge {
  lockSeams: LockSeams;
  now: () => number;
  claimedBy: string;
}

function requireMutationEdge(
  io: CliIO,
  lockSeams: LockSeams | undefined,
  command: string,
): MutationEdge | number {
  if (lockSeams === undefined || io.now === undefined || io.claimedBy === undefined) {
    io.stderr(`${command}: internal error: edge seams (lock/clock/identity) were not provided\n`);
    return EXIT_FAILURE;
  }
  return { lockSeams, now: io.now, claimedBy: io.claimedBy };
}

// Shared body for start / complete / request-changes: parse, build the injected
// TransactionDeps, invoke the transaction, and map the result/throws to the §2.7
// exit code. The transaction itself owns the lock, divergence, owner, and
// precondition checks; the CLI only translates the outcome.
function runTransactionCommand(
  command: string,
  argv: string[],
  io: CliIO,
  lockSeams: LockSeams | undefined,
  allowed: AllowedFlags,
  invoke: (phase: WorkflowPhase, deps: TransactionDeps, args: ParsedArgs) => TransactionResult,
  loadBudgetFor?: (io: CliIO, worktree: string) => { totalSeconds: number; perPassSeconds?: number },
): number {
  const parsed = parseCommandArgs(command, argv, io, allowed);
  if (!parsed.ok) return parsed.exitCode;
  const edge = requireMutationEdge(io, lockSeams, command);
  if (typeof edge === 'number') return edge;

  const resolved = parsed.args.filePath ?? path.join(io.cwd(), PLANNING_FILE_NAME);
  const worktree = worktreeOf(resolved);
  const deps: TransactionDeps = {
    planningFile: resolved,
    worktree,
    readFile: io.readFile,
    writeFile: io.writeFile,
    run: io.runGit,
    lockSeams: edge.lockSeams,
    now: edge.now,
    claimedBy: edge.claimedBy,
  };
  if (loadBudgetFor !== undefined) {
    deps.budget = loadBudgetFor(io, worktree);
  }

  try {
    const result = invoke(parsed.args.phase, deps, parsed.args);
    if (result.exitCode === EXIT_OK) {
      const advance = result.autoAdvanced === true ? ' (auto-advanced)' : '';
      io.stdout(`${command}: ${result.phase} ${result.fromState} -> ${result.toState}${advance}\n`);
    } else {
      io.stderr(`${command}: ${result.message ?? result.outcome}\n`);
    }
    return result.exitCode;
  } catch (error) {
    return mapMutationError(io, command, resolved, error);
  }
}

// The §8 total-budget default (`budget.workflow_total_seconds`) when quality.json
// is absent or the workflow block omits a budget. Pinned to the §8 default.
const DEFAULT_WORKFLOW_TOTAL_SECONDS = 5400;

// Loads the §8 budget ceilings for the request-changes triggers from the §2.8
// `workflow.budget` block of quality.json at the worktree root. This is the CLI
// EDGE READ only — `doctor` (CHECK_CONFIG) owns §2.8 validation, so this never
// re-validates: it reads the configured total (defaulting to the §8 5400 when the
// file/block/field is absent or non-numeric) and the OPTIONAL, sparse per-pass
// ceiling. The per-pass ceiling is read defensively — present only after the
// §2.8 sparse per-phase map lands — and omitted otherwise (=> no per-pass check).
function loadBudget(io: CliIO, worktree: string): { totalSeconds: number; perPassSeconds?: number } {
  const manifestPath = path.join(worktree, MANIFEST_FILE_NAME);
  let manifest: unknown;
  try {
    manifest = JSON.parse(io.readFile(manifestPath));
  } catch {
    // Absent/unreadable/invalid quality.json => fall back to the §8 default total
    // and no per-pass ceiling. (doctor surfaces a malformed manifest separately.)
    return { totalSeconds: DEFAULT_WORKFLOW_TOTAL_SECONDS };
  }
  const workflow = readRecord(manifest, 'workflow');
  const budget = workflow === undefined ? undefined : readRecord(workflow, 'budget');
  const totalRaw = budget?.['workflow_total_seconds'];
  const totalSeconds =
    typeof totalRaw === 'number' && Number.isFinite(totalRaw) && totalRaw > 0
      ? totalRaw
      : DEFAULT_WORKFLOW_TOTAL_SECONDS;
  const perPassRaw = budget?.['per_pass_seconds'];
  if (typeof perPassRaw === 'number' && Number.isFinite(perPassRaw) && perPassRaw > 0) {
    return { totalSeconds, perPassSeconds: perPassRaw };
  }
  return { totalSeconds };
}

// Reads a nested object field as a plain record (object, non-array), or undefined.
function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return undefined;
  return child as Record<string, unknown>;
}

// ── gate ─────────────────────────────────────────────────────────────────────

// `gate <phase>`: evaluate the three-step gate, wiring the REAL divergence check
// (recover.computeDivergence) into the gate's seam, the real clock/sleep for
// --wait, and a forced-action sink that appends to forced_actions[] UNDER the
// lock for --force. The gate is observe-only except the force path, which is the
// only mutation (hence the lock).
function runGate(argv: string[], io: CliIO, lockSeams: LockSeams | undefined): number {
  const parsed = parseCommandArgs('gate', argv, io, { wait: true, force: true, reason: true });
  if (!parsed.ok) return parsed.exitCode;
  const a = parsed.args;
  if (io.now === undefined || io.sleep === undefined) {
    io.stderr('gate: internal error: clock seams were not provided\n');
    return EXIT_FAILURE;
  }
  const now = io.now;
  const sleep = io.sleep;
  const resolved = a.filePath ?? path.join(io.cwd(), PLANNING_FILE_NAME);
  const worktree = worktreeOf(resolved);

  const recordForcedAction = (action: ForcedAction): void => {
    const { frontMatterText, body } = splitPlanningFile(io.readFile(resolved));
    const fm = parseFrontMatter(frontMatterText);
    // The gate builds `at` via toISOString (millisecond precision); the subset
    // accepts only bare seconds, so it is normalized before persisting.
    const at = action.at.replace(/\.\d{3}Z$/, 'Z');
    fm.forced_actions = [...(fm.forced_actions ?? []), { ...action, at }];
    fm.updated = at;
    io.writeFile(resolved, serializeFrontMatter(fm) + body);
  };

  const opts: GateOptions = {
    wait: a.wait,
    waitSeconds: DEFAULT_GATE_WAIT_SECONDS,
    force: a.force,
    claimedBy: io.claimedBy ?? '',
  };
  if (a.reason !== undefined) opts.reason = a.reason;
  const runGateOnce = (): GateResult =>
    gate(a.phase, opts, {
      readState: () => parseFrontMatter(extractFrontMatter(io.readFile(resolved))),
      checkDivergence: () =>
        computeDivergence({ planningFile: resolved, worktree, readFile: io.readFile, run: io.runGit }),
      now,
      sleep,
      recordForcedAction,
    });

  try {
    let result: GateResult;
    if (a.force) {
      // The force path persists a forced action: run under the §2.10 mutex.
      if (lockSeams === undefined) {
        io.stderr('gate: internal error: lock seams were not provided\n');
        return EXIT_FAILURE;
      }
      result = withLock(worktree, lockSeams, runGateOnce);
    } else {
      result = runGateOnce();
    }
    const need =
      result.requiredPreconditions !== undefined
        ? ` (need: ${result.requiredPreconditions.join(', ')})`
        : '';
    const detail = result.message !== undefined ? ` - ${result.message}` : '';
    const line = `gate: ${result.phase} ${result.outcome} [${result.state}]${need}${detail}\n`;
    (result.exitCode === EXIT_OK ? io.stdout : io.stderr)(line);
    return result.exitCode;
  } catch (error) {
    return mapMutationError(io, 'gate', resolved, error);
  }
}

// ── resume (exit needs-human) ────────────────────────────────────────────────

// `resume`: the only normal exit from needs-human. State-mutating, so it runs
// inside the §2.10 mutex and needs the clock + caller identity. It applies the
// per-reason resolution, records the waiver, and returns to the prior state;
// corrupt-state refuses with NEEDS_HUMAN pointing at `workflow recover`.
function runResume(args: string[], io: CliIO, lockSeams: LockSeams | undefined): number {
  const flag = parseFileFlag('resume', args, io);
  if (!flag.ok) return flag.exitCode;
  const edge = requireMutationEdge(io, lockSeams, 'resume');
  if (typeof edge === 'number') return edge;

  const resolved = flag.filePath ?? path.join(io.cwd(), PLANNING_FILE_NAME);
  const deps: ResumeDeps = {
    planningFile: resolved,
    worktree: worktreeOf(resolved),
    readFile: io.readFile,
    writeFile: io.writeFile,
    run: io.runGit,
    lockSeams: edge.lockSeams,
    now: edge.now,
    claimedBy: edge.claimedBy,
  };

  try {
    const result = resume(deps);
    if (result.exitCode === EXIT_OK) {
      io.stdout(`resume: ${result.reason} ${result.fromState} -> ${result.toState}\n`);
    } else {
      io.stderr(`resume: ${result.message ?? result.outcome}\n`);
    }
    return result.exitCode;
  } catch (error) {
    return mapMutationError(io, 'resume', resolved, error);
  }
}

// ── doctor (non-mutating setup/health diagnosis) ─────────────────────────────

// `doctor`: a list of independent named checks (NON-mutating, no lock), then the
// transition table. `--arm` runs the "when arming" cmux + wrapper checks; the gh
// check runs only when the workflow is enabled; notify-env is warn-only. Exit 0
// when all BLOCKING checks pass, non-zero otherwise. The probe seams (fs/env/cmux/
// wrapper/gh) are injected via io.doctorProbes (the runner passes realDoctorProbes).
function runDoctorCommand(args: string[], io: CliIO): number {
  let filePath: string | undefined;
  let manifestPath: string | undefined;
  let arming = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--arm') {
      arming = true;
      continue;
    }
    if (arg === '--file' || arg === '--manifest') {
      const value = args[i + 1];
      if (value === undefined) return usageError(io, `doctor: missing value for ${arg} <path>`);
      if (arg === '--file') filePath = value;
      else manifestPath = value;
      i += 1;
      continue;
    }
    return usageError(io, `doctor: unexpected argument "${arg}"`);
  }

  if (io.doctorProbes === undefined) {
    // The runner edge always supplies the probes; their absence is an internal
    // wiring error, never reachable from a well-formed invocation.
    io.stderr('doctor: internal error: probe seams were not provided\n');
    return EXIT_FAILURE;
  }

  const resolved = filePath ?? path.join(io.cwd(), PLANNING_FILE_NAME);
  const worktree = worktreeOf(resolved);
  const result = runDoctor({
    planningFile: resolved,
    worktree,
    manifestPath: manifestPath ?? path.join(worktree, MANIFEST_FILE_NAME),
    repoRoot: worktree,
    projectFactsPath: path.join(worktree, PROJECT_FACTS_REL),
    arming,
    readFile: io.readFile,
    run: io.runGit,
    probes: io.doctorProbes,
  });

  for (const check of result.checks) {
    const mark = check.ok ? 'ok' : check.blocking ? 'FAIL' : 'warn';
    io.stdout(`doctor: [${mark}] ${check.name}: ${check.detail}\n`);
  }
  io.stdout(`${result.transitionTable}\n`);
  io.stdout(`doctor: ${result.ok ? 'all blocking checks passed' : 'one or more blocking checks failed'}\n`);
  return result.exitCode;
}

// Maps a thrown error from a mutating verb (or the gate force path) to the §2.7
// exit code: LOCK_BUSY (14), a commit-scope refusal -> WRONG_STATE (11), corrupt
// planning file -> NEEDS_HUMAN (13), anything else -> FAILURE (1).
function mapMutationError(io: CliIO, command: string, resolved: string, error: unknown): number {
  if (error instanceof LockBusyError) {
    io.stderr(`${command}: ${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof CommitScopeError) {
    io.stderr(`${command}: ${error.message}\n`);
    return error.exitCode;
  }
  if (isCorruptState(error)) {
    const detail = error instanceof Error ? error.message : String(error);
    io.stderr(`${command}: planning file at "${resolved}" is corrupt (${detail}); run \`workflow recover\`\n`);
    return EXIT_NEEDS_HUMAN;
  }
  const detail = error instanceof Error ? error.message : String(error);
  io.stderr(`${command}: failed: ${detail}\n`);
  return EXIT_FAILURE;
}

// True for the typed corrupt-state error. Uses both `instanceof` and the
// cross-realm-safe `kind` tag the front-matter module documents, since a bundled
// copy can defeat `instanceof`.
function isCorruptState(error: unknown): boolean {
  if (error instanceof CorruptStateError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'corrupt-state'
  );
}

// A real planning file is markdown: YAML front matter fenced by `---` lines,
// followed by the Plan body. The front-matter parser accepts ONLY the fenced
// block (it rejects any content after the closing fence), so slice out the
// leading block before parsing. If no well-formed fence pair is found, hand the
// raw text back so the parser yields the canonical corrupt-state error
// (missing-open-fence / missing-close-fence).
function extractFrontMatter(text: string): string {
  const lines = text.split('\n');
  if (lines[0] !== '---') return text;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      return `${lines.slice(0, i + 1).join('\n')}\n`;
    }
  }
  return text;
}

// Human-readable status. Prints the current state and the per-phase summary
// (spec §3 fields); no fields are invented beyond the front-matter schema.
function formatStatus(fm: FrontMatter): string {
  const lines: string[] = [
    `feature:      ${fm.feature}`,
    `branch:       ${fm.branch}`,
    `state:        ${fm.state}`,
    `round:        ${fm.loopback_count + 1} (loopback ${fm.loopback_count}/${fm.loopback_cap})`,
    `claimed_by:   ${fm.claimed_by}`,
    `updated:      ${fm.updated}`,
    `budget_spent: ${fm.budget_spent.total_seconds}s`,
  ];
  if (fm.needs_human_reason !== undefined) {
    lines.push(`needs_human:  ${fm.needs_human_reason}`);
  }
  lines.push('phases:');
  let recorded = 0;
  for (const phase of WORKFLOW_PHASES) {
    const record = fm.phases[phase];
    if (record === undefined) continue;
    recorded += 1;
    const parts = [
      `attempts=${record.attempts}`,
      `last_success_loop=${record.last_success_loop ?? '-'}`,
      `start_sha=${record.start_sha ?? '-'}`,
      `complete_sha=${record.complete_sha ?? '-'}`,
    ];
    if (record.auto_advanced !== undefined) {
      parts.push(`auto_advanced=${record.auto_advanced}`);
    }
    lines.push(`  ${phase}: ${parts.join(' ')}`);
  }
  if (recorded === 0) {
    lines.push('  (none recorded)');
  }
  return `${lines.join('\n')}\n`;
}

export { PLANNING_FILE_NAME };
