import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_ALREADY_DONE,
  EXIT_FAILURE,
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_WRONG_STATE,
} from '../../workflow/src/types.ts';
import type { FrontMatter, WorkflowConfig, WorkflowState } from '../../workflow/src/types.ts';
import {
  awaitAndLaunch,
} from '../../workflow/src/await-and-launch.ts';
import type {
  AwaitLaunchDeps,
  AwaitLaunchNotify,
  AgentLaunch,
} from '../../workflow/src/await-and-launch.ts';

function config(): WorkflowConfig {
  return {
    schema: 1,
    enabled: true,
    base_branch: 'main',
    worktree_parent: '/repo/worktrees',
    cmux_mode: 'manual',
    loopback_mode: 'manual',
    reviewer_independence: 'different-runtime',
    required_review_guides: ['docs/review.md'],
    commit_exclude: ['reports/**'],
    archive: true,
    timeouts: { default_wait_seconds: 60, default_work_seconds: 1800 },
    budget: { workflow_total_seconds: 5400 },
    agents: {
      claude: ['claude', '--model', 'opus'],
      codex: ['codex', 'exec'],
    },
    ship: { ci_wait_seconds: 1800, notify: true },
    notify: { webhook_env: 'WORKFLOW_NOTIFY_WEBHOOK' },
  };
}

function fm(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'dark-mode-toggle',
    branch: 'feature/dark-mode-toggle',
    worktree: '/repo/worktrees/dark-mode-toggle',
    base: 'main',
    base_sha: '0'.repeat(40),
    cmux_section: 'dark-mode-toggle',
    state: 'created',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: '',
    updated: '2026-06-12T00:00:00Z',
    phases: {},
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

function deps(overrides: Partial<AwaitLaunchDeps> = {}): AwaitLaunchDeps {
  return {
    planningFile: '/repo/worktrees/dark-mode-toggle/workflow-session-planning.md',
    config: config(),
    readState: () => fm(),
    checkDivergence: () => false,
    now: () => 0,
    sleep: () => {},
    recordForcedAction: () => {},
    launchAgent: () => ({ status: 0, stdout: '', stderr: '' }),
    runShip: () => ({ status: 0, stdout: 'ship ok', stderr: '' }),
    notify: () => {},
    ...overrides,
  };
}

test('launches-exactly-once-on-gate-open', () => {
  let reads = 0;
  const launches: AgentLaunch[] = [];
  const result = awaitAndLaunch('plan', { wait: true }, deps({
    readState: () => {
      reads += 1;
      const state: WorkflowState = reads < 3 ? 'review-plan-inprogress' : 'created';
      return fm({ state });
    },
    sleep: () => {},
    launchAgent: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
  }));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.launched, true);
  assert.equal(result.message, 'process exited successfully');
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.file, 'claude');
  assert.deepEqual(launches[0]?.args.slice(0, 2), ['--model', 'opus']);
  assert.equal(launches[0]?.cwd, '/repo/worktrees/dark-mode-toggle');
  assert.match(launches[0]?.args.at(-1) ?? '', /workflow phase "plan"/);
  assert.match(launches[0]?.args.at(-1) ?? '', /workflow-session-planning\.md/);
});

test('exits-cleanly-on-already-done-needs-human-timeout', () => {
  const launches: AgentLaunch[] = [];

  const alreadyDone = awaitAndLaunch('plan', { wait: true }, deps({
    readState: () =>
      fm({
        state: 'created',
        phases: {
          plan: {
            last_success_loop: 0,
            attempts: 1,
            start_sha: null,
            complete_sha: null,
          },
        },
      }),
    launchAgent: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
  }));
  assert.equal(alreadyDone.exitCode, EXIT_ALREADY_DONE);

  const needsHuman = awaitAndLaunch('plan', { wait: true }, deps({
    readState: () => fm({ state: 'needs-human', needs_human_reason: 'guide-missing', needs_human_from: 'created' }),
    launchAgent: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
  }));
  assert.equal(needsHuman.exitCode, EXIT_NEEDS_HUMAN);

  const timeout = awaitAndLaunch('review-plan', { wait: true, waitSeconds: 0 }, deps({
    readState: () => fm({ state: 'created' }),
    launchAgent: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
  }));
  assert.equal(timeout.exitCode, EXIT_TIMEOUT);
  assert.equal(launches.length, 0, 'terminal, already-done, and timeout outcomes do not launch agents');
});

