import {
  EXIT_FAILURE,
  EXIT_OK,
} from './types.ts';
import type { ForcedAction, WorkflowConfig, WorkflowPhase } from './types.ts';
import { gate } from './gate.ts';
import type { GateOptions, GateOutcome, GateResult } from './gate.ts';
import { SEAT_MAP } from './transitions.ts';

export interface AgentLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ProcessResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface AwaitLaunchNotify {
  phase: WorkflowPhase;
  outcome: GateOutcome;
  message: string;
}

export interface AwaitLaunchDeps {
  planningFile: string;
  config: WorkflowConfig;
  readState: Parameters<typeof gate>[2]['readState'];
  checkDivergence: Parameters<typeof gate>[2]['checkDivergence'];
  now: () => number;
  sleep: (ms: number) => void;
  recordForcedAction: (action: ForcedAction) => void;
  launchAgent: (launch: AgentLaunch) => ProcessResult;
  runShip: () => ProcessResult;
  notify?: (notice: AwaitLaunchNotify) => void;
}

export interface AwaitLaunchOptions {
  wait?: boolean;
  waitSeconds?: number;
  pollMs?: number;
}

export interface AwaitLaunchResult {
  exitCode: number;
  outcome: GateOutcome;
  phase: WorkflowPhase;
  launched: boolean;
  message: string;
}

export function awaitAndLaunch(
  phase: WorkflowPhase,
  opts: AwaitLaunchOptions,
  deps: AwaitLaunchDeps,
): AwaitLaunchResult {
  const gateOptions: GateOptions = {
    wait: opts.wait ?? true,
    waitSeconds: opts.waitSeconds ?? deps.config.timeouts.default_wait_seconds,
  };
  if (opts.pollMs !== undefined) gateOptions.pollMs = opts.pollMs;
  const result = gate(
    phase,
    gateOptions,
    {
      readState: deps.readState,
      checkDivergence: deps.checkDivergence,
      now: deps.now,
      sleep: deps.sleep,
      recordForcedAction: deps.recordForcedAction,
    },
  );

  if (result.outcome !== 'proceed') {
    notifyIfUseful(result, deps);
    return {
      exitCode: result.exitCode,
      outcome: result.outcome,
      phase,
      launched: false,
      message: result.message ?? result.outcome,
    };
  }

  deps.notify?.({
    phase,
    outcome: 'proceed',
    message: `launching ${phase}`,
  });

  if (phase === 'ship-feature') {
    const shipped = deps.runShip();
    return {
      exitCode: shipped.status,
      outcome: result.outcome,
      phase,
      launched: true,
      message: processMessage(shipped),
    };
  }

  const fm = deps.readState();
  const argv = agentArgv(phase, deps.config);
  if (argv.length === 0) {
    return {
      exitCode: EXIT_FAILURE,
      outcome: result.outcome,
      phase,
      launched: false,
      message: `no configured agent argv for ${phase}`,
    };
  }

  const [file, ...baseArgs] = argv as [string, ...string[]];
  const launched = deps.launchAgent({
    file,
    args: [...baseArgs, phasePrompt(phase, deps.planningFile)],
    cwd: fm.worktree,
    env: { WORKFLOW_CLAIMED_BY: `await-and-launch:${phase}` },
  });

  return {
    exitCode: launched.status === 0 ? EXIT_OK : EXIT_FAILURE,
    outcome: result.outcome,
    phase,
    launched: launched.status === 0,
    message: processMessage(launched),
  };
}

function agentArgv(phase: WorkflowPhase, config: WorkflowConfig): string[] {
  const seat = SEAT_MAP[phase];
  if (seat === 'Claude') return config.agents.claude;
  if (seat === 'Codex') return config.agents.codex;
  return [];
}

function phasePrompt(phase: WorkflowPhase, planningFile: string): string {
  return [
    `Run workflow phase "${phase}" for ${planningFile}.`,
    'Load the repo workflow instructions for this phase.',
    `When the phase work is complete, call \`workflow complete ${phase} --file ${planningFile}\` unless the phase instructions require a different workflow verb.`,
  ].join('\n');
}

function notifyIfUseful(result: GateResult, deps: AwaitLaunchDeps): void {
  if (
    result.outcome !== 'timeout'
    && result.outcome !== 'needs-human'
    && result.outcome !== 'divergence'
    && result.outcome !== 'wrong-state'
  ) return;
  deps.notify?.({
    phase: result.phase,
    outcome: result.outcome,
    message: result.message ?? result.outcome,
  });
}

function processMessage(result: ProcessResult): string {
  return result.stderr.trim()
    || result.stdout.trim()
    || (result.status === 0 ? 'process exited successfully' : `process exited ${result.status}`);
}
