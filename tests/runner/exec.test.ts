import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expandArgv, parseIoStallUs, runCheck, runProcess } from '../../runner/src/exec.ts';
import type { RunCheckInput } from '../../runner/src/exec.ts';
import { isBlockingResult } from '../../runner/src/verify-runner.ts';
import type { Check } from '../../runner/src/types.ts';

function stub(name: string): string {
  return fileURLToPath(new URL(`../stubs/${name}`, import.meta.url));
}

function check(argv: string[], overrides: Partial<Check> = {}): Check {
  return { name: 'c', argv, timeout_seconds: 30, ...overrides };
}

function input(c: Check, filesByName = new Map<string, string[]>()): RunCheckInput {
  return { check: c, tier: 'fast', cwd: process.cwd(), filesByName };
}

test('exit 0 becomes status pass', () => {
  const result = runCheck(input(check([process.execPath, stub('ok.mjs')])));
  assert.equal(result.status, 'pass');
  assert.equal(result.exitCode, 0);
});

test('exit 1 becomes status fail', () => {
  const result = runCheck(input(check([process.execPath, stub('fail.mjs')])));
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
});

// operational_exit_codes (P8.1): a DECLARED nonzero exit is the tool's own operational failure,
// not a caught finding. It must classify to 'error' — unbypassable, blocking regardless of mode.
test('declared operational exit code becomes status error, exitCode null, code preserved in reason', () => {
  const result = runCheck(
    input(check([process.execPath, stub('exit2.mjs')], { operational_exit_codes: [2] })),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, null);
  assert.equal(result.reason, 'operational exit 2');
});

// The whole point of 'error': it blocks the tier even for a report-only check (isBlockingResult IS
// the tier's exit decision), so a tool malfunction can never pass fail-open.
test('a declared operational error blocks the tier even when mode is report-only', () => {
  const result = runCheck(
    input(check([process.execPath, stub('exit2.mjs')], { operational_exit_codes: [2], mode: 'report-only' })),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.mode, 'report-only');
  assert.equal(isBlockingResult(result), true);
});

// An UNDECLARED nonzero exit is unchanged from today: a genuine finding-fail.
test('an undeclared nonzero exit stays status fail (operational rung does not hijack it)', () => {
  const result = runCheck(
    input(check([process.execPath, stub('exit2.mjs')], { operational_exit_codes: [3] })),
  );
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 2);
});

test('with no operational_exit_codes declared, a nonzero exit is a plain fail as before', () => {
  const result = runCheck(input(check([process.execPath, stub('exit2.mjs')])));
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 2);
});

test('timeout becomes status timeout and exitCode null', () => {
  const result = runCheck(
    input(check([process.execPath, stub('sleep.mjs'), '5'], { timeout_seconds: 1 })),
  );
  assert.equal(result.status, 'timeout');
  assert.equal(result.exitCode, null);
});

test('expandArgv replaces a {files:x} token with the fileset spread', () => {
  const out = expandArgv(['tool', '{files:x}'], new Map([['x', ['a.ts', 'b.ts']]]));
  assert.deepEqual(out, ['tool', 'a.ts', 'b.ts']);
});

test('expandArgv rejects an option-like expanded file operand (argv option injection)', () => {
  // Token-expanded repo filenames can be parsed as tool options.
  assert.throws(
    () => expandArgv(['eslint', '{files:ts}'], new Map([['ts', ['--config=evil.ts', 'src/good.ts']]])),
    /option-like|injection/i,
  );
  assert.throws(
    () => expandArgv(['tool', '{files:ts}'], new Map([['ts', ['-rf.ts']]])),
    /option-like|injection/i,
  );
});

test('expandArgv rejects an @-prefixed expanded file operand (response-file injection)', () => {
  // Tools like tsc treat @ operands as response files.
  assert.throws(
    () => expandArgv(['tsc', '{files:ts}'], new Map([['ts', ['@evil', 'src/good.ts']]])),
    /option-like|injection/i,
  );
});

test('runCheck fails closed on an @-prefixed expanded operand (response-file injection)', () => {
  assert.throws(
    () =>
      runCheck(
        input(check([process.execPath, '{files:ts}']), new Map([['ts', ['@evil']]])),
      ),
    /option-like|injection/i,
  );
});

