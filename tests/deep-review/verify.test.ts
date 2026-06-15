// E7 — the final verify gate. After all fix slices are committed and BEFORE the
// ADR-012 handoff, the deep-review runtime runs the worktree's verify shim once.
// A GREEN run (exit 0) clears the refactor to proceed to handoff; a RED run (any
// non-zero exit) means verify found problems, so the whole refactor is
// `needs-human` (EXIT_NEEDS_HUMAN = 13) and NOTHING lands; a missing / non-executable
// shim (a failed spawn / null status) is a TOOL failure, not a verify verdict, so it
// fails closed with EXIT_FAILURE + a §2.4 MachineError naming step "verify".
//
// The pure `runFinalVerify` cases inject a stub spawn (no real process). The scope
// resolution (`--scope` ?? deep_review.verify_after_fix ?? --fast) is a CLI concern,
// so those cases drive `runCli` against a temp quality.json + a recording verify shim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFinalVerify } from '../../deep-review/src/verify.ts';
import type { SpawnResult, VerifyDeps } from '../../deep-review/src/verify.ts';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';
import { EXIT_OK, EXIT_USAGE, EXIT_FAILURE, EXIT_NEEDS_HUMAN } from '../../deep-review/src/types.ts';

// ── runFinalVerify (pure, injected spawn) ────────────────────────────────────────

interface RecordedCall {
  file: string;
  args: string[];
  options: { cwd: string };
}

// A stub spawn that records every call and returns a fixed result.
function stubSpawn(result: SpawnResult, calls: RecordedCall[]): VerifyDeps['spawn'] {
  return (file, args, options) => {
    calls.push({ file, args: [...args], options });
    return result;
  };
}

const WORKTREE = '/work/tree';

function deps(scope: '--fast' | '--full', result: SpawnResult, calls: RecordedCall[]): VerifyDeps {
  return { cwd: WORKTREE, scope, spawn: stubSpawn(result, calls) };
}

test('green: a verify shim that exits 0 -> EXIT_OK (proceed to handoff), no machine error', () => {
  const calls: RecordedCall[] = [];
  const result = runFinalVerify(deps('--fast', { status: 0, stdout: '', stderr: '' }, calls));
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.machineError, undefined);
});

test('red: a verify shim that exits non-zero -> EXIT_NEEDS_HUMAN (13); nothing further, spawned exactly once', () => {
  const calls: RecordedCall[] = [];
  const result = runFinalVerify(deps('--fast', { status: 1, stdout: '', stderr: 'verify failed' }, calls));
  assert.equal(result.exitCode, EXIT_NEEDS_HUMAN);
  assert.equal(result.exitCode, 13);
  assert.equal(result.machineError, undefined);
  assert.equal(calls.length, 1, 'verify is spawned exactly once; no further action on red');
});

test('fixed argv from the worktree root: file = <cwd>/verify, args = [scope], cwd = worktree root, no shell', () => {
  const calls: RecordedCall[] = [];
  const result = runFinalVerify(deps('--full', { status: 0, stdout: '', stderr: '' }, calls));
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.file, path.join(WORKTREE, 'verify'));
  assert.deepEqual(call.args, ['--full']);
  assert.equal(call.options.cwd, WORKTREE);
  // By construction: the spawn options carry ONLY cwd (no shell flag); shell:false.
  assert.deepEqual(Object.keys(call.options), ['cwd']);
});

test('scope passed through directly: runFinalVerify with scope --fast records args exactly ["--fast"]', () => {
  const calls: RecordedCall[] = [];
  runFinalVerify(deps('--fast', { status: 0, stdout: '', stderr: '' }, calls));
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.file, path.join(WORKTREE, 'verify'));
  assert.deepEqual(call.args, ['--fast']);
});

test('missing / non-executable shim: spawn status null -> EXIT_FAILURE + machine error step "verify"', () => {
  const calls: RecordedCall[] = [];
  const result = runFinalVerify(deps('--fast', { status: null, stdout: '', stderr: 'spawn ENOENT' }, calls));
  assert.equal(result.exitCode, EXIT_FAILURE);
  const me = result.machineError;
  if (me === undefined) throw new Error('expected a §2.4 machine error on a spawn failure');
  assert.equal(me.step, 'verify');
  assert.match(me.command, /verify --fast$/);
  assert.equal(typeof me.message, 'string');
  assert.equal(typeof me.stderr_tail, 'string');
});

// ── CLI scope resolution (--scope ?? deep_review.verify_after_fix ?? --fast) ──────

const REPO_QUALITY = fileURLToPath(new URL('../../quality.json', import.meta.url));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dr-verify-'));
}

