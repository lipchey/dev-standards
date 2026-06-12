import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCmuxAdapter,
  REQUIRED_CMUX_VERBS,
} from '../../workflow/src/cmux-adapter.ts';
import type {
  CmuxSectionSpec,
  CmuxSpawn,
  CmuxSpawnOptions,
  CmuxSpawnResult,
} from '../../workflow/src/cmux-adapter.ts';

interface Call {
  file: string;
  args: string[];
  options: CmuxSpawnOptions;
}

function sectionSpec(overrides: Partial<CmuxSectionSpec> = {}): CmuxSectionSpec {
  return {
    section: 'dark-mode-toggle',
    worktree: '/repo/worktrees/dark-mode-toggle',
    panes: [
      {
        pane_id: 'plan',
        cwd: '/repo/worktrees/dark-mode-toggle',
        agent: 'claude',
        command: [
          'workflow',
          'await-and-launch',
          'plan',
          '--file',
          '/repo/worktrees/dark-mode-toggle/workflow-session-planning.md',
        ],
      },
      {
        pane_id: 'review-plan',
        cwd: '/repo/worktrees/dark-mode-toggle',
        agent: 'codex',
        command: [
          'workflow',
          'await-and-launch',
          'review-plan',
          '--file',
          '/repo/worktrees/dark-mode-toggle/workflow-session-planning.md',
        ],
      },
    ],
    ...overrides,
  };
}

function spawnWithCapabilities(
  verbs: readonly string[] = REQUIRED_CMUX_VERBS,
  onCommand: (args: string[]) => CmuxSpawnResult = () => ({ status: 0, stdout: '', stderr: '' }),
): { spawn: CmuxSpawn; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: CmuxSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === 'capabilities') {
      return {
        status: 0,
        stdout: JSON.stringify({ version: '1.2.3', verbs }),
        stderr: '',
      };
    }
    return onCommand(args);
  };
  return { spawn, calls };
}

test('probes-once-on-construction', () => {
  const { spawn, calls } = spawnWithCapabilities();
  const adapter = createCmuxAdapter({ spawn });

  assert.equal(calls.length, 1, 'construction probes cmux exactly once');
  assert.deepEqual(calls[0]?.args, ['capabilities', '--json']);
  assert.equal(adapter.capabilities().present, true);
  assert.equal(adapter.capabilities().version, '1.2.3');
  assert.equal(calls.length, 1, 'capabilities are cached after construction');
});

test('missing-verb-means-no-commands-and-instructions', () => {
  for (const missing of REQUIRED_CMUX_VERBS) {
    const verbs = REQUIRED_CMUX_VERBS.filter((verb) => verb !== missing);
    const { spawn, calls } = spawnWithCapabilities(verbs);
    const adapter = createCmuxAdapter({ spawn });

    const planned = adapter.plan(sectionSpec());
    assert.equal(planned.ready, false, `plan refuses when ${missing} is absent`);
    assert.match(planned.instructions, new RegExp(missing));
    assert.match(planned.instructions, /copy-paste/i);

    const launched = adapter.launch(sectionSpec());
    assert.equal(launched.ok, false, `launch refuses when ${missing} is absent`);
    assert.match(launched.instructions, /copy-paste/i);
    assert.equal(calls.length, 1, 'no cmux command is issued after the failed probe');
  }
});

test('plan-dry-run-zero-side-effects', () => {
  const { spawn, calls } = spawnWithCapabilities();
  const adapter = createCmuxAdapter({ spawn });

  const planned = adapter.plan(sectionSpec());

  assert.equal(planned.ready, true);
  assert.deepEqual(
    planned.actions.map((action) => action.verb),
    ['new_section', 'split_run', 'split_run', 'notify'],
  );
  assert.equal(calls.length, 1, 'plan() performs no cmux side effects after the probe');
});

test('pane-spec-cwd-asserted-against-front-matter', () => {
  const { spawn } = spawnWithCapabilities();
  const adapter = createCmuxAdapter({ spawn });

  assert.throws(
    () =>
      adapter.plan(
        sectionSpec({
          panes: [
            {
              pane_id: 'plan',
              cwd: '/repo/other-worktree',
              agent: 'claude',
              command: ['workflow', 'await-and-launch', 'plan'],
            },
          ],
        }),
      ),
    /pane "plan".*cwd.*worktree/,
  );
});

test('launch-failure-degrades-never-half-armed', () => {
  let splitRuns = 0;
  const { spawn, calls } = spawnWithCapabilities(REQUIRED_CMUX_VERBS, (args) => {
    if (args[0] === 'split_run') {
      splitRuns += 1;
      if (splitRuns === 2) return { status: 1, stdout: '', stderr: 'pane refused' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const adapter = createCmuxAdapter({ spawn });

  const launched = adapter.launch(sectionSpec());

  assert.equal(launched.ok, false);
  assert.match(launched.error ?? '', /pane refused/);
  assert.ok(
    calls.some((call) => call.args[0] === 'close_section' && call.args[1] === 'dark-mode-toggle'),
    'a partially-created section is closed before degrading',
  );
});

test('fixed-argv-no-shell-no-join', () => {
  const { spawn, calls } = spawnWithCapabilities();
  const adapter = createCmuxAdapter({ spawn });

  const launched = adapter.launch(sectionSpec());

  assert.equal(launched.ok, true);
  for (const call of calls) {
    assert.equal(call.file, 'cmux');
    assert.equal(call.options.shell, false);
    assert.ok(Array.isArray(call.args), 'argv remains an array');
  }
  const split = calls.find((call) => call.args[0] === 'split_run');
  assert.ok(split !== undefined, 'a split_run command is issued');
  const sep = split.args.indexOf('--');
  assert.notEqual(sep, -1, 'pane command is passed after --');
  assert.deepEqual(split.args.slice(sep + 1, sep + 4), ['workflow', 'await-and-launch', 'plan']);
});

test('notify-fixed-argv-and-degrades-when-unavailable', () => {
  const { spawn, calls } = spawnWithCapabilities();
  const adapter = createCmuxAdapter({ spawn });

  const notified = adapter.notify('dark-mode-toggle', 'plan gate opened');

  assert.equal(notified.ok, true);
  assert.deepEqual(calls.at(-1)?.args, ['notify', 'dark-mode-toggle', 'plan gate opened']);
  assert.equal(calls.at(-1)?.options.shell, false);

  const missing = spawnWithCapabilities(REQUIRED_CMUX_VERBS.filter((verb) => verb !== 'notify'));
  const unavailable = createCmuxAdapter({ spawn: missing.spawn });
  const degraded = unavailable.notify('dark-mode-toggle', 'plan gate opened');

  assert.equal(degraded.ok, false);
  assert.equal(missing.calls.length, 1, 'missing notify verb means no notify command is issued');
});
