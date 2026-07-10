// The deep-review CLI dispatch. `runCli` parses argv into a subcommand and routes
// it through a dispatch table with one entry per command. Every command is a STUB
// in E0 (returns EXIT_USAGE) — the later tasks (no-touch matcher, classifier,
// slice engine, report writer, worktree/handoff/verify) replace the stub bodies.
// An unknown or missing subcommand prints usage to stderr and returns EXIT_USAGE.
// Logic stays behind the injected `deps` seam (process streams) so it is testable
// without touching the real process, mirroring the runner CLI edge style.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT_OK, EXIT_USAGE, EXIT_FAILURE } from './types.ts';
import type { MachineError } from './types.ts';
import { loadConfig } from './config.ts';
import { buildNoTouchSet, isNoTouch } from './no-touch.ts';
import { readFindings, writeFindings, FindingsValidationError } from './findings-io.ts';
import { classifyAll } from './classify.ts';
import { commitSlice, realSliceDeps } from './slice.ts';
import { writeReport, realReportDeps } from './report.ts';
import { selectWorktree, realWorktreeDeps } from './worktree.ts';
import { decideHandoff, realHandoffDeps } from './handoff.ts';
import { runFinalVerify, realVerifyDeps } from './verify.ts';
import { SlugError } from './feature-slug.ts';

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Environment seams (added in E1; reused by E2–E4). The entrypoint
  // (deep-review-runner.ts) supplies only the stream sinks above; these default
  // to the real process/fs when omitted, so the edge stays minimal. Tests inject
  // all of them to keep command logic off the real process and disk.
  cwd?: () => string;
  readFile?: (filePath: string) => string;
  warn?: (message: string) => void;
}

// The full command surface. Each lands in its own later task; all are stubbed now.
const COMMANDS = [
  'check-path',
  'classify',
  'commit-slice',
  'report',
  'select-worktree',
  'handoff',
  'verify',
] as const;

type Command = (typeof COMMANDS)[number];

type CommandHandler = (rest: string[], deps: CliDeps) => number;

const USAGE = `usage: deep-review <command> [options]\ncommands: ${COMMANDS.join(', ')}\n`;

// The optional env seams, resolved to concrete functions.
interface ResolvedEnv {
  cwd: string;
  readFile: (filePath: string) => string;
  warn: (message: string) => void;
}

// Resolves the optional CliDeps env seams (cwd/readFile/warn) to concrete
// functions, defaulting to the real process/fs. Shared by every handler that
// touches the repo edge so the defaulting lives in one place.
function resolveEnv(deps: CliDeps): ResolvedEnv {
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const readFile = deps.readFile ?? ((p: string): string => readFileSync(p, 'utf8'));
  const warn = deps.warn ?? ((message: string): void => deps.stderr(`${message}\n`));
  return { cwd, readFile, warn };
}

// Builds the §2.5 no-touch set (BASELINE ∪ the repo's project-facts extensions)
// from the manifest at <cwd>/quality.json, wiring the resolved env seams. Shared
// by `check-path` and `classify`.
function buildSet(env: ResolvedEnv): string[] {
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  return buildNoTouchSet({
    noTouchGlobsRef: config.deepReview?.no_touch_globs_ref,
    readFile: (p: string): string => env.readFile(resolve(env.cwd, p)),
    warn: env.warn,
  });
}

// Pulls the value of a `--findings <path>` / `--findings=<path>` flag from argv,
// or undefined when absent (or the flag is the trailing token).
function parseFindingsFlag(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--findings') return rest[i + 1];
    if (arg.startsWith('--findings=')) return arg.slice('--findings='.length);
  }
  return undefined;
}

// Pulls the value of a `--slug <slug>` / `--slug=<slug>` flag from argv, or
// undefined when absent (or the flag is the trailing token). Mirrors
// parseFindingsFlag; the value is validated downstream by sanitizeFeatureSlug.
function parseSlugFlag(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--slug') return rest[i + 1];
    if (arg.startsWith('--slug=')) return arg.slice('--slug='.length);
  }
  return undefined;
}

// Parses a `--scope <--fast|--full>` / `--scope=<…>` flag, returning whether the
// flag was PRESENT and its value. verifyCmd uses `present` to distinguish an ABSENT
// flag (fall back to the config default) from a PRESENT-but-valueless one (a trailing
// `--scope`, or `--scope=`), which is a malformed invocation -> EXIT_USAGE per §2.2 —
// NOT a request for the default. Mirrors parseSlugFlag's scan.
function parseScopeFlag(rest: string[]): { present: boolean; value: string | undefined } {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--scope') return { present: true, value: rest[i + 1] };
    if (arg.startsWith('--scope=')) return { present: true, value: arg.slice('--scope='.length) };
  }
  return { present: false, value: undefined };
}

// `check-path <path>` — classify a single repo-relative path as `no-touch` or
// `editable` against the §2.5 floor (BASELINE ∪ the repo's project-facts
// extensions). Pure matching lives in ./no-touch.ts; this handler only resolves
// the manifest + ref and wires the injected env seams.
function checkPath(rest: string[], deps: CliDeps): number {
  const operand = rest[0];
  if (operand === undefined) {
    deps.stderr('deep-review check-path: missing <path> operand\n');
    return EXIT_USAGE;
  }
  const set = buildSet(resolveEnv(deps));
  deps.stdout(`${isNoTouch(operand, set) ? 'no-touch' : 'editable'}\n`);
  return EXIT_OK;
}

