// The secret-scan producer returns a SecretScanResult (§0, DR-12): three honest states —
// `clean` (exit 0), `hit` (exit 1 only), `unavailable` (absent/non-exec wrapper, spawn fault,
// timeout, or ANY other exit code). This replaces the old fail-open null-on-absent and the
// "every non-zero == hit" collapse. `unavailable` is fail-closed upstream (report.ts refuses).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSecretScanner,
  realScannerResolution,
  resolveScanner,
  gitleaksArgs,
  GITLEAKS_ARGS,
  GITLEAKS_CONFIG_REL,
  SCANNER_REL,
} from '../../deep-review/src/secret-scan.ts';
import type {
  SecretScanSpawn,
  SecretScanSpawnOptions,
  SecretScanSpawnResult,
} from '../../deep-review/src/secret-scan.ts';
import { createDeadline } from '../../deep-review/src/deadline.ts';

// ── injected-spawn fixture ────────────────────────────────────────────────────

interface SpawnCall {
  file: string;
  args: string[];
  options: SecretScanSpawnOptions;
}

function spawnFixture(response: {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) {
  const calls: SpawnCall[] = [];
  const spawn = (
    file: string,
    args: string[],
    options: SecretScanSpawnOptions,
  ): SecretScanSpawnResult => {
    calls.push({ file, args, options });
    const result: SecretScanSpawnResult = {
      status: response.status ?? 0,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
    };
    if (response.error !== undefined) result.error = response.error;
    return result;
  };
  return { calls, spawn };
}

// Deps where the convention wrapper is PRESENT + EXECUTABLE at <root>/tools/run-gitleaks.
function presentExecDeps(spawn: SecretScanSpawn, root = '/repo', hasConfig = false) {
  const wrapper = `${root}/${SCANNER_REL}`;
  const config = `${root}/.gitleaks.toml`;
  return {
    spawn,
    cwd: () => root,
    fileExists: (p: string) => p === wrapper || (hasConfig && p === config),
    statMode: () => 0o755,
  };
}

// ── resolution (pure) ─────────────────────────────────────────────────────────

test('resolveScanner reports present + executable from the mode bits', () => {
  const execOk = resolveScanner('/repo', { fileExists: () => true, statMode: () => 0o755 });
  assert.deepEqual(execOk, { path: '/repo/tools/run-gitleaks', present: true, executable: true });

  const notExec = resolveScanner('/repo', { fileExists: () => true, statMode: () => 0o644 });
  assert.equal(notExec.present, true);
  assert.equal(notExec.executable, false);

  const absent = resolveScanner('/repo', { fileExists: () => false, statMode: () => null });
  assert.deepEqual(absent, { path: '/repo/tools/run-gitleaks', present: false, executable: false });
});

test('gitleaksArgs: base argv with no config, -c <abs> threaded when a config path is given', () => {
  assert.deepEqual(gitleaksArgs(null), ['stdin', '--no-banner', '--redact']);
  assert.deepEqual(gitleaksArgs('/repo/.gitleaks.toml'), [
    'stdin',
    '-c',
    '/repo/.gitleaks.toml',
    '--no-banner',
    '--redact',
  ]);
  assert.equal(GITLEAKS_CONFIG_REL, '.gitleaks.toml');
});

// ── exit-code classification (the DR-12 fix) ──────────────────────────────────

test('(a) present wrapper + exit 0 -> { status: "clean" }', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner(presentExecDeps(fx.spawn));
  assert.deepEqual(scan('hello world, nothing to see here'), { status: 'clean' });
  assert.equal(fx.calls.length, 1, 'a present+exec wrapper is invoked exactly once');
});

test('(b) present wrapper + exit 1 -> { status: "hit" } carrying the redacted findings tail', () => {
  const fx = spawnFixture({ status: 1, stdout: 'finding: aws key REDACTED' });
  const scan = createSecretScanner(presentExecDeps(fx.spawn));
  const result = scan('body with a secret');
  assert.equal(result.status, 'hit');
  if (result.status !== 'hit') return;
  assert.match(result.findings, /finding/);
});

