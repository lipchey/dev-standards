import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_FAILURE,
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_USAGE,
} from '../../workflow/src/types.ts';
import type { FrontMatter } from '../../workflow/src/types.ts';
import { serializeFrontMatter } from '../../workflow/src/front-matter.ts';
import { runCli } from '../../workflow/src/cli.ts';
import type { CliIO } from '../../workflow/src/cli.ts';
import type { CmuxAdapter, CmuxSectionSpec } from '../../workflow/src/cmux-adapter.ts';

// A complete, schema-valid FrontMatter; tests override only what the case is
// about. Serialized through the real serializer so the fixture is, by
// construction, a parseable planning file (no hand-rolled YAML to drift).
function makeFrontMatter(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'dark-mode-toggle',
    branch: 'feature/dark-mode-toggle',
    worktree: '../app-dark-mode-toggle',
    base: 'main',
    base_sha: '9c1f2a',
    cmux_section: 'dark-mode-toggle',
    state: 'plan-inprogress',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: 'pane-2:claude',
    updated: '2026-06-10T12:00:00Z',
    phases: {
      plan: { last_success_loop: null, attempts: 1, start_sha: '9c1f2a', complete_sha: null },
    },
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

function workflowConfigFixture(): Record<string, unknown> {
  return {
    schema: 1,
    enabled: true,
    base_branch: 'main',
    worktree_parent: '/tmp/worktrees',
    cmux_mode: 'manual',
    loopback_mode: 'manual',
    reviewer_independence: 'different-runtime',
    required_review_guides: [],
    commit_exclude: [],
    archive: true,
    timeouts: { default_wait_seconds: 60, default_work_seconds: 1800 },
    budget: { workflow_total_seconds: 5400 },
    agents: { claude: ['claude'], codex: ['codex'] },
    ship: { ci_wait_seconds: 1800, notify: true },
    notify: { webhook_env: 'WORKFLOW_NOTIFY_WEBHOOK' },
  };
}

interface Captured {
  io: CliIO;
  out: () => string;
  err: () => string;
}

// Fully injected IO seam: no real fs, no real streams, no process.exit. The CLI
// returns a numeric exit code; the runner edge maps it to process.exit.
function makeIO(overrides: Partial<CliIO> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    cwd: () => '/tmp/worktree',
    readFile: () => serializeFrontMatter(makeFrontMatter()),
    writeFile: () => {},
    runGit: () => '',
    stdout: (t) => {
      out.push(t);
    },
    stderr: (t) => {
      err.push(t);
    },
    ...overrides,
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

test('usage-error-exit-2', () => {
  // (a) No command at all is a malformed invocation -> exit 2 + usage.
  const noCmd = makeIO();
  assert.equal(runCli([], noCmd.io), EXIT_USAGE);
  assert.match(noCmd.err(), /usage/i);

  // (b) A missing required arg (status --file with no value) -> exit 2 + usage.
  const badArg = makeIO();
  assert.equal(runCli(['status', '--file'], badArg.io), EXIT_USAGE);
  assert.match(badArg.err(), /usage/i);
});

test('status-prints-state-and-phases', () => {
  const fm = makeFrontMatter({ state: 'plan-inprogress' });
  // A real planning file carries a markdown body after the front matter; status
  // must extract the leading fenced block before parsing.
  const fileText = `${serializeFrontMatter(fm)}\n# Plan\n\nthe plan body lives here\n`;
  const cap = makeIO({ readFile: () => fileText });

  const code = runCli(['status'], cap.io);

  assert.equal(code, EXIT_OK);
  const out = cap.out();
  assert.match(out, /state:\s+plan-inprogress/, 'prints the current state');
  assert.match(out, /\bplan:/, 'prints the per-phase summary line');
  assert.match(out, /attempts=1/, 'phase summary includes phase fields');
});

test('status-body-horizontal-rule-not-mistaken-for-fence', () => {
  // A real planning body can contain a bare `---` markdown horizontal rule.
  // extractFrontMatter must end the front matter at the FIRST closing fence, so
  // the body's later `---` is ignored and status still parses + exits 0.
  const fm = makeFrontMatter({ state: 'plan-inprogress' });
  const fileText = `${serializeFrontMatter(fm)}\n# Plan\n\nsection one\n\n---\n\nsection two\n`;
  const cap = makeIO({ readFile: () => fileText });

  const code = runCli(['status'], cap.io);

  assert.equal(code, EXIT_OK);
  assert.match(cap.out(), /state:\s+plan-inprogress/, 'parses the leading front matter');
});

test('corrupt-planning-file-exits-needs-human', () => {
  // A fenced-but-corrupt planning file is a `corrupt-state` needs_human_reason
  // (§2.1): not an infra failure (exit 1) but EXIT_NEEDS_HUMAN (13), resolved
  // only by `workflow recover`.
  const corruptText = '---\nstate: not-a-real-state\n---\n';
  const cap = makeIO({ readFile: () => corruptText });

  const code = runCli(['status'], cap.io);

  assert.equal(code, EXIT_NEEDS_HUMAN);
  assert.match(cap.err(), /corrupt/i, 'names the corruption');
  assert.match(cap.err(), /recover/i, 'points to workflow recover');
});

test('diff-range-corrupt-planning-file-exits-needs-human', () => {
  const corruptText = '---\nstate: not-a-real-state\n---\n';
  const cap = makeIO({ readFile: () => corruptText });

  const code = runCli(['diff-range', 'review-implementation'], cap.io);

  assert.equal(code, EXIT_NEEDS_HUMAN);
  assert.match(cap.err(), /corrupt/i, 'names the corruption');
  assert.match(cap.err(), /recover/i, 'points to workflow recover');
});

test('missing-planning-file-exits-failure', () => {
  // A missing/unreadable file is a runtime failure (exit 1), distinct from a
  // usage error (exit 2) and from corrupt state (exit 13): the invocation was
  // well-formed but the read seam threw.
  const cap = makeIO({
    readFile: () => {
      throw new Error('ENOENT: no such file or directory');
    },
  });

  const code = runCli(['status'], cap.io);

  assert.equal(code, EXIT_FAILURE);
  assert.match(cap.err(), /cannot read planning file/i, 'names the read failure');
});

test('request-changes-invalid-reason-is-usage-error', () => {
  // §2.7: an invalid `--reason` ARGUMENT is a USAGE error (exit 2), NOT corrupt
  // durable state. It must name the `--reason` argument, must NOT call the
  // planning file "corrupt", and must NOT point at `workflow recover` (which
  // cannot fix an argv mistake). Without the CLI guard, validateReason throws a
  // corrupt-state error that the mutation map would mis-report as EXIT_NEEDS_HUMAN
  // (13) — falsely telling a calling session "stop, a human must repair state".

  // (a) Over the 200-char cap.
  const tooLong = makeIO();
  const longReason = 'a'.repeat(201);
  const codeLong = runCli(
    ['request-changes', 'implement-plan', '--reason', longReason],
    tooLong.io,
  );
  assert.equal(codeLong, EXIT_USAGE, 'over-cap --reason is a usage error (exit 2)');
  assert.match(tooLong.err(), /--reason/, 'names the --reason argument');
  assert.match(tooLong.err(), /201/, 'reports the offending length');
  assert.doesNotMatch(tooLong.err(), /corrupt/i, 'does NOT call the planning file corrupt');
  assert.doesNotMatch(tooLong.err(), /recover/i, 'does NOT point at workflow recover');

  // (b) Non-ASCII (and, by the same rule, control chars) in the reason.
  const nonAscii = makeIO();
  const codeNon = runCli(
    ['request-changes', 'implement-plan', '--reason', 'café'],
    nonAscii.io,
  );
  assert.equal(codeNon, EXIT_USAGE, 'non-ASCII --reason is a usage error (exit 2)');
  assert.match(nonAscii.err(), /--reason/, 'names the --reason argument');
  assert.doesNotMatch(nonAscii.err(), /corrupt/i, 'does NOT call the planning file corrupt');
  assert.doesNotMatch(nonAscii.err(), /recover/i, 'does NOT point at workflow recover');
});

test('request-changes-valid-reason-passes-the-usage-guard', () => {
  // The happy path is unaffected: a VALID `--reason` is NOT rejected by the new
  // operand guard — it passes through into the transaction. (The full end-to-end
  // loopback against real git is covered in transactions.test.ts; here we assert
  // the CLI guard does not turn a valid reason into a usage error.)
  const cap = makeIO();
  const code = runCli(
    ['request-changes', 'implement-plan', '--reason', 'rework the edge case'],
    cap.io,
  );
  assert.notEqual(code, EXIT_USAGE, 'a valid --reason is not a usage error');
  assert.doesNotMatch(cap.err(), /invalid --reason/i, 'the valid reason clears the operand guard');
});

test('unknown-command-usage', () => {
  const cap = makeIO();
  const code = runCli(['frobnicate'], cap.io);
  assert.equal(code, EXIT_USAGE);
  assert.match(cap.err(), /unknown command/i, 'names the failure');
  assert.match(cap.err(), /frobnicate/, 'echoes the offending command');
  assert.match(cap.err(), /usage/i, 'prints usage');
});

test('new-feature-invalid-slug-is-usage-error', () => {
  const cap = makeIO();

  const code = runCli(['new-feature', '../../etc'], cap.io);

  assert.equal(code, EXIT_USAGE);
  assert.match(cap.err(), /invalid.*slug/i);
});

test('feature-start-invalid-slug-is-usage-error', () => {
  const cap = makeIO();

  const code = runCli(['feature-start', '../../etc'], cap.io);

  assert.equal(code, EXIT_USAGE);
  assert.match(cap.err(), /invalid.*slug/i);
});

test('await-and-launch-dispatches-agent-from-config', () => {
  const workflow = {
    ...workflowConfigFixture(),
    agents: { claude: ['claude', '--model', 'opus'], codex: ['codex', 'exec'] },
  };
  const launches: Array<{ file: string; args: string[]; cwd: string }> = [];
  const notifications: Array<{ section: string; message: string }> = [];
  const cmuxAdapter: CmuxAdapter = {
    capabilities: () => ({ present: true, version: '1.2.3', verbs: [], missing: [], detail: 'ok' }),
    plan: () => assert.fail('await-and-launch should not plan panes'),
    launch: () => assert.fail('await-and-launch should not arm panes'),
    notify: (section, message) => {
      notifications.push({ section, message });
      return { ok: true };
    },
  };
  const planningFile = `${serializeFrontMatter(makeFrontMatter({
    cmux_section: 'dark-mode-toggle',
    state: 'created',
    worktree: '/tmp/worktree',
  }))}\n# Plan\n`;
  const cap = makeIO({
    readFile: (filePath) => filePath.endsWith('quality.json')
      ? JSON.stringify({ workflow })
      : planningFile,
    now: () => 0,
    sleep: () => {},
    launchProcess: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
    cmuxAdapter,
  });

  const code = runCli(['await-and-launch', 'plan'], cap.io);

  assert.equal(code, EXIT_OK);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.file, 'claude');
  assert.deepEqual(launches[0]?.args.slice(0, 2), ['--model', 'opus']);
  assert.match(launches[0]?.args.at(-1) ?? '', /workflow phase "plan"/);
  assert.equal(launches[0]?.cwd, '/tmp/worktree');
  assert.deepEqual(notifications, [{ section: 'dark-mode-toggle', message: 'launching plan' }]);
});

test('await-and-launch-notify-failure-does-not-block-launch', () => {
  const workflow = workflowConfigFixture();
  const launches: Array<{ file: string; args: string[]; cwd: string }> = [];
  const cmuxAdapter: CmuxAdapter = {
    capabilities: () => ({ present: true, version: '1.2.3', verbs: [], missing: [], detail: 'ok' }),
    plan: () => assert.fail('await-and-launch should not plan panes'),
    launch: () => assert.fail('await-and-launch should not arm panes'),
    notify: () => ({ ok: false, error: 'notify refused' }),
  };
  const planningFile = `${serializeFrontMatter(makeFrontMatter({
    state: 'created',
    worktree: '/tmp/worktree',
  }))}\n# Plan\n`;
  const cap = makeIO({
    readFile: (filePath) => filePath.endsWith('quality.json')
      ? JSON.stringify({ workflow })
      : planningFile,
    now: () => 0,
    sleep: () => {},
    runGit: () => '',
    launchProcess: (launch) => {
      launches.push(launch);
      return { status: 0, stdout: '', stderr: '' };
    },
    cmuxAdapter,
  });

  const code = runCli(['await-and-launch', 'plan'], cap.io);

  assert.equal(code, EXIT_OK);
  assert.equal(launches.length, 1);
  assert.match(cap.err(), /cmux notify skipped: notify refused/);
});

test('await-and-launch-corrupt-planning-file-exits-needs-human', () => {
  const workflow = workflowConfigFixture();
  const cap = makeIO({
    readFile: (filePath) => filePath.endsWith('quality.json')
      ? JSON.stringify({ workflow })
      : '---\nstate: not-a-real-state\n---\n',
    now: () => 0,
    sleep: () => {},
    launchProcess: () => ({ status: 0, stdout: '', stderr: '' }),
  });

  const code = runCli(['await-and-launch', 'plan'], cap.io);

  assert.equal(code, EXIT_NEEDS_HUMAN);
  assert.match(cap.err(), /corrupt/i);
  assert.match(cap.err(), /recover/i);
});

test('await-and-launch-git-failure-is-machine-readable-failure', () => {
  const workflow = workflowConfigFixture();
  const planningFile = `${serializeFrontMatter(makeFrontMatter({
    state: 'created',
    worktree: '/tmp/worktree',
  }))}\n# Plan\n`;
  const cap = makeIO({
    readFile: (filePath) => filePath.endsWith('quality.json')
      ? JSON.stringify({ workflow })
      : planningFile,
    now: () => 0,
    sleep: () => {},
    runGit: () => {
      throw {
        kind: 'git-error',
        command: 'git log -1',
        step: 'divergence-check',
        message: 'git log failed',
        stderr_tail: 'fatal: bad object',
      };
    },
    launchProcess: () => ({ status: 0, stdout: '', stderr: '' }),
  });

  const code = runCli(['await-and-launch', 'plan'], cap.io);

  assert.equal(code, EXIT_FAILURE);
  assert.match(cap.err(), /git log failed/);
  assert.match(cap.err(), /"step":"divergence-check"/);
  assert.match(cap.err(), /fatal: bad object/);
});

test('cmux-plan-dry-run-prints-planned-actions-without-launching', () => {
  const planned: CmuxSectionSpec[] = [];
  let launched = false;
  const cmuxAdapter: CmuxAdapter = {
    capabilities: () => ({ present: true, version: '1.2.3', verbs: [], missing: [], detail: 'ok' }),
    plan: (spec) => {
      planned.push(spec);
      return {
        ready: true,
        capabilities: { present: true, version: '1.2.3', verbs: [], missing: [], detail: 'ok' },
        actions: [{ verb: 'new_section', args: ['new_section', spec.section, '--cwd', spec.worktree] }],
        instructions: '',
      };
    },
    launch: () => {
      launched = true;
      return { ok: true, paneIds: [], instructions: '' };
    },
    notify: () => ({ ok: true }),
  };
  const planningFile = `${serializeFrontMatter(makeFrontMatter({
    feature: 'dry-run-demo',
    cmux_section: 'pane-section',
    state: 'created',
    worktree: '/tmp/worktree',
  }))}\n# Plan\n`;
  const cap = makeIO({
    readFile: () => planningFile,
    cmuxAdapter,
  });

  const code = runCli(['cmux', 'plan', '--dry-run'], cap.io);

  assert.equal(code, EXIT_OK);
  assert.equal(launched, false);
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.section, 'pane-section');
  assert.deepEqual(
    planned[0]?.panes.map((pane) => pane.pane_id),
    ['plan', 'review-plan', 'consolidate-plan', 'implement-plan', 'review-implementation', 'ship-feature'],
  );
  assert.match(cap.out(), /new_section/);
});

