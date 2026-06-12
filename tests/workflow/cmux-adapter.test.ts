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
  assert.equal(typeof calls[0]?.options.timeout, 'number');
  assert.equal(adapter.capabilities().present, true);
  assert.equal(adapter.capabilities().version, '1.2.3');
  assert.equal(calls.length, 1, 'capabilities are cached after construction');
});

test('spawn-timeout-applies-to-probe-launch-rollback-and-notify', () => {
  let splitRuns = 0;
  const { spawn, calls } = spawnWithCapabilities(REQUIRED_CMUX_VERBS, (args) => {
    if (args[0] === 'split_run') {
      splitRuns += 1;
      if (splitRuns === 2) return { status: 1, stdout: '', stderr: 'pane refused' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const adapter = createCmuxAdapter({ spawn, timeoutMs: 123 });

  adapter.launch(sectionSpec());
  adapter.notify('dark-mode-toggle', 'plan gate opened');

  assert.ok(calls.length > 1);
  assert.deepEqual(
    calls.map((call) => call.options.timeout),
    Array.from({ length: calls.length }, () => 123),
  );
  assert.ok(calls.some((call) => call.args[0] === 'close_section'), 'rollback also uses the bounded spawn options');
});

test('probe-failures-degrade-to-manual-plan', () => {
  const enoentCalls: Call[] = [];
  const missing = createCmuxAdapter({
    spawn: (file, args, options) => {
      enoentCalls.push({ file, args, options });
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn cmux ENOENT'), { code: 'ENOENT' }) };
    },
  });
  assert.equal(missing.capabilities().present, false);
  assert.match(missing.capabilities().detail, /not found/i);
  assert.equal(missing.plan(sectionSpec()).ready, false);
  assert.equal(enoentCalls.length, 1, 'manual degradation performs only the failed probe');

  const nonZero = createCmuxAdapter({
    spawn: () => ({ status: 2, stdout: '', stderr: 'usage broke' }),
  });
  assert.equal(nonZero.capabilities().present, false);
  assert.match(nonZero.capabilities().detail, /usage broke/);

  const invalidJson = createCmuxAdapter({
    spawn: () => ({ status: 0, stdout: '{', stderr: '' }),
  });
  assert.equal(invalidJson.capabilities().present, false);
  assert.match(invalidJson.capabilities().detail, /JSON/i);
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

test('option-like-cmux-positionals-are-rejected-before-spawn', () => {
  const { spawn, calls } = spawnWithCapabilities();
  const adapter = createCmuxAdapter({ spawn });

  assert.throws(
    () => adapter.plan(sectionSpec({ section: '--help' })),
    /unsafe cmux section/,
  );
  assert.throws(
    () =>
      adapter.plan(
        sectionSpec({
          panes: [
            {
              pane_id: '-pane',
              cwd: '/repo/worktrees/dark-mode-toggle',
              agent: 'claude',
              command: ['workflow', 'await-and-launch', 'plan'],
            },
          ],
        }),
      ),
    /unsafe cmux pane_id/,
  );
  assert.equal(calls.length, 1, 'unsafe positionals are rejected after the probe and before any action spawn');
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

test('new-section-failure-does-not-trigger-rollback', () => {
  const { spawn, calls } = spawnWithCapabilities(REQUIRED_CMUX_VERBS, (args) => {
    if (args[0] === 'new_section') return { status: 1, stdout: '', stderr: 'section refused' };
    return { status: 0, stdout: '', stderr: '' };
  });
  const adapter = createCmuxAdapter({ spawn });

  const launched = adapter.launch(sectionSpec());

  assert.equal(launched.ok, false);
  assert.match(launched.error ?? '', /section refused/);
  assert.equal(calls.some((call) => call.args[0] === 'close_section'), false);
});

test('rollback-failure-is-reported-alongside-original-launch-failure', () => {
  let splitRuns = 0;
  const { spawn } = spawnWithCapabilities(REQUIRED_CMUX_VERBS, (args) => {
    if (args[0] === 'split_run') {
      splitRuns += 1;
      if (splitRuns === 2) return { status: 1, stdout: '', stderr: 'pane refused' };
    }
    if (args[0] === 'close_section') return { status: 1, stdout: '', stderr: 'cleanup refused' };
    return { status: 0, stdout: '', stderr: '' };
  });
  const adapter = createCmuxAdapter({ spawn });

  const launched = adapter.launch(sectionSpec());

  assert.equal(launched.ok, false);
  assert.match(launched.error ?? '', /pane refused/);
  assert.match(launched.error ?? '', /cleanup refused/);
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

test('notify-rejects-option-like-positionals-before-spawn', () => {
  const { spawn, calls } = spawnWithCapabilities();
  const adapter = createCmuxAdapter({ spawn });

  const badSection = adapter.notify('--help', 'plan gate opened');
  const badMessage = adapter.notify('dark-mode-toggle', '--flag-like message');

  assert.equal(badSection.ok, false);
  assert.match(badSection.error ?? '', /unsafe cmux section/);
  assert.equal(badMessage.ok, false);
  assert.match(badMessage.error ?? '', /unsafe cmux message/);
  assert.equal(calls.length, 1, 'unsafe notify values are rejected after the probe and before notify spawn');
});

test('notify-runtime-throw-degrades-to-error-result', () => {
  const adapter = createCmuxAdapter({
    spawn: (_file, args) => {
      if (args[0] === 'capabilities') {
        return {
          status: 0,
          stdout: JSON.stringify({ version: '1.2.3', verbs: REQUIRED_CMUX_VERBS }),
          stderr: '',
        };
      }
      throw new Error('notify transport crashed');
    },
  });

  const result = adapter.notify('dark-mode-toggle', 'plan gate opened');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /notify transport crashed/);
});
