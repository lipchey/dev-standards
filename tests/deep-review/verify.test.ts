// E7 + Phase 5 §5.2 — the final verify gate. After all fix slices and BEFORE the
// ADR-012 handoff, the runtime runs the run-worktree's verify shim once. GREEN (exit
// 0) records the verification stamp and clears the refactor; RED (non-zero) is
// EXIT_NEEDS_HUMAN and nothing lands; a missing/non-executable shim (null status) is
// a TOOL failure -> EXIT_FAILURE + a §2.4 machine error naming step "verify".
//
// The pure `runFinalVerify` cases inject a stub spawn (shim + git HEAD) + a mutate
// capture (no real process/disk). The CLI scope-resolution cases drive `runCli`
// against a real ephemeral git repo + a recording verify shim, with the git-side
// identity gate injected (verifyDescriptor) so no full run-worktree ceremony is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFinalVerify, realVerifyDeps } from '../../deep-review/src/verify.ts';
import type { SpawnResult, VerifyDeps } from '../../deep-review/src/verify.ts';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';
import { EXIT_OK, EXIT_USAGE, EXIT_FAILURE, EXIT_NEEDS_HUMAN, EXIT_FINDINGS_CONFLICT } from '../../deep-review/src/types.ts';
import type { FindingsFileV2 } from '../../deep-review/src/types.ts';
import type { DescriptorVerdict, RunDescriptor } from '../../deep-review/src/descriptor.ts';
import { createDeadline } from '../../deep-review/src/deadline.ts';

const WORKTREE = '/work/tree';
const HEAD_SHA = 'a'.repeat(40);

function baseFile(): FindingsFileV2 {
  return {
    schema: 2,
    mode: 'review-and-refactor',
    generated_at: '2026-06-14T00:00:00Z',
    run_id: 'run-1',
    base_sha: 'base-1',
    revision: 0,
    verification: null,
    findings: [],
  };
}

interface RecordedCall {
  file: string;
  args: string[];
  options: { cwd: string; timeout?: number };
}

// A spawn stub dispatching on `file`: the verify shim (endsWith /verify) returns the
// injected shim result; a `git rev-parse HEAD` returns HEAD_SHA (overridable).
function stubSpawn(shim: SpawnResult, calls: RecordedCall[], head: SpawnResult = { status: 0, stdout: `${HEAD_SHA}\n`, stderr: '' }): VerifyDeps['spawn'] {
  return (file, args, options) => {
    calls.push({ file, args: [...args], options });
    return file === 'git' ? head : shim;
  };
}

function verifyDeps(over: Partial<VerifyDeps> & { shim?: SpawnResult; calls?: RecordedCall[]; head?: SpawnResult; written?: FindingsFileV2[] } = {}): VerifyDeps {
  const calls = over.calls ?? [];
  const written = over.written ?? [];
  return {
    cwd: over.cwd ?? WORKTREE,
    scope: over.scope ?? '--fast',
    findingsPath: over.findingsPath ?? '/reports/findings.json',
    deadline: over.deadline ?? createDeadline(900),
    spawn: over.spawn ?? stubSpawn(over.shim ?? { status: 0, stdout: '', stderr: '' }, calls, over.head),
    readFindings: over.readFindings ?? ((): FindingsFileV2 => baseFile()),
    mutate:
      over.mutate ??
      ((_p, fn): FindingsFileV2 => {
        const next = fn(baseFile());
        written.push(next);
        return next;
      }),
    now: over.now ?? ((): string => '2026-06-14T00:00:00Z'),
  };
}

// ── runFinalVerify (pure, injected spawn + mutate) ──────────────────────────────

test('green (--fast): shim exit 0 -> EXIT_OK + verification {sha: HEAD, scope: verify:fast, completed_at}', () => {
  const written: FindingsFileV2[] = [];
  const result = runFinalVerify(verifyDeps({ scope: '--fast', shim: { status: 0, stdout: '', stderr: '' }, written }));
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.machineError, undefined);
  assert.equal(written.length, 1, 'verification written exactly once');
  assert.deepEqual(written[0]?.verification, { sha: HEAD_SHA, scope: 'verify:fast', completed_at: '2026-06-14T00:00:00Z' });
});

