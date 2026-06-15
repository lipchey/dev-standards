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

// A committed repo with src/app.ts at ORIGINAL and a CLEAN worktree (no edits), so
// a test controls exactly which slice paths are dirty.
function cleanRepo(): string {
  const repo = initRepo();
  writeFileIn(repo, 'src/app.ts', ORIGINAL);
  git(repo, ['add', '--', 'src/app.ts']);
  git(repo, ['commit', '-q', '-m', 'init']);
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

// Writes a throwaway node script that, run with cwd=<repo>, creates the file
// named by argv[2] (content "pwn"), and — when argv[3] === 'stage' — also runs
// `git add -- <that path>` before exiting 0. Used to simulate an UNTRUSTED
// test_cmd that mutates the worktree/index out from under the engine: a `stage`
// run smuggles a path into the index; a non-stage run leaves a transient
// UNSTAGED artifact. The script is built from an array joined by '\n' so no
// control byte ever appears literally in this source.
function makeMutatingScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-script-'));
  const script = path.join(dir, 'mutate.mjs');
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { spawnSync } from 'node:child_process';",
      'const rel = process.argv[2];',
      'const full = path.join(process.cwd(), rel);',
      'fs.mkdirSync(path.dirname(full), { recursive: true });',
      "fs.writeFileSync(full, 'pwn\\n');",
      "if (process.argv[3] === 'stage') {",
      "  const r = spawnSync('git', ['add', '--', rel], { cwd: process.cwd() });",
      '  process.exit(r.status === 0 ? 0 : 2);',
      '}',
      'process.exit(0);',
    ].join('\n'),
  );
  return script;
}