test('expandArgv rejects every glob-metacharacter expanded file operand (silent glob mis-resolution)', () => {
  /* eslint/prettier glob-expand operands; a glob metacharacter in a staged filename resolves as
     a pattern instead of the literal file. Always-magic chars, the extglob triggers !( +( @(, and
     a leading ! (negation) are refused for every caller. */
  const bad = [
    'src/a*b.ts', 'src/a?b.ts', 'src/a[b.ts', 'src/a]b.ts', 'src/foo[1].ts',
    'src/a{b.ts', 'src/a}b.ts', 'src/a{1,2}.ts',
    'src/+(foo).ts', 'src/@(foo).ts', 'src/!(foo).ts', '!foo.ts',
  ];
  for (const name of bad) {
    assert.throws(
      () => expandArgv(['eslint', '{files:ts}'], new Map([['ts', [name]]])),
      /glob metacharacter/i,
      `${name} must be refused`,
    );
  }
});

test('expandArgv passes a bare paren/plus/at filename that is not a glob trigger (no over-refusal)', () => {
  /* A lone ( ) + @ is a literal filename char, not an extglob trigger, so these common names pass. */
  for (const ok of ['src/foo(1).ts', 'src/a+b.ts', 'src/mod@2.ts']) {
    assert.deepEqual(
      expandArgv(['eslint', '{files:ts}'], new Map([['ts', [ok]]])),
      ['eslint', ok],
      `${ok} must pass`,
    );
  }
});

test('expandArgv passes through a normal filename unaffected by the glob-metacharacter guard', () => {
  const out = expandArgv(['eslint', '{files:ts}'], new Map([['ts', ['src/good-file.ts']]]));
  assert.deepEqual(out, ['eslint', 'src/good-file.ts']);
});

test('expandArgv passes through a literal option the manifest author wrote', () => {
  // Only fileset-expanded operands are guarded; manifest-authored flags are trusted.
  const out = expandArgv(
    ['tool', '--max-warnings=0', '{files:ts}'],
    new Map([['ts', ['src/my-file.ts', 'src/a.ts']]]),
  );
  assert.deepEqual(out, ['tool', '--max-warnings=0', 'src/my-file.ts', 'src/a.ts']);
});

test('argv collapsing to zero elements becomes status skipped, no throw', () => {
  const result = runCheck(input(check(['{files:empty}']), new Map([['empty', []]])));
  assert.equal(result.status, 'skipped');
  assert.equal(result.exitCode, null);
});

test('skip_if_empty skips the check when its fileset expands empty', () => {
  const result = runCheck(
    input(
      check([process.execPath, stub('ok.mjs')], { skip_if_empty: 'staged' }),
      new Map([['staged', []]]),
    ),
  );
  assert.equal(result.status, 'skipped');
});

test('skip_if_empty skips the check when its fileset is absent', () => {
  const result = runCheck(
    input(check([process.execPath, stub('ok.mjs')], { skip_if_empty: 'missing' })),
  );
  assert.equal(result.status, 'skipped');
});

test('a missing binary (ENOENT) becomes status error (operational fault), not fail or timeout', () => {
  // A check that never ran must not be reported as a genuine finding; that would let a
  // missing/broken report-only check pass its tier fail-open, or be bypassed.
  const result = runCheck(input(check(['this-binary-does-not-exist-xyz'])));
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, null);
  assert.ok(result.reason && result.reason.length > 0, 'error result must carry a reason');
  assert.notEqual(result.status, 'fail');
  assert.notEqual(result.status, 'timeout');
});

// RUN-01 tree-kill: a check that outlives its timeout must have its whole detached
// process group SIGKILLed, so no descendant keeps mutating the repo afterwards.
// Child stub spawns a grandchild that writes `marker` after `delayMs`, then ignores
// SIGTERM and sleeps `hangMs`.
function writeGroupStub(dir: string): string {
  const file = path.join(dir, 'group-child.mjs');
  fs.writeFileSync(
    file,
    "import { spawn } from 'node:child_process';\n" +
      'const [marker, delayMs, hangMs] = process.argv.slice(2);\n' +
      "spawn(process.execPath, ['-e', 'setTimeout(()=>require(\"fs\").writeFileSync(process.argv[1],\"x\"),' + delayMs + ')', marker], { stdio: 'ignore' });\n" +
      "process.on('SIGTERM', () => {});\n" +
      'setTimeout(() => process.exit(0), Number(hangMs));\n',
  );
  return file;
}