// `classify --findings <path>` — assign each finding its `classification` +
// lifecycle `status` (precedence: no-touch → needs-plan → fixable-now) and write
// the file back. Analysis, not a base mutation, so it runs in EITHER mode (§2.3 —
// no mode gate). Pure rules live in ./classify.ts; the no-touch set reuses the
// same wiring as `check-path`. The untrusted findings file goes through
// readFindings/writeFindings (real-fs default), which re-validate path safety.
function classify(rest: string[], deps: CliDeps): number {
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review classify: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const set = buildSet(resolveEnv(deps));
  const findingsFile = readFindings(findingsPath);
  writeFindings(findingsPath, classifyAll(findingsFile, set));
  return EXIT_OK;
}

// Pulls the first positional operand (the `<finding-id>`) from argv, skipping the
// `--findings <path>` flag (and its value) and any other `--flag`. Returns
// undefined when no positional is present.
function parseFindingId(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--findings') {
      i += 1; // skip the flag's value too
      continue;
    }
    if (arg.startsWith('--')) continue;
    return arg;
  }
  return undefined;
}

// `commit-slice <finding-id> --findings <path>` — the atomic slice engine (E3).
// The §2.4 contract (mode/eligibility/path/scope gates, test->commit-with-trailer
// | revert-and-fix-failed) lives in ./slice.ts; this handler only parses the
// operands, resolves the worktree cwd from the env seam, and renders the
// machine-readable error (when present) as the LAST line of stderr. EXIT codes
// (OK / WRONG_STATE / FAILURE) come straight from the engine.
function commitSliceCmd(rest: string[], deps: CliDeps): number {
  const findingId = parseFindingId(rest);
  if (findingId === undefined || findingId === '') {
    deps.stderr('deep-review commit-slice: missing <finding-id> operand\n');
    return EXIT_USAGE;
  }
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review commit-slice: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  // Build the §2.5 no-touch set with the SAME wiring as check-path/classify and
  // hand it to the engine, which re-enforces the floor against the untrusted
  // findings file (a slice may name a no-touch path even when finding.file is
  // editable).
  const noTouchSet = buildSet(env);
  const result = commitSlice(findingId, findingsPath, realSliceDeps(env.cwd, noTouchSet));
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  }
  return result.exitCode;
}

// `report --findings <path>` — render + write the metadata-only deep-review
// report to <reportsDir>/deep-review-<date>.md. Construction is the primary
// safety guarantee (metadata only, single-line-per-field); a best-effort secret
// scan over the rendered body aborts the write on a hit. Runs in EITHER mode
// (§2.3 — no mode gate): it summarizes the run regardless of review-only vs
// review-and-refactor. The untrusted findings file goes through readFindings
// (real-fs default), which re-validates path safety. reportsDir comes from the
// manifest (paths.reports), resolved against the repo root so the file lands in
// the right place; the scanner + write seam are wired to the same repo root via
// realReportDeps. On a secret-scan hit the §2.4 machine error is the LAST line of
// stderr; on success the written path is printed to stdout.
function report(rest: string[], deps: CliDeps): number {
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review report: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  const findingsFile = readFindings(findingsPath);
  const result = writeReport(
    findingsFile,
    realReportDeps(env.cwd, resolve(env.cwd, config.reportsDir)),
  );
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  } else if (result.path !== undefined) {
    deps.stdout(`${result.path}\n`);
  }
  return result.exitCode;
}

