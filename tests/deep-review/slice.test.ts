// E3 — the atomic slice engine: the ONLY part of the deep-review engine that
// mutates a git repo. These tests drive a REAL ephemeral git repo (real git,
// real commit graph, real trailers) with a STUB test argv (a tiny inline node
// script), exactly as the plan requires: every irreversible boundary is proven
// by enforcement, never assumed. The pure gates (mode/eligibility/path-safety/
// test_cmd) are additionally unit-tested through an injected findings/spawn seam
// so a refusal can be proven to happen BEFORE any git argv or test spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import type { FindingRecord, FindingsFile } from '../../deep-review/src/types.ts';
import { readFindings, writeFindings } from '../../deep-review/src/findings-io.ts';
import { commitSlice, realSliceDeps, SLICE_TRAILER_KEY } from '../../deep-review/src/slice.ts';
import type { SliceDeps } from '../../deep-review/src/slice.ts';

// ── Real-git fixture (mirrors tests/workflow/recover.test.ts) ─────────────────

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

// A throwaway dir that is ALSO a real git repo, isolated from host gpg/template
// config; the whole tree is removed on cleanup.
function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-slice-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Slice Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

// The findings file lives OUTSIDE the worktree (the engine treats it as an
// external control file), so writing it never dirties the repo and never trips
// the scope gate.
function externalFindings(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-findings-')), 'findings.json');
}

function writeFileIn(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const ORIGINAL = 'export const a = 1;\n';
const EDITED = 'export const a = 2;\n';

// A committed repo with src/app.ts at ORIGINAL, then edited to EDITED in the
// worktree (the "AI-applied change within slice_files").
function repoWithEditedSlice(): string {
  const repo = initRepo();
  writeFileIn(repo, 'src/app.ts', ORIGINAL);
  git(repo, ['add', '--', 'src/app.ts']);
  git(repo, ['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(repo, 'src/app.ts'), EDITED);
  return repo;
}

function head(repo: string): string {
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function porcelain(repo: string): string {
  return git(repo, ['status', '--porcelain']).trim();
}

function lastLine(body: string): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  return lines[lines.length - 1] ?? '';
}

// ── Findings builders ─────────────────────────────────────────────────────────

function validFinding(over: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: 'f-001',
    severity: 'P1',
    file: 'src/app.ts',
    line: 1,
    title: 'fix the thing',
    impact: 'x',
    needs_plan: false,
    test_cmd: ['node', '-e', 'process.exit(0)'],
    slice_files: ['src/app.ts'],
    classification: 'fixable-now',
    status: 'pending',
    sha: '',
    ...over,
  };
}

function validFile(
  findings: FindingRecord[],
  mode: FindingsFile['mode'] = 'review-and-refactor',
): FindingsFile {
  return { schema: 1, mode, generated_at: '2026-06-14T00:00:00Z', findings };
}

// A stub deps seam for the PURE gate tests: an injected findings file (bypassing
// findings-io validation so defense-in-depth gates are reachable), a spawn that
// records + throws if ever reached (proving "refused before any git/test spawn"),
// and a writeFindings that captures snapshots.
function stubDeps(file: FindingsFile): {
  deps: SliceDeps;
  spawnCalls: string[];
  written: FindingsFile[];
} {
  const spawnCalls: string[] = [];
  const written: FindingsFile[] = [];
  const deps: SliceDeps = {
    cwd: path.join(os.tmpdir(), 'dr-should-never-spawn'),
    spawn: (f, a) => {
      spawnCalls.push([f, ...a].join(' '));
      throw new Error('spawn must not be reached by a pure gate');
    },
    readFindings: () => structuredClone(file),
    writeFindings: (_p, f) => {
      written.push(structuredClone(f));
    },
  };
  return { deps, spawnCalls, written };
}

// ── Green / red / trailer (real git) ──────────────────────────────────────────

test('green path: in-slice change + test argv exit 0 -> stage EXACTLY slice_files, commit with trailer, status "fixed" + sha=HEAD, clean', () => {
  const repo = repoWithEditedSlice();
  const fpath = externalFindings();
  writeFindings(fpath, validFile([validFinding()]));

  const result = commitSlice('f-001', fpath, realSliceDeps(repo));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.machineError, undefined);
  // Exactly slice_files was committed (no `git add -A` could have crept in).
  const committed = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(committed, ['src/app.ts']);
  // Trailer is the last line.
  assert.equal(lastLine(git(repo, ['log', '-1', '--format=%B'])), `${SLICE_TRAILER_KEY}: f-001`);
  // No slice path remains dirty.
  assert.equal(porcelain(repo), '');
  // Findings persisted: fixed + sha === the new HEAD.
  const after = readFindings(fpath).findings[0];
  assert.equal(after?.status, 'fixed');
  assert.equal(after?.sha, head(repo));
});

test('red path: in-slice change + test argv exit non-zero -> revert slice to HEAD (clean), status "fix-failed", NO commit', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const fpath = externalFindings();
  writeFindings(fpath, validFile([validFinding({ test_cmd: ['node', '-e', 'process.exit(1)'] })]));

  const result = commitSlice('f-001', fpath, realSliceDeps(repo));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(head(repo), before, 'no new commit');
  assert.equal(fs.readFileSync(path.join(repo, 'src/app.ts'), 'utf8'), ORIGINAL, 'slice reverted');
  assert.equal(porcelain(repo), '', 'no slice path remains dirty');
  assert.equal(readFindings(fpath).findings[0]?.status, 'fix-failed');
});

