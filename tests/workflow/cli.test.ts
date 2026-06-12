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

test('unknown-command-usage', () => {
  const cap = makeIO();
  const code = runCli(['frobnicate'], cap.io);
  assert.equal(code, EXIT_USAGE);
  assert.match(cap.err(), /unknown command/i, 'names the failure');
  assert.match(cap.err(), /frobnicate/, 'echoes the offending command');
  assert.match(cap.err(), /usage/i, 'prints usage');
});