// `select-worktree --slug <slug>` — create an engine-local `deep-review/<slug>`
// worktree under `../worktrees` off HEAD (E5). The §2 contract (sanitize gate,
// base resolution, confinement guard, collision/idempotency gate) lives in
// ./worktree.ts; this handler parses the flag, resolves the worktree cwd, prints
// the chosen mode/worktree/branch, and maps a SlugError to EXIT_USAGE at the argv
// edge (a git failure renders the §2.4 machine error as the LAST stderr line). It
// reads NO config — the worktree parent/base come only from the repo HEAD.
function selectWorktreeCmd(rest: string[], deps: CliDeps): number {
  const slug = parseSlugFlag(rest);
  if (slug === undefined || slug === '') {
    deps.stderr('deep-review select-worktree: missing --slug <slug>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  try {
    const result = selectWorktree(slug, realWorktreeDeps(env.cwd));
    if (result.machineError !== undefined) {
      deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
    } else if (result.mode !== undefined && result.worktree !== undefined) {
      const branch = result.branch !== undefined ? ` ${result.branch}` : '';
      deps.stdout(`${result.mode} ${result.worktree}${branch}\n`);
    }
    return result.exitCode;
  } catch (error) {
    // An unsafe --slug operand is an argv-level usage error, not an io failure: map
    // it to EXIT_USAGE before runCli's catch turns a throw into EXIT_FAILURE.
    if (error instanceof SlugError) {
      deps.stderr(`deep-review select-worktree: invalid --slug operand ${JSON.stringify(slug)}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

// `handoff --findings <path>` — emit the ADR-012 standalone landing instruction
// (E6). The engine is an instruction emitter ONLY: it lands nothing, names no merge
// verb, and never suggests any automated landing. The §2.3 mode gate means a
// `review-only` findings file returns
// EXIT_WRONG_STATE. handoff reads NO config — only cwd + the (untrusted) findings
// file, which goes through readFindings (real-fs default; a FindingsValidationError
// flows through runCli's toMachineError path). The chosen instruction is printed to
// stdout; on a branch-read failure the §2.4 machine error is the LAST stderr line.
function handoffCmd(rest: string[], deps: CliDeps): number {
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review handoff: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  const findingsFile = readFindings(findingsPath);
  const result = decideHandoff(findingsFile, realHandoffDeps(env.cwd));
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  } else if (result.instruction !== undefined) {
    deps.stdout(`${result.instruction}\n`);
  }
  return result.exitCode;
}

// `verify [--scope <--fast|--full>]` — the final verify gate (E7). The deep-review
// runtime calls this AFTER all slices and BEFORE handoff: a GREEN verify (exit 0)
// clears the refactor to proceed; a RED verify is EXIT_NEEDS_HUMAN (13) and nothing
// lands. Scope is `--scope` ?? deep_review.verify_after_fix ?? --fast, validated here
// (an invalid operand is an argv-level usage error -> EXIT_USAGE before any spawn).
// The §2 contract (absolute fixed-argv shim spawn, exit mapping) lives in
// ./verify.ts; on a spawn failure the §2.4 machine error is the LAST stderr line, else
// a one-line status is printed to stdout.
function verifyCmd(rest: string[], deps: CliDeps): number {
  const env = resolveEnv(deps);
  const scopeFlag = parseScopeFlag(rest);
  // A PRESENT but valueless --scope (a trailing `--scope`, or `--scope=`) is a bad
  // operand, NOT a request for the default -> EXIT_USAGE before loading config or
  // spawning verify (§2.2). An ABSENT flag falls back to the config default below.
  if (scopeFlag.present && (scopeFlag.value === undefined || scopeFlag.value === '')) {
    deps.stderr('deep-review verify: --scope requires a value (--fast or --full)\n');
    return EXIT_USAGE;
  }
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  const scope = scopeFlag.value ?? config.deepReview?.verify_after_fix ?? '--fast';
  if (scope !== '--fast' && scope !== '--full') {
    deps.stderr(
      `deep-review verify: invalid --scope operand ${JSON.stringify(scope)} (expected --fast or --full)\n`,
    );
    return EXIT_USAGE;
  }
  const result = runFinalVerify(realVerifyDeps(env.cwd, scope));
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  } else {
    deps.stdout(`verify ${scope}: ${result.exitCode === EXIT_OK ? 'ok' : 'needs-human'}\n`);
  }
  return result.exitCode;
}

const DISPATCH: Record<Command, CommandHandler> = {
  'check-path': checkPath,
  classify,
  'commit-slice': commitSliceCmd,
  report,
  'select-worktree': selectWorktreeCmd,
  handoff: handoffCmd,
  verify: verifyCmd,
};

function isCommand(value: string): value is Command {
  return Object.hasOwn(DISPATCH, value);
}

// Builds a §2.4 machine-readable error for an UNCAUGHT io/validation failure
// (untrusted findings file, missing/invalid quality.json). A FindingsValidationError
// carries its rule + JSON path into the message so the cause is legible; `step` is
// omitted (no failing sub-step) and `stderr_tail` is empty (no captured child
// stderr at this layer). Mirrors the slice/report machine-error emission pattern.
function toMachineError(subcommand: string, error: unknown): MachineError {
  if (error instanceof FindingsValidationError) {
    const where = error.path === '' ? '<root>' : error.path;
    return {
      command: `deep-review ${subcommand}`,
      message: `findings validation failed (${error.rule}) at ${where}: ${error.message}`,
      stderr_tail: '',
    };
  }
  return {
    command: `deep-review ${subcommand}`,
    message: error instanceof Error ? error.message : String(error),
    stderr_tail: '',
  };
}

export function runCli(argv: string[], deps: CliDeps): number {
  const subcommand = argv[0];
  if (subcommand === undefined) {
    deps.stderr(USAGE);
    return EXIT_USAGE;
  }
  if (!isCommand(subcommand)) {
    deps.stderr(`deep-review: unknown command "${subcommand}"\n${USAGE}`);
    return EXIT_USAGE;
  }
  // Fail-safe boundary (§2.4): an untrusted findings file or a missing/invalid
  // quality.json must never escape as a raw stack trace. Any throw out of the
  // handler becomes a §2.4 machine error as the LAST stderr line + EXIT_FAILURE.
  try {
    return DISPATCH[subcommand](argv.slice(1), deps);
  } catch (error) {
    deps.stderr(`${JSON.stringify({ error: toMachineError(subcommand, error) })}\n`);
    return EXIT_FAILURE;
  }
}