test('trailer correctness: the commit message last line is exactly "Deep-Review-Slice: <id>"', () => {
  const repo = repoWithEditedSlice();
  const fpath = externalFindings();
  const id = 'fix-buffer-overflow-7';
  writeFindings(fpath, validFile([validFinding({ id })]));

  assert.equal(commitSlice(id, fpath, realSliceDeps(repo)).exitCode, EXIT_OK);
  assert.equal(lastLine(git(repo, ['log', '-1', '--format=%B'])), `Deep-Review-Slice: ${id}`);
});

// ── Deterministic scope gate (real git) ───────────────────────────────────────

test('scope (deterministic): a dirty path OUTSIDE slice_files -> refused BEFORE test run / git add / git mutation', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  // A second, out-of-slice dirty (untracked) file.
  fs.writeFileSync(path.join(repo, 'other.ts'), 'rogue\n');

  // A test_cmd that writes a sentinel; its ABSENCE proves the test never ran.
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-sentinel-'));
  const sentinel = path.join(sdir, 'ran.flag');
  const script = path.join(sdir, 'write-sentinel.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);

  const fpath = externalFindings();
  writeFindings(fpath, validFile([validFinding({ test_cmd: ['node', script] })]));

  const result = commitSlice('f-001', fpath, realSliceDeps(repo));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(fs.existsSync(sentinel), false, 'test argv must NOT have run');
  assert.equal(head(repo), before, 'no commit');
  assert.equal(git(repo, ['diff', '--cached', '--name-only']).trim(), '', 'nothing staged');
  // Both files remain dirty (no add, no revert).
  assert.equal(fs.readFileSync(path.join(repo, 'src/app.ts'), 'utf8'), EDITED);
  assert.equal(fs.readFileSync(path.join(repo, 'other.ts'), 'utf8'), 'rogue\n');
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending', 'status unchanged');
});

// ── Git failure (real git, commit hook rejects) ───────────────────────────────

test('git failure: a pre-commit hook rejects -> EXIT_FAILURE + machine error naming step "commit", no commit', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);

  const fpath = externalFindings();
  writeFindings(fpath, validFile([validFinding()]));

  const result = commitSlice('f-001', fpath, realSliceDeps(repo));

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.ok(result.machineError, 'machine error present');
  assert.equal(result.machineError?.step, 'commit');
  assert.match(result.machineError?.command ?? '', /^git commit/);
  assert.equal(head(repo), before, 'no commit landed');
  // Error outcome: findings are NOT written.
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending');
});

// ── Pure gates (injected seam; proven BEFORE any spawn) ───────────────────────

test('mode gate: mode "review-only" -> EXIT_WRONG_STATE before any spawn/git', () => {
  const { deps, spawnCalls, written } = stubDeps(validFile([validFinding()], 'review-only'));
  assert.equal(commitSlice('f-001', 'findings.json', deps).exitCode, EXIT_WRONG_STATE);
  assert.deepEqual(spawnCalls, [], 'no spawn');
  assert.deepEqual(written, [], 'no write');
});

test('eligibility: a no-touch / needs-plan / non-pending finding -> EXIT_WRONG_STATE, no spawn', () => {
  const cases: Partial<FindingRecord>[] = [
    { classification: 'no-touch', status: 'no-touch' },
    { classification: 'needs-plan', status: 'needs-plan' },
    { classification: 'fixable-now', status: 'fixed' },
    { classification: '', status: 'pending' },
  ];
  for (const over of cases) {
    const { deps, spawnCalls } = stubDeps(validFile([validFinding(over)]));
    assert.equal(
      commitSlice('f-001', 'findings.json', deps).exitCode,
      EXIT_WRONG_STATE,
      JSON.stringify(over),
    );
    assert.deepEqual(spawnCalls, [], `no spawn for ${JSON.stringify(over)}`);
  }
});

test('eligibility: an unknown finding id -> EXIT_WRONG_STATE, no spawn', () => {
  const { deps, spawnCalls } = stubDeps(validFile([validFinding()]));
  assert.equal(commitSlice('nope', 'findings.json', deps).exitCode, EXIT_WRONG_STATE);
  assert.deepEqual(spawnCalls, []);
});

test('path-safety: an unsafe file/slice_files path -> refused before any git argv, status "invalid", no spawn', () => {
  const { deps, spawnCalls, written } = stubDeps(
    validFile([validFinding({ file: 'src/app.ts', slice_files: ['src/app.ts', '../escape.ts'] })]),
  );
  assert.equal(commitSlice('f-001', 'findings.json', deps).exitCode, EXIT_WRONG_STATE);
  assert.deepEqual(spawnCalls, [], 'no spawn before path gate');
  assert.equal(written.at(-1)?.findings[0]?.status, 'invalid', 'persisted invalid');
});

test('test_cmd-safety: empty / non-array / control-char test_cmd -> EXIT_WRONG_STATE, no git, status unchanged', () => {
  const TAB = String.fromCharCode(9);
  const cases: string[][] = [
    [],
    ['npm', ''],
    ['npm', `te${TAB}st`],
    'not-an-array' as unknown as string[],
  ];
  for (const test_cmd of cases) {
    const { deps, spawnCalls, written } = stubDeps(validFile([validFinding({ test_cmd })]));
    assert.equal(
      commitSlice('f-001', 'findings.json', deps).exitCode,
      EXIT_WRONG_STATE,
      JSON.stringify(test_cmd),
    );
    assert.deepEqual(spawnCalls, [], 'no spawn');
    assert.deepEqual(written, [], 'status unchanged (no write)');
  }
});
