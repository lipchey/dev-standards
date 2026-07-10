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
// By default NO <root>/.gitleaks.toml is present (so the base argv, no `-c`, is
// used); pass hasConfig:true to also make <root>/.gitleaks.toml exist.
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

// ── scanner behaviour against an injected spawn ───────────────────────────────

test('(a) present wrapper + clean exit 0 returns null (clean)', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner(presentExecDeps(fx.spawn));
  assert.equal(scan('hello world, nothing to see here'), null);
  assert.equal(fx.calls.length, 1, 'a present+exec wrapper is invoked exactly once');
});

test('(b) present wrapper + non-zero exit returns a non-null hit (fail-closed)', () => {
  const fx = spawnFixture({ status: 1, stdout: 'finding: aws key REDACTED' });
  const scan = createSecretScanner(presentExecDeps(fx.spawn));
  const hit = scan('body with a secret');
  assert.notEqual(hit, null);
  assert.match(hit ?? '', /exit 1/);
  assert.match(hit ?? '', /finding/);
});

test('(c) present wrapper + spawn error returns a non-null hit (fail-closed)', () => {
  const fx = spawnFixture({ status: null, error: new Error('spawn ETIMEDOUT') });
  const scan = createSecretScanner(presentExecDeps(fx.spawn));
  const hit = scan('anything at all');
  assert.notEqual(hit, null, 'a spawn failure must NOT be treated as clean');
  assert.match(hit ?? '', /fail-closed/);
  assert.match(hit ?? '', /ETIMEDOUT/);
});

test('(d) absent wrapper resolves to a no-op (null) and never spawns', () => {
  const fx = spawnFixture({ status: 1 }); // would be a HIT if it ever ran
  const scan = createSecretScanner({
    spawn: fx.spawn,
    cwd: () => '/repo',
    fileExists: () => false,
    statMode: () => null,
  });
  assert.equal(scan('body with a SECRET token'), null, 'no wrapper => no-op clean (dev-standards/fixture case)');
  assert.equal(fx.calls.length, 0, 'absent wrapper => spawn is never reached');
});

test('(e) present-but-not-executable wrapper is a no-op (null)', () => {
  const fx = spawnFixture({ status: 1 });
  const scan = createSecretScanner({
    spawn: fx.spawn,
    cwd: () => '/repo',
    fileExists: () => true,
    statMode: () => 0o644, // present, no execute bit
  });
  // DESIGN: a present-but-non-executable wrapper cannot be run, so the runtime
  // scanner no-ops (null) exactly like the absent case (treated as clean).
  assert.equal(scan('body with a SECRET token'), null);
  assert.equal(fx.calls.length, 0, 'non-executable wrapper => spawn is never reached');
});

test('(f) spawns the base argv (no -c) with body on stdin, shell:false, cwd=root when no repo config', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner({
    ...presentExecDeps(fx.spawn, '/repo'), // wrapper present, NO .gitleaks.toml
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

test('(g) FIX 3: a repo .gitleaks.toml adds -c <abs path> to the argv and sets cwd=root', () => {
  const fx = spawnFixture({ status: 0 });
  const scan = createSecretScanner(presentExecDeps(fx.spawn, '/repo', /* hasConfig */ true));

  scan('PR BODY CONTENT');

  assert.equal(fx.calls.length, 1);
  const call = fx.calls[0];
  assert.deepEqual(
    call?.args,
    ['stdin', '-c', '/repo/.gitleaks.toml', '--no-banner', '--redact'],
    'argv includes -c with the ABSOLUTE config path when .gitleaks.toml exists at root',
  );
  assert.equal(call?.options.cwd, '/repo', 'cwd is the resolved root');
  assert.equal(call?.options.input, 'PR BODY CONTENT', 'content still passed on stdin (non-body argv only)');
});

test('(h) FIX 3: a feature-worktree root resolves -c to THAT root’s .gitleaks.toml', () => {
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
  // Path-aware presence so config resolution also tracks the (changing) root;
  // here neither root ships a .gitleaks.toml, so the base argv is used.
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

test('end-to-end with a real wrapper script: stdin received, exit 0 clean / exit 1 hit', () => {
  // A STAND-IN wrapper (not real gitleaks): exits 1 iff stdin contains "SECRET".
  // This exercises the real spawnSync wiring (stdin passing + exit-code → hit)
  // through the default deps. Real pinned-gitleaks behaviour is validated by a
  // smoke at pilot adoption.
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

    assert.equal(scan('a totally clean body'), null, 'clean stdin => exit 0 => null');
    const hit = scan('this body has a SECRET token');
    assert.notEqual(hit, null, 'tainted stdin => exit 1 => non-null hit');
    assert.match(hit ?? '', /exit 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: a real <root>/.gitleaks.toml is threaded to the wrapper via -c (real spawn)', () => {
  // FIX 3 through the DEFAULT (real) deps: a stand-in wrapper records its argv so
  // we can assert -c <abs config> reached it. The exact real-gitleaks rule
  // application is validated by the pilot smoke at S15b.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-cfg-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    const argvLog = path.join(dir, 'argv.log');
    const wrapper = path.join(dir, 'tools', 'run-gitleaks');
    // Records its own argv (one per line) then drains stdin and exits clean.
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nfor a in "$@"; do echo "$a" >> "${argvLog}"; done\ncat >/dev/null\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(dir, GITLEAKS_CONFIG_REL), '[allowlist]\n');

    const scan = createSecretScanner({ cwd: () => dir });
    assert.equal(scan('clean body'), null, 'clean exit 0 => null');

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