test('cmux-plan-usage-and-manual-degrade-paths', () => {
  const missingSubcommand = makeIO();
  assert.equal(runCli(['cmux'], missingSubcommand.io), EXIT_USAGE);
  assert.match(missingSubcommand.err(), /expected subcommand "plan"/);

  const missingDryRun = makeIO();
  assert.equal(runCli(['cmux', 'plan'], missingDryRun.io), EXIT_USAGE);
  assert.match(missingDryRun.err(), /--dry-run is required/);

  const wrongSubcommand = makeIO();
  assert.equal(runCli(['cmux', 'launch', '--dry-run'], wrongSubcommand.io), EXIT_USAGE);
  assert.match(wrongSubcommand.err(), /expected subcommand "plan"/);

  const cmuxAdapter: CmuxAdapter = {
    capabilities: () => ({ present: false, version: '', verbs: [], missing: ['new_section'], detail: 'cmux unavailable' }),
    plan: () => ({
      ready: false,
      capabilities: { present: false, version: '', verbs: [], missing: ['new_section'], detail: 'cmux unavailable' },
      actions: [],
      instructions: 'copy-paste these commands\n',
    }),
    launch: () => assert.fail('cmux plan --dry-run must not launch'),
    notify: () => ({ ok: false, error: 'cmux unavailable' }),
  };
  const manual = makeIO({ cmuxAdapter });
  assert.equal(runCli(['cmux', 'plan', '--dry-run'], manual.io), EXIT_OK);
  assert.match(manual.out(), /copy-paste/);
});