test('(c) present wrapper + spawn error -> { status: "unavailable" } (NOT a hit)', () => {
  const fx = spawnFixture({ status: null, error: new Error('spawn ETIMEDOUT') });
  const scan = createSecretScanner(presentExecDeps(fx.spawn));
  const result = scan('anything at all');
  assert.equal(result.status, 'unavailable', 'a spawn failure must NOT be treated as clean OR as a hit');
  if (result.status !== 'unavailable') return;
  assert.match(result.reason, /ETIMEDOUT/);
});

test('(d) ABSENT wrapper -> { status: "unavailable" } (fail-CLOSED; was fail-open null=clean) and never spawns', () => {
  const fx = spawnFixture({ status: 1 });
  const scan = createSecretScanner({
    spawn: fx.spawn,
    cwd: () => '/repo',
    fileExists: () => false,
    statMode: () => null,
  });
  const result = scan('body with a SECRET token');
  assert.equal(result.status, 'unavailable', 'no wrapper => unavailable, NOT the old no-op clean');
  assert.equal(fx.calls.length, 0, 'absent wrapper => spawn is never reached');
});

test('(e) present-but-not-executable wrapper -> { status: "unavailable" }, never spawns', () => {
  const fx = spawnFixture({ status: 1 });
  const scan = createSecretScanner({
    spawn: fx.spawn,
    cwd: () => '/repo',
    fileExists: () => true,
    statMode: () => 0o644,
  });
  assert.equal(scan('body with a SECRET token').status, 'unavailable');
  assert.equal(fx.calls.length, 0, 'non-executable wrapper => spawn is never reached');
});

test('(z) exit code OTHER than 0/1 (e.g. 127 missing binary) -> "unavailable", NOT a hit (the collapse fix)', () => {
  for (const status of [2, 126, 127, 3]) {
    const fx = spawnFixture({ status, stderr: `gitleaks: exited ${status}` });
    const scan = createSecretScanner(presentExecDeps(fx.spawn));
    const result = scan('body');
    assert.equal(result.status, 'unavailable', `exit ${status} must be unavailable, not hit`);
    if (result.status !== 'unavailable') return;
    assert.match(result.reason, new RegExp(String(status)));
  }
});

// ── argv / cwd / stdin shape (return value is clean here) ──────────────────────

test('(f) spawns the base argv (no -c) with body on stdin, shell:false, cwd=root when no repo config', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner({
    ...presentExecDeps(fx.spawn, '/repo'),
    timeoutMs: 4321,
  });

  scan('PR BODY CONTENT');

  assert.deepEqual([...GITLEAKS_ARGS], ['stdin', '--no-banner', '--redact']);
  assert.equal(fx.calls.length, 1);
  const call = fx.calls[0];
  assert.equal(call?.file, `/repo/${SCANNER_REL}`, 'resolves <root>/tools/run-gitleaks at call time');
  assert.deepEqual(call?.args, ['stdin', '--no-banner', '--redact'], 'no -c when no repo config');
  assert.ok(!call?.args.includes('-c'), 'argv must omit -c when .gitleaks.toml is absent');
  assert.equal(call?.options.shell, false);
  assert.equal(call?.options.encoding, 'utf8');
  assert.equal(call?.options.timeout, 4321);
  assert.equal(call?.options.input, 'PR BODY CONTENT', 'the candidate content is passed on stdin');
  assert.equal(call?.options.cwd, '/repo', 'spawns with cwd = resolved root for deterministic config resolution');
});

test('(g) a repo .gitleaks.toml adds -c <abs path> to the argv and sets cwd=root', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner(presentExecDeps(fx.spawn, '/repo', /* hasConfig */ true));

  scan('PR BODY CONTENT');

  const call = fx.calls[0];
  assert.deepEqual(
    call?.args,
    ['stdin', '-c', '/repo/.gitleaks.toml', '--no-banner', '--redact'],
    'argv includes -c with the ABSOLUTE config path when .gitleaks.toml exists at root',
  );
  assert.equal(call?.options.cwd, '/repo', 'cwd is the resolved root');
  assert.equal(call?.options.input, 'PR BODY CONTENT', 'content still passed on stdin (non-body argv only)');
});

test('(h) a feature-worktree root resolves -c to THAT root’s .gitleaks.toml', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner(presentExecDeps(fx.spawn, '/feature-worktree', true));

  scan('body');

  const call = fx.calls[0];
  assert.deepEqual(call?.args, [
    'stdin',
    '-c',
    '/feature-worktree/.gitleaks.toml',
    '--no-banner',
    '--redact',
  ]);
  assert.equal(call?.options.cwd, '/feature-worktree');
});

