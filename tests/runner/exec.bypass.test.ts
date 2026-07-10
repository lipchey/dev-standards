import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runCheck } from '../../runner/src/exec.ts';
import type { RunCheckInput } from '../../runner/src/exec.ts';
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

// Set/restore DS_BYPASS_REASON around a call so no test leaks bypass state into another.
function withBypassReason<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.DS_BYPASS_REASON;
  if (value === undefined) delete process.env.DS_BYPASS_REASON;
  else process.env.DS_BYPASS_REASON = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DS_BYPASS_REASON;
    else process.env.DS_BYPASS_REASON = prev;
  }
}

// Bug caught: bypass dropping the original finding's exit code, or ignoring the reason text.
test('bypassable fail + non-empty DS_BYPASS_REASON relaxes to bypassed, exitCode preserved', () => {
  const result = withBypassReason('flaky in CI', () =>
    runCheck(input(check([process.execPath, stub('fail.mjs')], { bypassable: true }))),
  );
  assert.equal(result.status, 'bypassed');
  assert.equal(result.reason, 'flaky in CI');
  assert.equal(result.exitCode, 1);
});

// Bug caught: a blank/whitespace/unset reason being treated as a valid bypass.
test('bypassable fail stays fail when the reason is unset, empty, or whitespace', () => {
  for (const reason of [undefined, '', '   ']) {
    const result = withBypassReason(reason, () =>
      runCheck(input(check([process.execPath, stub('fail.mjs')], { bypassable: true }))),
    );
    assert.equal(result.status, 'fail', `reason=${JSON.stringify(reason)} must not bypass`);
    assert.equal(result.exitCode, 1);
  }
});

// Bug caught: bypass leaking to a check the manifest never marked bypassable (e.g. a secret scan).
test('non-bypassable fail stays fail even with DS_BYPASS_REASON set', () => {
  const result = withBypassReason('please let me through', () =>
    runCheck(input(check([process.execPath, stub('fail.mjs')]))),
  );
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
});

// Bug caught: a missing/broken check being waved through as if it were a bypassable finding.
test('spawn ENOENT is status error, never bypassed even with bypassable + reason', () => {
  const result = withBypassReason('trust me', () =>
    runCheck(input(check(['this-binary-does-not-exist-xyz'], { bypassable: true }))),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, null);
  assert.ok(result.reason && result.reason.length > 0);
});

// Bug caught: a tool's DECLARED operational failure (operational_exit_codes) being waved through by
// a bypassable check — the operational rung sits ABOVE the bypass rung, so it can never be bypassed.
test('declared operational exit is status error, never bypassed even with bypassable + reason', () => {
  const result = withBypassReason('trust me', () =>
    runCheck(input(check([process.execPath, stub('exit2.mjs')], { bypassable: true, operational_exit_codes: [2] }))),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, null);
  assert.equal(result.reason, 'operational exit 2');
});

// The bypass path for UNDECLARED codes is unchanged: exit 2 with no operational declaration is a
// genuine finding, so a bypassable check + reason still relaxes it to 'bypassed'.
test('an undeclared nonzero exit still bypasses normally (operational rung leaves the bypass path intact)', () => {
  const result = withBypassReason('flaky in CI', () =>
    runCheck(input(check([process.execPath, stub('exit2.mjs')], { bypassable: true, operational_exit_codes: [3] }))),
  );
  assert.equal(result.status, 'bypassed');
  assert.equal(result.reason, 'flaky in CI');
  assert.equal(result.exitCode, 2);
});

// Bug caught: a SIGKILLed check (no exit code) collapsing into a plain fail that could be bypassed.
test('signal-killed child (null exit) is status error, never bypassed', () => {
  const result = withBypassReason('trust me', () =>
    runCheck(input(check([process.execPath, stub('sigkill.mjs')], { bypassable: true }))),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, null);
  assert.ok(result.reason && result.reason.length > 0);
});