test('green (--full): the recorded scope is verify:full', () => {
  const written: FindingsFileV2[] = [];
  runFinalVerify(verifyDeps({ scope: '--full', shim: { status: 0, stdout: '', stderr: '' }, written }));
  assert.equal(written[0]?.verification?.scope, 'verify:full');
});

test('red: shim exit non-zero -> EXIT_NEEDS_HUMAN (13); NO verification written', () => {
  const written: FindingsFileV2[] = [];
  const result = runFinalVerify(verifyDeps({ shim: { status: 1, stdout: '', stderr: 'verify failed' }, written }));
  assert.equal(result.exitCode, EXIT_NEEDS_HUMAN);
  assert.equal(result.machineError, undefined);
  assert.equal(written.length, 0, 'a red verify never stamps verification');
});

test('missing / non-executable shim: status null -> EXIT_FAILURE + machine error step "verify"; NO verification', () => {
  const written: FindingsFileV2[] = [];
  const result = runFinalVerify(verifyDeps({ shim: { status: null, stdout: '', stderr: 'spawn ENOENT' }, written }));
  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.machineError?.step, 'verify');
  assert.match(result.machineError?.command ?? '', /verify --fast$/);
  assert.equal(written.length, 0, 'a tool failure never stamps verification');
});

test('green but the HEAD read fails -> EXIT_FAILURE (never a false green), NO verification', () => {
  const written: FindingsFileV2[] = [];
  const calls: RecordedCall[] = [];
  const result = runFinalVerify(
    verifyDeps({ shim: { status: 0, stdout: '', stderr: '' }, head: { status: 128, stdout: '', stderr: 'fatal' }, calls, written }),
  );
  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.ok(result.machineError, 'machine error present');
  assert.equal(written.length, 0, 'no verification stamped when HEAD cannot be read');
});

test('fixed argv from the worktree root: file = <cwd>/verify, args = [scope], cwd + deadline-bounded timeout, no shell', () => {
  const calls: RecordedCall[] = [];
  runFinalVerify(verifyDeps({ scope: '--full', shim: { status: 1, stdout: '', stderr: '' }, calls }));
  // §F3 the pre-spawn HEAD read (a `git` call) precedes the shim, so locate the shim by file.
  const call = calls.find((c) => c.file !== 'git');
  assert.ok(call);
  assert.equal(call.file, path.join(WORKTREE, 'verify'));
  assert.deepEqual(call.args, ['--full']);
  assert.equal(call.options.cwd, WORKTREE);
  assert.equal(typeof call.options.timeout, 'number', 'the spawn is deadline-bounded');
});

// ── F3 HEAD capture before spawn + F2 revision CAS ──────────────────────────────