test('timeout SIGKILLs the whole detached group: no grandchild survives (RUN-01)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-treekill-'));
  try {
    const marker = path.join(dir, 'marker');
    // Grandchild would write at ~2s; runCheck kills at 1s. Child hangs 60s (ignores SIGTERM).
    const result = runCheck(
      input(check([process.execPath, writeGroupStub(dir), marker, '2000', '60000'], { timeout_seconds: 1 })),
    );
    assert.equal(result.status, 'timeout');
    await delay(2000);
    assert.equal(
      fs.existsSync(marker),
      false,
      'grandchild survived the timeout and wrote its marker — process group was not reaped',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('control: the grandchild marker really writes when the check is not killed (RUN-01)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-treekill-ctl-'));
  try {
    const marker = path.join(dir, 'marker');
    // Grandchild writes at 100ms; child exits at 300ms; generous timeout → no kill.
    const result = runCheck(
      input(check([process.execPath, writeGroupStub(dir), marker, '100', '300'], { timeout_seconds: 30 })),
    );
    assert.equal(result.status, 'pass');
    await delay(200);
    assert.equal(fs.existsSync(marker), true, 'grandchild should have written its marker when not killed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── runProcess (§0): the generic deadline-bounded executor the deep-review verbs consume ──
// Shares spawnGroup's detached-group + SIGKILL + reap mechanic with runCheck, but captures
// stdout/stderr and classifies into ok/red/operational (operational must NEVER read as red).

test('runProcess: a clean exit 0 is kind "ok" with exitCode 0 and captured stdout', () => {
  const result = runProcess({ argv: [process.execPath, stub('ok.mjs')], cwd: process.cwd(), timeoutMs: 30_000 });
  assert.equal(result.kind, 'ok');
  assert.equal(result.exitCode, 0);
});

test('runProcess: a non-zero exit is kind "red" (a genuine failure), exitCode preserved', () => {
  const result = runProcess({ argv: [process.execPath, stub('fail.mjs')], cwd: process.cwd(), timeoutMs: 30_000 });
  assert.equal(result.kind, 'red');
  assert.equal(result.exitCode, 1);
});

test('runProcess: timeoutMs <= 0 is "operational" WITHOUT spawning (pre-spawn checkpoint)', () => {
  // A brand-new file the process WOULD create if it ran; its absence proves no spawn happened.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runproc-'));
  try {
    const marker = path.join(dir, 'ran');
    const script = path.join(dir, 'write.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    const result = runProcess({ argv: [process.execPath, script], cwd: process.cwd(), timeoutMs: 0 });
    assert.equal(result.kind, 'operational');
    assert.equal(result.exitCode, null);
    assert.equal(fs.existsSync(marker), false, 'a spent budget must NOT spawn the process');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcess: a timeout is "operational" (never "red"), exitCode null', () => {
  const result = runProcess({
    argv: [process.execPath, stub('sleep.mjs'), '5'],
    cwd: process.cwd(),
    timeoutMs: 200,
  });
  assert.equal(result.kind, 'operational');
  assert.notEqual(result.kind, 'red');
  assert.equal(result.exitCode, null);
});

test('runProcess: a spawn fault (ENOENT) is "operational" (a missing tool never reads as a red test)', () => {
  const result = runProcess({ argv: ['this-binary-does-not-exist-xyz'], cwd: process.cwd(), timeoutMs: 30_000 });
  assert.equal(result.kind, 'operational');
  assert.equal(result.exitCode, null);
  assert.ok(result.stderrTail.length > 0, 'operational result carries a reason tail');
});

test('runProcess: a timeout SIGKILLs the whole detached group — no grandchild survives (RUN-01)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runproc-kill-'));
  try {
    const marker = path.join(dir, 'marker');
    // Grandchild would write at ~2s; runProcess kills at 1s; child hangs 60s ignoring SIGTERM.
    const result = runProcess({
      argv: [process.execPath, writeGroupStub(dir), marker, '2000', '60000'],
      cwd: process.cwd(),
      timeoutMs: 1000,
    });
    assert.equal(result.kind, 'operational');
    await delay(2000);
    assert.equal(fs.existsSync(marker), false, 'grandchild survived — process group was not reaped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseIoStallUs reads the total of the "full" line, not "some"', () => {
  const psi = [
    'some avg10=0.11 avg60=0.22 avg300=0.33 total=73123456',
    'full avg10=0.10 avg60=0.20 avg300=0.30 total=70612345',
    '',
  ].join('\n');
  assert.equal(parseIoStallUs(psi), 70612345);
});

test('parseIoStallUs returns null when the "full" line is absent (PSI-less kernel)', () => {
  assert.equal(parseIoStallUs('some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n'), null);
  assert.equal(parseIoStallUs(''), null);
});

// The wiring, not the parser: on a PSI kernel every CheckResult must carry the sampled window.
test('runCheck attaches ioStallMs where PSI exists', { skip: !fs.existsSync('/proc/pressure/io') }, () => {
  const result = runCheck(input(check([process.execPath, '-e', 'process.exit(0)'])));
  assert.equal(result.status, 'pass');
  assert.equal(typeof result.ioStallMs, 'number');
  assert.ok((result.ioStallMs as number) >= 0, 'stall delta is monotonic, never negative');
});