// Writes a throwaway node script that, run with cwd=<repo>, RENAMES the tracked
// file argv[2] to argv[3] via `git mv` (which stages the rename as a delete of the
// source + an add of the destination) and exits 0. Used to prove the post-test
// staged re-gate must pass --no-renames: otherwise rename detection coalesces the
// pair into a single rename naming only the in-slice destination, HIDING the
// no-touch source deletion.
function makeRenameScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-script-'));
  const script = path.join(dir, 'rename.mjs');
  fs.writeFileSync(
    script,
    [
      "import { spawnSync } from 'node:child_process';",
      'const src = process.argv[2];',
      'const dst = process.argv[3];',
      "const r = spawnSync('git', ['mv', src, dst], { cwd: process.cwd() });",
      'process.exit(r.status === 0 ? 0 : 2);',
    ].join('\n'),
  );
  return script;
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
function stubDeps(
  file: FindingsFile,
  noTouchSet: readonly string[] = [],
): {
  deps: SliceDeps;
  spawnCalls: string[];
  written: FindingsFile[];
} {
  const spawnCalls: string[] = [];
  const written: FindingsFile[] = [];
  const deps: SliceDeps = {
    cwd: path.join(os.tmpdir(), 'dr-should-never-spawn'),
    noTouchSet,
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

// A spawn seam that DELEGATES to real git (so the engine runs against a real repo)
// while recording every git argv, used to assert pathspec hardening on the argv.
function spyOverReal(): { spawn: SliceDeps['spawn']; gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  const spawn: SliceDeps['spawn'] = (file, args, options) => {
    if (file === 'git') gitCalls.push([...args]);
    const r = spawnSync(file, args, { cwd: options.cwd, encoding: 'utf8', shell: false });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { spawn, gitCalls };
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

// ── Fix B: untracked-aware RED revert + -uall scope gate (real git) ───────────

test('RED with a NEW untracked slice file -> the new file is REMOVED, status "fix-failed", EXIT_OK, no slice path dirty', () => {
  const repo = cleanRepo();
  const before = head(repo);
  // A brand-new untracked file in an EXISTING tracked dir (src/), inside the slice.
  writeFileIn(repo, 'src/new.ts', 'export const n = 1;\n');
  const fpath = externalFindings();
  writeFindings(
    fpath,
    validFile([
      validFinding({ file: 'src/new.ts', slice_files: ['src/new.ts'], test_cmd: ['node', '-e', 'process.exit(1)'] }),
    ]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(head(repo), before, 'no commit');
  assert.equal(fs.existsSync(path.join(repo, 'src/new.ts')), false, 'untracked slice file removed');
  assert.equal(porcelain(repo), '', 'no slice path remains dirty');
  assert.equal(readFindings(fpath).findings[0]?.status, 'fix-failed');
});

test('RED with a MIXED slice (tracked-modified + new untracked) -> tracked reverted to HEAD, untracked removed, status "fix-failed", EXIT_OK, clean', () => {
  const repo = cleanRepo();
  const before = head(repo);
  fs.writeFileSync(path.join(repo, 'src/app.ts'), EDITED); // tracked, modified, in slice
  writeFileIn(repo, 'src/added.ts', 'export const x = 1;\n'); // new untracked, in slice
  const fpath = externalFindings();
  writeFindings(
    fpath,
    validFile([
      validFinding({
        file: 'src/app.ts',
        slice_files: ['src/app.ts', 'src/added.ts'],
        test_cmd: ['node', '-e', 'process.exit(1)'],
      }),
    ]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(head(repo), before, 'no commit');
  assert.equal(fs.readFileSync(path.join(repo, 'src/app.ts'), 'utf8'), ORIGINAL, 'tracked path reverted to HEAD');
  assert.equal(fs.existsSync(path.join(repo, 'src/added.ts')), false, 'untracked path removed');
  assert.equal(porcelain(repo), '', 'no slice path remains dirty');
  assert.equal(readFindings(fpath).findings[0]?.status, 'fix-failed');
});

test('GREEN with a new file in the slice -> it is added + committed (status "fixed")', () => {
  const repo = cleanRepo();
  writeFileIn(repo, 'src/added.ts', 'export const x = 1;\n'); // new untracked, in slice
  const fpath = externalFindings();
  writeFindings(
    fpath,
    validFile([
      validFinding({ file: 'src/added.ts', slice_files: ['src/added.ts'], test_cmd: ['node', '-e', 'process.exit(0)'] }),
    ]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo));

  assert.equal(result.exitCode, EXIT_OK);
  const committed = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.deepEqual(committed, ['src/added.ts'], 'new file committed');
  assert.equal(porcelain(repo), '', 'clean after commit');
  assert.equal(readFindings(fpath).findings[0]?.status, 'fixed');
});

test('scope gate (-uall): a slice that creates a file in a BRAND-NEW directory now PASSES (file seen individually, not the collapsed dir)', () => {
  const repo = cleanRepo();
  // A new file in a brand-new directory: default `git status` collapses this to
  // `brandnew/`, which is NOT in the slice (false-refuse); with -uall it is seen
  // as `brandnew/x.ts` and matches the slice, so the slice proceeds to GREEN.
  writeFileIn(repo, 'brandnew/x.ts', 'export const x = 1;\n');
  const fpath = externalFindings();
  writeFindings(
    fpath,
    validFile([
      validFinding({ file: 'brandnew/x.ts', slice_files: ['brandnew/x.ts'], test_cmd: ['node', '-e', 'process.exit(0)'] }),
    ]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo));

  assert.equal(result.exitCode, EXIT_OK, 'scope gate passed (file seen individually under -uall)');
  const committed = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.deepEqual(committed, ['brandnew/x.ts']);
});

// ── Fix D: pathspec hardening (--literal-pathspecs on path-bearing git argv) ──

test('pathspec hardening: the GREEN slice `add` argv and the RED slice `checkout` argv are prefixed with --literal-pathspecs', () => {
  // GREEN -> records the `add` argv.
  const repoG = repoWithEditedSlice();
  const fG = externalFindings();
  writeFindings(fG, validFile([validFinding()]));
  const spyG = spyOverReal();
  const depsG: SliceDeps = { ...realSliceDeps(repoG), spawn: spyG.spawn };
  assert.equal(commitSlice('f-001', fG, depsG).exitCode, EXIT_OK);
  const addCall = spyG.gitCalls.find((a) => a.includes('add'));
  assert.ok(addCall, 'an `add` git call was made');
  assert.equal(addCall[0], '--literal-pathspecs', 'add argv begins with --literal-pathspecs');

  // RED -> records the `checkout` argv (a tracked slice path).
  const repoR = repoWithEditedSlice();
  const fR = externalFindings();
  writeFindings(fR, validFile([validFinding({ test_cmd: ['node', '-e', 'process.exit(1)'] })]));
  const spyR = spyOverReal();
  const depsR: SliceDeps = { ...realSliceDeps(repoR), spawn: spyR.spawn };
  assert.equal(commitSlice('f-001', fR, depsR).exitCode, EXIT_OK);
  const checkoutCall = spyR.gitCalls.find((a) => a.includes('checkout'));
  assert.ok(checkoutCall, 'a `checkout` git call was made');
  assert.equal(checkoutCall[0], '--literal-pathspecs', 'checkout argv begins with --literal-pathspecs');
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
  // The green commit is scoped to the slice and pathspec-hardened.
  assert.match(result.machineError?.command ?? '', /^git --literal-pathspecs commit\b/);
  assert.match(result.machineError?.command ?? '', /-- src\/app\.ts$/);
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

// ── Fix A: no-touch enforcement in commit-slice (the only mutating command) ───

test('no-touch (real git): an EDITABLE finding.file but a no-touch slice_files entry -> EXIT_WRONG_STATE, NO commit, worktree unchanged, findings not mutated', () => {
  // src/app.ts (the in-slice dirty file) is editable; the slice ALSO names a
  // no-touch path (tools/**). Without the no-touch gate the scope gate would pass
  // (dirty set ⊆ slice) and the green path would attempt `git add -- tools/...`
  // (EXIT_FAILURE) — so EXIT_WRONG_STATE here is attributable ONLY to the gate.
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const fpath = externalFindings();
  writeFindings(
    fpath,
    validFile([validFinding({ file: 'src/app.ts', slice_files: ['tools/danger.sh', 'src/app.ts'] })]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo, ['tools/**']));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(head(repo), before, 'no commit');
  assert.equal(git(repo, ['diff', '--cached', '--name-only']).trim(), '', 'nothing staged');
  assert.equal(fs.readFileSync(path.join(repo, 'src/app.ts'), 'utf8'), EDITED, 'worktree unchanged (no revert)');
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending', 'findings not mutated');
});

test('no-touch (pure): a finding whose file is no-touch (classification pre-set fixable-now) -> EXIT_WRONG_STATE before any git/spawn, no write', () => {
  const { deps, spawnCalls, written } = stubDeps(
    validFile([
      validFinding({
        file: 'tools/secret.sh',
        slice_files: ['tools/secret.sh'],
        classification: 'fixable-now',
        status: 'pending',
      }),
    ]),
    ['tools/**'],
  );
  assert.equal(commitSlice('f-001', 'findings.json', deps).exitCode, EXIT_WRONG_STATE);
  assert.deepEqual(spawnCalls, [], 'refused before any git/spawn');
  assert.deepEqual(written, [], 'findings not mutated');
});

// ── Codex P1: post-test re-gate of the STAGED index + scoped slice commit ─────
// The pre-test scope gate cannot cover a test_cmd that stages a path AFTER it
// runs: `git commit` (no pathspec) would commit the whole index, so an untrusted
// test_cmd that does `git add <out-of-slice|no-touch>` could smuggle that file
// into the slice commit. After test_cmd returns, the engine re-reads the STAGED
// index and refuses (EXIT_WRONG_STATE, NO commit) if any staged path is outside
// the slice or is no-touch; the green commit is additionally scoped to the slice.

test('post-test re-gate: a test_cmd that stages an OUT-OF-SLICE no-touch file (git add .github/workflows/pwn.yml) and exits 0 -> EXIT_WRONG_STATE, NO commit, pwn.yml never committed, HEAD unmoved', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const script = makeMutatingScript();
  const fpath = externalFindings();
  // slice is src/app.ts; test_cmd smuggles .github/workflows/pwn.yml into the index.
  writeFindings(
    fpath,
    validFile([validFinding({ test_cmd: ['node', script, '.github/workflows/pwn.yml', 'stage'] })]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo, ['.github/workflows/**']));

  assert.equal(result.exitCode, EXIT_WRONG_STATE, 'staged out-of-slice/no-touch path refused');
  assert.equal(head(repo), before, 'no new commit (HEAD unmoved)');
  // The smuggled file appears in NO commit anywhere in history.
  const everCommitted = git(repo, ['log', '--all', '--name-only', '--format=']);
  assert.ok(!everCommitted.includes('.github/workflows/pwn.yml'), 'pwn.yml never committed');
  // Surfaced, not silently recorded as a failed fix.
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending', 'status unchanged (surfaced)');
});

test('post-test re-gate: a test_cmd that stages an OUT-OF-SLICE (non-no-touch) file and exits 0 -> EXIT_WRONG_STATE, NO commit (slice-membership branch alone)', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const script = makeMutatingScript();
  const fpath = externalFindings();
  // No no-touch set at all: the refusal must come from the slice-membership check.
  writeFindings(
    fpath,
    validFile([validFinding({ test_cmd: ['node', script, 'rogue.ts', 'stage'] })]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo, []));

  assert.equal(result.exitCode, EXIT_WRONG_STATE, 'staged out-of-slice path refused on membership alone');
  assert.equal(head(repo), before, 'no new commit');
  const everCommitted = git(repo, ['log', '--all', '--name-only', '--format=']);
  assert.ok(!everCommitted.includes('rogue.ts'), 'rogue.ts never committed');
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending', 'status unchanged');
});

test('post-test re-gate: a test_cmd that writes an UNSTAGED out-of-slice transient (coverage/log) and exits 0 -> slice still commits (fixed); only the STAGED index is gated', () => {
  const repo = repoWithEditedSlice();
  const script = makeMutatingScript();
  const fpath = externalFindings();
  // No 'stage' arg: the transient is written but NOT staged, so it must be tolerated.
  writeFindings(
    fpath,
    validFile([validFinding({ test_cmd: ['node', script, 'coverage/lcov.info'] })]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo, []));

  assert.equal(result.exitCode, EXIT_OK, 'unstaged transient artifact is tolerated');
  // Exactly the slice was committed (the transient is not in the tree).
  const committed = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(committed, ['src/app.ts'], 'only the slice committed');
  assert.equal(lastLine(git(repo, ['log', '-1', '--format=%B'])), `${SLICE_TRAILER_KEY}: f-001`);
  assert.equal(readFindings(fpath).findings[0]?.status, 'fixed');
  // The transient remains in the worktree (untracked) — tolerated, not removed.
  assert.equal(fs.existsSync(path.join(repo, 'coverage/lcov.info')), true, 'transient left untouched');
});

test('post-test re-gate (--no-renames): a test_cmd that RENAMES a no-touch file INTO a slice path (git mv) and exits 0 -> EXIT_WRONG_STATE, NO commit, no-touch file still tracked at HEAD (rename-hiding closed, S21 residue P2)', () => {
  const repo = initRepo();
  // Force rename detection ON so that, absent --no-renames, `git diff --cached`
  // coalesces the mv into a single rename naming only the in-slice destination and
  // HIDES the no-touch deletion (the exact bug this guards).
  git(repo, ['config', 'diff.renames', 'true']);
  writeFileIn(repo, '.github/workflows/ci.yml', 'name: ci\n');
  git(repo, ['add', '--', '.github/workflows/ci.yml']);
  git(repo, ['commit', '-q', '-m', 'init no-touch']);
  const before = head(repo);

  const script = makeRenameScript();
  const fpath = externalFindings();
  // The slice is `renamed.ts` (root); the UNTRUSTED test_cmd renames the no-touch
  // ci.yml onto it, smuggling the no-touch deletion behind a detected rename.
  writeFindings(
    fpath,
    validFile([
      validFinding({
        file: 'renamed.ts',
        slice_files: ['renamed.ts'],
        test_cmd: ['node', script, '.github/workflows/ci.yml', 'renamed.ts'],
      }),
    ]),
  );

  const result = commitSlice('f-001', fpath, realSliceDeps(repo, ['.github/workflows/**']));

  assert.equal(
    result.exitCode,
    EXIT_WRONG_STATE,
    'staged no-touch deletion (hidden behind a rename) refused',
  );
  assert.equal(head(repo), before, 'no new commit (HEAD unmoved)');
  // The no-touch source is still tracked at HEAD — its deletion was never committed.
  const tracked = git(repo, ['ls-tree', '--name-only', '-r', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.ok(tracked.includes('.github/workflows/ci.yml'), 'no-touch file still tracked at HEAD');
  assert.ok(!tracked.includes('renamed.ts'), 'slice destination never committed');
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending', 'status unchanged (surfaced)');
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