test('never-launches-on-wrong-state', () => {
  const launches: AgentLaunch[] = [];
  const result = awaitAndLaunch('review-plan', { wait: false }, deps({
    readState: () => fm({ state: 'created' }),
    launchAgent: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
  }));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(result.launched, false);
  assert.equal(launches.length, 0);
});

test('ship-phase-runs-in-process-no-agent-argv', () => {
  const launches: AgentLaunch[] = [];
  let ships = 0;

  const result = awaitAndLaunch('ship-feature', { wait: true }, deps({
    readState: () => fm({ state: 'implementation-reviewed' }),
    launchAgent: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
    runShip: () => {
      ships += 1;
      return { status: 0, stdout: 'ship ok', stderr: '' };
    },
  }));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.launched, true);
  assert.equal(ships, 1);
  assert.equal(launches.length, 0, 'ship-feature never launches an agent argv');
});

test('seat-resolved-from-config-agents-map', () => {
  const launches: AgentLaunch[] = [];

  const result = awaitAndLaunch('review-plan', { wait: true }, deps({
    readState: () => fm({ state: 'plan-ready' }),
    launchAgent: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
  }));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(launches[0]?.file, 'codex');
  assert.deepEqual(launches[0]?.args.slice(0, 1), ['exec']);
});

test('notify-fired-on-transitions-timeouts-needs-human', () => {
  const notices: AwaitLaunchNotify[] = [];

  awaitAndLaunch('plan', { wait: true }, deps({
    readState: () => fm({ state: 'created' }),
    notify: (notice) => notices.push(notice),
  }));
  awaitAndLaunch('review-plan', { wait: true, waitSeconds: 0 }, deps({
    readState: () => fm({ state: 'created' }),
    notify: (notice) => notices.push(notice),
  }));
  awaitAndLaunch('plan', { wait: true }, deps({
    readState: () => fm({ state: 'needs-human', needs_human_reason: 'guide-missing', needs_human_from: 'created' }),
    notify: (notice) => notices.push(notice),
  }));
  awaitAndLaunch('plan', { wait: true }, deps({
    checkDivergence: () => true,
    notify: (notice) => notices.push(notice),
  }));
  awaitAndLaunch('review-plan', { wait: false }, deps({
    readState: () => fm({ state: 'created' }),
    notify: (notice) => notices.push(notice),
  }));

  assert.deepEqual(
    notices.map((notice) => notice.outcome),
    ['proceed', 'timeout', 'needs-human', 'divergence', 'wrong-state'],
  );
});

test('launch-failure-and-empty-agent-argv-return-failure-without-marking-launched', () => {
  const failed = awaitAndLaunch('plan', { wait: true }, deps({
    launchAgent: () => ({ status: 42, stdout: '', stderr: 'agent refused' }),
  }));

  assert.equal(failed.exitCode, EXIT_FAILURE);
  assert.equal(failed.launched, false);
  assert.match(failed.message, /agent refused/);

  const emptyArgv = awaitAndLaunch('plan', { wait: true }, deps({
    config: {
      ...config(),
      agents: { claude: [], codex: ['codex'] },
    },
  }));

  assert.equal(emptyArgv.exitCode, EXIT_FAILURE);
  assert.equal(emptyArgv.launched, false);
  assert.match(emptyArgv.message, /no configured agent argv/);
});

test('ship-phase-propagates-runShip-failure', () => {
  const result = awaitAndLaunch('ship-feature', { wait: true }, deps({
    readState: () => fm({ state: 'implementation-reviewed' }),
    runShip: () => ({ status: 1, stdout: '', stderr: 'ci failed' }),
  }));

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.launched, true);
  assert.match(result.message, /ci failed/);
});
