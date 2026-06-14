// The deep-review CLI dispatch. `runCli` parses argv into a subcommand and routes
// it through a dispatch table with one entry per command. Every command is a STUB
// in E0 (returns EXIT_USAGE) — the later tasks (no-touch matcher, classifier,
// slice engine, report writer, worktree/handoff/verify) replace the stub bodies.
// An unknown or missing subcommand prints usage to stderr and returns EXIT_USAGE.
// Logic stays behind the injected `deps` seam (process streams) so it is testable
// without touching the real process, mirroring the workflow CLI edge style.

import { EXIT_USAGE } from './types.ts';

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
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

const DISPATCH: Record<Command, CommandHandler> = {
  'check-path': notImplemented('check-path'),
  classify: notImplemented('classify'),
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
