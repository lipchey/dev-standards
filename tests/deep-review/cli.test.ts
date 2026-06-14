// Fix C — top-level error handling at the CLI dispatch (§2.4). The findings file
// and the quality manifest are UNTRUSTED inputs: a malformed JSON, a bad enum, or
// a missing/invalid quality.json must NEVER escape a handler as a raw V8 stack
// trace + exit 1. `runCli` wraps the dispatch and, on any caught io/validation
// failure, emits a §2.4 machine-readable error object (`{ "error": { … } }`) as
// the LAST line of stderr and returns EXIT_FAILURE. These tests inject CliDeps so
// nothing touches the real process; quality.json / findings live in a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';
import { EXIT_FAILURE } from '../../deep-review/src/types.ts';
import type { MachineError } from '../../deep-review/src/types.ts';

// This repo's own quality.json is a known-valid manifest; copying it isolates the
// failure-under-test to the untrusted findings file (loadConfig/buildSet succeed).
const REPO_QUALITY = fileURLToPath(new URL('../../quality.json', import.meta.url));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dr-cli-'));
}

function dirWithQuality(): string {
  const dir = tmpDir();
  fs.copyFileSync(REPO_QUALITY, path.join(dir, 'quality.json'));
  return dir;
}

// Captures stderr; `warn` is suppressed so the ONLY stderr lines come from the
// command (and the machine error must be the last of them).
function capture(cwd: string): { deps: CliDeps; errLines: () => string[] } {
  const err: string[] = [];
  return {
    deps: {
      stdout: () => {},
      stderr: (t) => err.push(t),
      cwd: () => cwd,
      warn: () => {},
    },
    errLines: () => err.join('').split('\n').filter((l) => l.length > 0),
  };
}

// The LAST stderr line must parse as a §2.4 `{ error: MachineError }` object.
function lastError(lines: string[]): MachineError {
  const last = lines[lines.length - 1] ?? '';
  const parsed = JSON.parse(last) as { error: MachineError };
  assert.ok(parsed.error && typeof parsed.error === 'object', 'last stderr line is {error:{…}}');
  assert.equal(typeof parsed.error.command, 'string');
  assert.equal(typeof parsed.error.message, 'string');
  assert.equal(typeof parsed.error.stderr_tail, 'string');
  return parsed.error;
}

test('check-path with no resolvable quality.json -> EXIT_FAILURE + a machine-error JSON last stderr line (never a raw throw)', () => {
  const dir = tmpDir(); // no quality.json present
  const cap = capture(dir);
  const code = runCli(['check-path', 'src/app.ts'], cap.deps);
  assert.equal(code, EXIT_FAILURE);
  const error = lastError(cap.errLines());
  assert.match(error.command, /deep-review check-path/);
});

test('commit-slice with a malformed-JSON findings file -> EXIT_FAILURE + {error} last stderr line', () => {
  const dir = dirWithQuality();
  const fpath = path.join(dir, 'findings.json');
  fs.writeFileSync(fpath, '{ this is not valid json');
  const cap = capture(dir);
  const code = runCli(['commit-slice', 'f-001', '--findings', fpath], cap.deps);
  assert.equal(code, EXIT_FAILURE);
  const error = lastError(cap.errLines());
  assert.match(error.command, /deep-review commit-slice/);
});

test('classify with a malformed-JSON findings file -> EXIT_FAILURE + {error} last stderr line', () => {
  const dir = dirWithQuality();
  const fpath = path.join(dir, 'findings.json');
  fs.writeFileSync(fpath, 'not json at all');
  const cap = capture(dir);
  const code = runCli(['classify', '--findings', fpath], cap.deps);
  assert.equal(code, EXIT_FAILURE);
  lastError(cap.errLines());
});

test('classify with a bad-enum findings file -> EXIT_FAILURE + {error} last stderr line carrying the rule', () => {
  const dir = dirWithQuality();
  const fpath = path.join(dir, 'findings.json');
  // Valid JSON, but `mode` is not an allowed enum -> readFindings throws (enum).
  fs.writeFileSync(
    fpath,
    JSON.stringify({ schema: 1, mode: 'bogus-mode', generated_at: '2026-06-14T00:00:00Z', findings: [] }),
  );
  const cap = capture(dir);
  const code = runCli(['classify', '--findings', fpath], cap.deps);
  assert.equal(code, EXIT_FAILURE);
  const error = lastError(cap.errLines());
  assert.match(error.message, /enum/);
});
