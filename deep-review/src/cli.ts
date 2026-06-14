// The deep-review CLI dispatch. `runCli` parses argv into a subcommand and routes
// it through a dispatch table with one entry per command. Every command is a STUB
// in E0 (returns EXIT_USAGE) — the later tasks (no-touch matcher, classifier,
// slice engine, report writer, worktree/handoff/verify) replace the stub bodies.
// An unknown or missing subcommand prints usage to stderr and returns EXIT_USAGE.
// Logic stays behind the injected `deps` seam (process streams) so it is testable
// without touching the real process, mirroring the workflow CLI edge style.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT_OK, EXIT_USAGE } from './types.ts';
import { loadConfig } from './config.ts';
import { buildNoTouchSet, isNoTouch } from './no-touch.ts';
import { readFindings, writeFindings } from './findings-io.ts';
import { classifyAll } from './classify.ts';

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

// Placeholder handler: the command is recognized but its task has not landed yet.
function notImplemented(command: Command): CommandHandler {
  return (_rest, deps) => {
    deps.stderr(`deep-review: "${command}" is not implemented yet\n`);
    return EXIT_USAGE;
  };
}

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

const DISPATCH: Record<Command, CommandHandler> = {
  'check-path': checkPath,
  classify,
  'commit-slice': notImplemented('commit-slice'),
  report: notImplemented('report'),
  'select-worktree': notImplemented('select-worktree'),
  handoff: notImplemented('handoff'),
  verify: notImplemented('verify'),
};

function isCommand(value: string): value is Command {
  return Object.hasOwn(DISPATCH, value);
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
  return DISPATCH[subcommand](argv.slice(1), deps);
}