test('the wrapper is resolved at CALL time relative to the current cwd', () => {
  const fx = spawnFixture({ status: 0 });
  let root = '/feature-worktree';
  const scan = createSecretScanner({
    spawn: fx.spawn,
    cwd: () => root,
    fileExists: (p: string) => p === `${root}/${SCANNER_REL}`,
    statMode: () => 0o755,
  });

  scan('first');
  root = '/main-repo-root';
  scan('second');

  assert.equal(fx.calls[0]?.file, `/feature-worktree/${SCANNER_REL}`);
  assert.equal(fx.calls[0]?.options.cwd, '/feature-worktree', 'cwd tracks the call-time root');
  assert.equal(fx.calls[1]?.file, `/main-repo-root/${SCANNER_REL}`);
  assert.equal(fx.calls[1]?.options.cwd, '/main-repo-root');
});

// ── deadline threading (§0: timeout = min(cap, remainingMs); spent budget short-circuits) ─────

test('deadline: the spawn timeout is tightened to the deadline’s remaining budget when smaller than the cap', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner({ ...presentExecDeps(fx.spawn), timeoutMs: 30_000, deadline: createDeadline(1) });
  scan('body');
  const timeout = fx.calls[0]?.options.timeout ?? Number.POSITIVE_INFINITY;
  assert.ok(timeout <= 1000 && timeout > 0, `timeout should be clamped to ~1s, got ${timeout}`);
});

test('deadline: an already-spent budget -> { status: "unavailable" } WITHOUT spawning', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner({ ...presentExecDeps(fx.spawn), deadline: createDeadline(0) });
  const result = scan('body');
  assert.equal(result.status, 'unavailable');
  assert.equal(fx.calls.length, 0, 'a spent deadline must not spawn the scanner');
});

// ── real-fs resolution + a real wrapper end-to-end (NOT real gitleaks) ────────

test('realScannerResolution reflects real fs presence + the exec bit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  try {
    assert.equal(realScannerResolution(dir).present, false, 'no tools/run-gitleaks yet');

    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    const wrapper = path.join(dir, 'tools', 'run-gitleaks');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const present = realScannerResolution(dir);
    assert.equal(present.present, true);
    assert.equal(present.executable, false, 'present but not executable');

    fs.chmodSync(wrapper, 0o755);
    assert.equal(realScannerResolution(dir).executable, true, 'executable after chmod +x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end with a real wrapper script: exit 0 => clean, exit 1 => hit (real spawnSync wiring)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-e2e-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    const wrapper = path.join(dir, 'tools', 'run-gitleaks');
    fs.writeFileSync(
      wrapper,
      '#!/bin/sh\nbody="$(cat)"\ncase "$body" in *SECRET*) echo "leak found" >&2; exit 1 ;; esac\nexit 0\n',
      { mode: 0o755 },
    );
    const scan = createSecretScanner({ cwd: () => dir });

    assert.deepEqual(scan('a totally clean body'), { status: 'clean' }, 'clean stdin => exit 0 => clean');
    const result = scan('this body has a SECRET token');
    assert.equal(result.status, 'hit', 'tainted stdin => exit 1 => hit');
    if (result.status !== 'hit') return;
    assert.match(result.findings, /leak found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: a real <root>/.gitleaks.toml is threaded to the wrapper via -c (real spawn)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-cfg-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    const argvLog = path.join(dir, 'argv.log');
    const wrapper = path.join(dir, 'tools', 'run-gitleaks');
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nfor a in "$@"; do echo "$a" >> "${argvLog}"; done\ncat >/dev/null\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(dir, GITLEAKS_CONFIG_REL), '[allowlist]\n');

    const scan = createSecretScanner({ cwd: () => dir });
    assert.deepEqual(scan('clean body'), { status: 'clean' }, 'clean exit 0 => clean');

    const recorded = fs.readFileSync(argvLog, 'utf8').trim().split('\n');
    assert.deepEqual(recorded, [
      'stdin',
      '-c',
      path.join(dir, GITLEAKS_CONFIG_REL),
      '--no-banner',
      '--redact',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
