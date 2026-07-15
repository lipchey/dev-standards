/* scripts/merge-deep-review-hooks.mjs wires the guides-read Stop/SubagentStop hooks into a
   consumer's .claude/settings.json. It writes a security-sensitive file, so these pin the
   contract: structured merge (never clobber), idempotency, and fail-closed on a corrupt or
   symlinked target. Driven through the real script entry (argv + exit codes). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'scripts', 'merge-deep-review-hooks.mjs');
const HOOK_COMMAND = '"$CLAUDE_PROJECT_DIR"/scripts/deep-review guides-read --hook-stdin';

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(root: string, ...extra: string[]): RunResult {
  const result = spawnSync('node', [SCRIPT, root, ...extra], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withRoot(callback: (root: string) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-merge-')));
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function settingsPath(root: string): string {
  return path.join(root, '.claude', 'settings.json');
}

function readSettings(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(root), 'utf8'));
}

function commandsFor(settings: Record<string, unknown>, event: string): string[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = (hooks?.[event] as Array<{ hooks?: Array<{ command?: string }> }>) ?? [];
  return groups.flatMap((group) => (group.hooks ?? []).map((hook) => hook.command ?? ''));
}

test('creates settings.json with both Stop and SubagentStop hooks and reports created:', () => {
  withRoot((root) => {
    const result = run(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^created:.*settings\.json$/m);
    const settings = readSettings(root);
    assert.deepEqual(commandsFor(settings, 'Stop'), [HOOK_COMMAND]);
    assert.deepEqual(commandsFor(settings, 'SubagentStop'), [HOOK_COMMAND]);
  });
});

test('a second run is idempotent: no duplicate hook, no created: line', () => {
  withRoot((root) => {
    run(root);
    const second = run(root);
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), '');
    assert.deepEqual(commandsFor(readSettings(root), 'Stop'), [HOOK_COMMAND]);
  });
});

test('merges into pre-existing settings without clobbering unrelated keys or other hooks', () => {
  withRoot((root) => {
    fs.mkdirSync(path.dirname(settingsPath(root)), { recursive: true });
    fs.writeFileSync(
      settingsPath(root),
      JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }),
    );
    assert.equal(run(root).status, 0);
    const settings = readSettings(root);
    assert.deepEqual(settings.permissions, { allow: ['Bash'] });
    assert.deepEqual(commandsFor(settings, 'Stop'), ['other', HOOK_COMMAND]);
    assert.deepEqual(commandsFor(settings, 'SubagentStop'), [HOOK_COMMAND]);
  });
});

test('--check exits 0 when both hooks are present and 1 when absent', () => {
  withRoot((root) => {
    fs.mkdirSync(path.dirname(settingsPath(root)), { recursive: true });
    fs.writeFileSync(settingsPath(root), '{}');
    assert.equal(run(root, '--check').status, 1);
    run(root);
    assert.equal(run(root, '--check').status, 0);
  });
});

test('--check fails when hooks are globally disabled, even with the hooks present (R2-5)', () => {
  withRoot((root) => {
    run(root); // install the hooks
    const settings = readSettings(root);
    settings.disableAllHooks = true;
    fs.writeFileSync(settingsPath(root), JSON.stringify(settings));
    const result = run(root, '--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /disableAllHooks|globally disabled/);
  });
});

test('--check does NOT count a matcher-FILTERED group as armed (R2-5)', () => {
  withRoot((root) => {
    fs.mkdirSync(path.dirname(settingsPath(root)), { recursive: true });
    // Our command present, but in a group whose matcher targets some other agent -> not armed
    // for a deep-review subagent, so --check must report it missing.
    const filtered = { hooks: { Stop: [{ matcher: 'OtherAgent', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } };
    fs.writeFileSync(settingsPath(root), JSON.stringify(filtered));
    assert.equal(run(root, '--check').status, 1);
  });
});

test('fails closed (exit 2) on a settings.json that is not valid JSON', () => {
  withRoot((root) => {
    fs.mkdirSync(path.dirname(settingsPath(root)), { recursive: true });
    fs.writeFileSync(settingsPath(root), 'not json');
    const result = run(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not valid JSON/);
  });
});

test('refuses a symlinked settings.json (would route the write outside the repo)', () => {
  withRoot((root) => {
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, '{}');
    fs.mkdirSync(path.dirname(settingsPath(root)), { recursive: true });
    fs.symlinkSync(outside, settingsPath(root));
    const result = run(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /symlink/);
  });
});