// A temp dir with a valid quality.json; when `verifyAfterFix` is given, a
// `deep_review` block carrying it is added (else no `deep_review` block at all, so
// config.deepReview is undefined and the scope default applies).
function dirWithQuality(verifyAfterFix?: '--fast' | '--full'): string {
  const dir = tmpDir();
  const manifest = JSON.parse(fs.readFileSync(REPO_QUALITY, 'utf8')) as Record<string, unknown>;
  if (verifyAfterFix !== undefined) {
    manifest['deep_review'] = { enabled: true, verify_after_fix: verifyAfterFix };
  }
  fs.writeFileSync(path.join(dir, 'quality.json'), JSON.stringify(manifest));
  return dir;
}

// Writes an executable `verify` shim at <dir>/verify that records the scope arg it
// was spawned with into a sidecar file and exits 0. Returns that record path.
function writeRecordingShim(dir: string): string {
  const recordPath = path.join(dir, 'recorded-scope.txt');
  const shim = `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(recordPath)}\nexit 0\n`;
  const shimPath = path.join(dir, 'verify');
  fs.writeFileSync(shimPath, shim);
  fs.chmodSync(shimPath, 0o755);
  return recordPath;
}

function capture(cwd: string): { deps: CliDeps; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), cwd: () => cwd, warn: () => {} },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

test('scope default: no --scope and no verify_after_fix -> the verify shim is spawned with --fast', () => {
  const dir = dirWithQuality(); // no deep_review block
  const recordPath = writeRecordingShim(dir);
  const cap = capture(dir);
  const code = runCli(['verify'], cap.deps);
  assert.equal(code, EXIT_OK);
  assert.equal(fs.readFileSync(recordPath, 'utf8').trim(), '--fast');
});

test('scope from config: deep_review.verify_after_fix "--full" (no --scope) -> --full passed', () => {
  const dir = dirWithQuality('--full');
  const recordPath = writeRecordingShim(dir);
  const cap = capture(dir);
  const code = runCli(['verify'], cap.deps);
  assert.equal(code, EXIT_OK);
  assert.equal(fs.readFileSync(recordPath, 'utf8').trim(), '--full');
});

test('scope override: --scope --full overrides config "--fast" -> --full passed (space and = forms)', () => {
  const dirA = dirWithQuality('--fast');
  const recordA = writeRecordingShim(dirA);
  assert.equal(runCli(['verify', '--scope', '--full'], capture(dirA).deps), EXIT_OK);
  assert.equal(fs.readFileSync(recordA, 'utf8').trim(), '--full');

  const dirB = dirWithQuality('--fast');
  const recordB = writeRecordingShim(dirB);
  assert.equal(runCli(['verify', '--scope=--full'], capture(dirB).deps), EXIT_OK);
  assert.equal(fs.readFileSync(recordB, 'utf8').trim(), '--full');
});

test('invalid scope: --scope --bogus -> EXIT_USAGE before any spawn', () => {
  const dir = dirWithQuality('--fast'); // quality.json must load before validation
  const recordPath = writeRecordingShim(dir);
  const cap = capture(dir);
  const code = runCli(['verify', '--scope', '--bogus'], cap.deps);
  assert.equal(code, EXIT_USAGE);
  assert.match(cap.err(), /invalid --scope/);
  assert.equal(fs.existsSync(recordPath), false, 'the verify shim is never spawned on an invalid scope');
});

test('valueless --scope: a trailing `--scope` or `--scope=` is a bad operand -> EXIT_USAGE, NOT a silent default, before config load / spawn (Codex S22 P2)', () => {
  // (a) a trailing `--scope` (space form) must NOT silently fall back to --fast.
  const dirA = dirWithQuality('--fast');
  const recordA = writeRecordingShim(dirA);
  const capA = capture(dirA);
  assert.equal(runCli(['verify', '--scope'], capA.deps), EXIT_USAGE);
  assert.match(capA.err(), /--scope requires a value/);
  assert.equal(fs.existsSync(recordA), false, 'verify shim never spawned for a valueless --scope');

  // (b) the `=` form with an empty value is likewise a bad operand.
  const dirB = dirWithQuality('--fast');
  const recordB = writeRecordingShim(dirB);
  assert.equal(runCli(['verify', '--scope='], capture(dirB).deps), EXIT_USAGE);
  assert.equal(fs.existsSync(recordB), false, 'verify shim never spawned for an empty --scope=');

  // (c) the refusal happens BEFORE loadConfig: a cwd with NO quality.json still
  // returns EXIT_USAGE (a regressed fall-through would loadConfig-throw -> EXIT_FAILURE).
  const dirC = tmpDir(); // no quality.json written
  assert.equal(runCli(['verify', '--scope'], capture(dirC).deps), EXIT_USAGE);
});