test('F3: HEAD moves during verification (pre != post) -> EXIT_FAILURE ("HEAD moved"), NO stamp', () => {
  const written: FindingsFileV2[] = [];
  const heads = [`${'a'.repeat(40)}\n`, `${'b'.repeat(40)}\n`];
  let gitCall = 0;
  const spawn: VerifyDeps['spawn'] = (file) => {
    if (file === 'git') {
      const out = heads[gitCall] ?? 'x\n';
      gitCall += 1;
      return { status: 0, stdout: out, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' }; // shim green
  };
  const result = runFinalVerify(verifyDeps({ spawn, written }));
  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.match(result.machineError?.message ?? '', /HEAD moved/);
  assert.equal(written.length, 0, 'a moved HEAD never stamps a (false) green');
});

test('F3: on a green with a STABLE HEAD, the CAPTURED pre-spawn sha is stamped', () => {
  const written: FindingsFileV2[] = [];
  // stubSpawn returns HEAD_SHA for every git call, so pre == post.
  const result = runFinalVerify(verifyDeps({ scope: '--fast', shim: { status: 0, stdout: '', stderr: '' }, written }));
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(written[0]?.verification?.sha, HEAD_SHA);
});

test('F2: verify threads the pre-spawn findings revision into the stamp mutate', () => {
  let seen: number | undefined = -1;
  const deps = verifyDeps({
    shim: { status: 0, stdout: '', stderr: '' },
    readFindings: (): FindingsFileV2 => ({ ...baseFile(), revision: 7 }),
    mutate: (_p, fn, expectedRevision): FindingsFileV2 => {
      seen = expectedRevision;
      return fn(baseFile());
    },
  });
  assert.equal(runFinalVerify(deps).exitCode, EXIT_OK);
  assert.equal(seen, 7, 'the stamp write is CAS-guarded on the pre-spawn revision');
});

// ── CLI scope resolution (--scope ?? deep_review.verify_after_fix ?? --fast) ──────

const REPO_QUALITY = fileURLToPath(new URL('../../quality.json', import.meta.url));
// The canonical guide set the §5.0 preflight requires present in guides_dir (names only).
const TEMPLATES_DIR = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

// A real ephemeral git repo whose quality.json passes the §5.0 preflight, with a bound
// findings.json under paths.reports (reports/quality) and a recording verify shim.
function repoWithFixMode(verifyAfterFix?: '--fast' | '--full'): { repo: string; fpath: string; recordPath: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-verify-')));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Verify Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);

  const manifest = JSON.parse(fs.readFileSync(REPO_QUALITY, 'utf8')) as Record<string, unknown>;
  manifest['deep_review'] = {
    enabled: true,
    modes: ['review-only', 'review-and-refactor'],
    guides_dir: 'guides',
    ...(verifyAfterFix === undefined ? {} : { verify_after_fix: verifyAfterFix }),
  };
  fs.writeFileSync(path.join(repo, 'quality.json'), JSON.stringify(manifest));
  fs.mkdirSync(path.join(repo, 'guides'), { recursive: true });
  for (const name of fs.readdirSync(TEMPLATES_DIR).filter((n) => n.endsWith('.md'))) {
    fs.writeFileSync(path.join(repo, 'guides', name), '');
  }

  fs.mkdirSync(path.join(repo, 'reports', 'quality'), { recursive: true });
  const fpath = path.join(repo, 'reports', 'quality', 'findings.json');
  fs.writeFileSync(
    fpath,
    `${JSON.stringify(
      { schema: 2, mode: 'review-and-refactor', generated_at: '2026-06-14T00:00:00Z', run_id: 'run-1', base_sha: 'base-1', revision: 0, verification: null, findings: [] },
      null,
      2,
    )}\n`,
  );

  const recordPath = path.join(repo, 'recorded-scope.txt');
  const shimPath = path.join(repo, 'verify');
  fs.writeFileSync(shimPath, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(recordPath)}\nexit 0\n`);
  fs.chmodSync(shimPath, 0o755);
  return { repo, fpath, recordPath };
}

function okDescriptor(repo: string): RunDescriptor {
  return {
    schema: 1,
    run_id: 'run-1',
    created_at: '2026-06-14T00:00:00Z',
    canonical_root: repo,
    git_dir: path.join(repo, '.git'),
    git_common_dir: path.join(repo, '.git'),
    branch_ref: 'refs/heads/deep-review/x',
    base_ref: 'refs/heads/main',
    base_sha: 'base-1',
    initial_head_sha: git(repo, ['rev-parse', 'HEAD']).trim(),
  };
}

function cliFor(repo: string): { deps: CliDeps; err: () => string } {
  const err: string[] = [];
  return {
    deps: {
      stdout: () => {},
      stderr: (t) => err.push(t),
      cwd: () => repo,
      warn: () => {},
      verifyDescriptor: (): DescriptorVerdict => ({ ok: true, descriptor: okDescriptor(repo) }),
    },
    err: () => err.join(''),
  };
}

test('scope default: no --scope and no verify_after_fix -> the verify shim is spawned with --fast; verification stamped', () => {
  const { repo, fpath, recordPath } = repoWithFixMode();
  const cli = cliFor(repo);
  assert.equal(runCli(['verify', '--findings', fpath], cli.deps), EXIT_OK);
  assert.equal(fs.readFileSync(recordPath, 'utf8').trim(), '--fast');
  assert.equal(JSON.parse(fs.readFileSync(fpath, 'utf8')).verification?.scope, 'verify:fast');
});

test('scope from config: verify_after_fix "--full" -> --full passed', () => {
  const { repo, fpath, recordPath } = repoWithFixMode('--full');
  assert.equal(runCli(['verify', '--findings', fpath], cliFor(repo).deps), EXIT_OK);
  assert.equal(fs.readFileSync(recordPath, 'utf8').trim(), '--full');
});

test('scope override: --scope --full overrides config "--fast" (space and = forms)', () => {
  const a = repoWithFixMode('--fast');
  assert.equal(runCli(['verify', '--findings', a.fpath, '--scope', '--full'], cliFor(a.repo).deps), EXIT_OK);
  assert.equal(fs.readFileSync(a.recordPath, 'utf8').trim(), '--full');

  const b = repoWithFixMode('--fast');
  assert.equal(runCli(['verify', '--findings', b.fpath, '--scope=--full'], cliFor(b.repo).deps), EXIT_OK);
  assert.equal(fs.readFileSync(b.recordPath, 'utf8').trim(), '--full');
});

test('missing --findings -> EXIT_USAGE (before spawn)', () => {
  const { repo, recordPath } = repoWithFixMode();
  const cli = cliFor(repo);
  assert.equal(runCli(['verify'], cli.deps), EXIT_USAGE);
  assert.match(cli.err(), /--findings/);
  assert.equal(fs.existsSync(recordPath), false, 'the shim is never spawned without --findings');
});

test('invalid scope: --scope --bogus -> EXIT_USAGE before any spawn', () => {
  const { repo, fpath, recordPath } = repoWithFixMode('--fast');
  const cli = cliFor(repo);
  assert.equal(runCli(['verify', '--findings', fpath, '--scope', '--bogus'], cli.deps), EXIT_USAGE);
  assert.match(cli.err(), /invalid --scope/);
  assert.equal(fs.existsSync(recordPath), false, 'the shim is never spawned on an invalid scope');
});

test('valueless --scope: a trailing `--scope` is a bad operand -> EXIT_USAGE, before config load', () => {
  // (a) space form.
  const a = repoWithFixMode('--fast');
  const capA = cliFor(a.repo);
  assert.equal(runCli(['verify', '--findings', a.fpath, '--scope'], capA.deps), EXIT_USAGE);
  assert.match(capA.err(), /--scope requires a value/);
  assert.equal(fs.existsSync(a.recordPath), false);

  // (b) the refusal happens BEFORE loadConfig: a cwd with NO quality.json still returns EXIT_USAGE.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-verify-noq-')));
  const err: string[] = [];
  const code = runCli(['verify', '--findings', path.join(dir, 'f.json'), '--scope'], { stdout: () => {}, stderr: (t) => err.push(t), cwd: () => dir });
  assert.equal(code, EXIT_USAGE);
});

test('F1/F2: a findings-lock held by a LIVE process surfaces as EXIT_FINDINGS_CONFLICT at the CLI (verify)', () => {
  const { repo, fpath } = repoWithFixMode();
  // A live holder: our own pid is provably alive, so the mutate must CONFLICT (exit 16).
  fs.writeFileSync(`${fpath}.lock`, JSON.stringify({ pid: process.pid, nonce: 'live', created_at: 't' }));
  const cli = cliFor(repo);
  assert.equal(runCli(['verify', '--findings', fpath], cli.deps), EXIT_FINDINGS_CONFLICT);
});

test('realVerifyDeps wires cwd + scope + findingsPath + ctx deadline', () => {
  const deadline = createDeadline(900);
  const d = realVerifyDeps('/some/cwd', '--full', '/reports/f.json', { canonicalRoot: '/some/cwd', reportsRootAbs: '/reports', deadline, descriptor: null });
  assert.equal(d.cwd, '/some/cwd');
  assert.equal(d.scope, '--full');
  assert.equal(d.findingsPath, '/reports/f.json');
  assert.equal(d.deadline, deadline);
  assert.equal(typeof d.mutate, 'function');
});
