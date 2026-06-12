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
import type { FrontMatter } from './types.ts';
import { CorruptStateError, parseFrontMatter } from './front-matter.ts';

// The planning file lives at the worktree root (spec §3). `status` reads it from
// the current working directory by default; `--file <path>` overrides for tests
// and non-conventional layouts.
const PLANNING_FILE_NAME = 'workflow-session-planning.md';

// Commands the S10 skeleton actually implements. Kept as data so the usage text
// and the dispatch stay in sync as later phases add rows.
const IMPLEMENTED_COMMANDS = ['status'] as const;

const USAGE = [
  'usage: workflow <command> [options]',
  '',
  'commands:',
  '  status [--file <path>]   print the planning file state and per-phase summary',
  '',
].join('\n');

// The injected IO edge. Everything side-effecting lives behind these so the
// dispatch logic is pure and testable.
export interface CliIO {
  cwd: () => string;
  readFile: (filePath: string) => string; // throws on a missing/unreadable file
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`workflow: ${message}\n${USAGE}`);
  return EXIT_USAGE;
}

export function runCli(argv: string[], io: CliIO): number {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return usageError(io, 'missing command');
  }
  switch (command) {
    case 'status':
      return runStatus(rest, io);
    default:
      return usageError(io, `unknown command "${command}"`);
  }
}

// `status` parses its own flags so an unknown flag / missing value is a usage
// error (exit 2) distinct from a runtime read failure.
function runStatus(args: string[], io: CliIO): number {
  let filePath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--file') {
      const value = args[i + 1];
      if (value === undefined) {
        return usageError(io, 'status: missing value for --file <path>');
      }
      if (filePath !== undefined) {
        return usageError(io, 'status: --file may be given only once');
      }
      filePath = value;
      i += 1;
      continue;
    }
    return usageError(io, `status: unexpected argument "${arg}"`);
  }

  const resolved = filePath ?? path.join(io.cwd(), PLANNING_FILE_NAME);

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

export { IMPLEMENTED_COMMANDS, PLANNING_FILE_NAME };
