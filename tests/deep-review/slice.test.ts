// E3 + Phase 5 §5.1 — the atomic slice engine: the ONLY part of the deep-review
// engine that mutates a git repo. These tests drive a REAL ephemeral git repo (real
// staging, real commit graph, real trailers, real `git worktree add`/`apply`/
// `remove`) with the per-finding VERIFY VERDICT injected via the `runProcess` seam
// (green/red/operational) — so a verdict is controlled without a real verify shim,
// while every git effect is exercised for real. The pure gates (mode/eligibility/
// path/no-touch/scope) are proven to refuse BEFORE any test spawn / commit.
//
// Run identity is enforced at the CLI edge (cli.test.ts); the engine receives an
// already-verified descriptor + deadline + reports confinement root on `deps`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_FAILURE, EXIT_WRONG_STATE, EXIT_DESCRIPTOR_MISMATCH } from '../../deep-review/src/types.ts';
import type { FindingRecord, FindingsFileV2 } from '../../deep-review/src/types.ts';
import { readFindings, mutateFindings } from '../../deep-review/src/findings-io.ts';
import { commitSlice, realSliceDeps, SLICE_TRAILER_KEY } from '../../deep-review/src/slice.ts';
import type { SliceDeps } from '../../deep-review/src/slice.ts';
import type { RunProcessResult } from '../../runner/src/exec.ts';
import type { RunDescriptor } from '../../deep-review/src/descriptor.ts';
import { createDeadline } from '../../deep-review/src/deadline.ts';

// ── Real-git fixture ──────────────────────────────────────────────────────────

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

// A throwaway dir that is ALSO a real git repo, isolated from host gpg/template
// config. realpath'd so worktree-list comparisons (symlinked /tmp) match.
function initRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-slice-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Slice Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

// The findings file lives under a reports root OUTSIDE the worktree, so mutateFindings'
// confinement passes AND writing it never dirties the repo / trips the scope gate.
function reportsRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-reports-')));
}

function writeFileIn(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const ORIGINAL = 'export const a = 1;\n';
const EDITED = 'export const a = 2;\n';

// A committed repo with src/app.ts at ORIGINAL, then edited to EDITED (unstaged) — the
// "AI-applied change within slice_files".
function repoWithEditedSlice(): string {
  const repo = initRepo();
  writeFileIn(repo, 'src/app.ts', ORIGINAL);
  git(repo, ['add', '--', 'src/app.ts']);
  git(repo, ['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(repo, 'src/app.ts'), EDITED);
  return repo;
}

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

function lastLine(body: string): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  return lines[lines.length - 1] ?? '';
}

// Commits `rel` with a slice trailer for `id` (simulates a prior slice commit whose
// findings write may not have landed — the reconciliation window).
function commitWithTrailer(repo: string, rel: string, content: string, id: string): string {
  writeFileIn(repo, rel, content);
  git(repo, ['add', '--', rel]);
  git(repo, ['commit', '-q', '-m', `deep-review: apply slice ${id}\n\n${SLICE_TRAILER_KEY}: ${id}`]);
  return head(repo);
}

// ── Findings builders (schema v2) ───────────────────────────────────────────────

function validFinding(over: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: 'f-001',
    severity: 'P1',
    file: 'src/app.ts',
    line: 1,
    title: 'fix the thing',
    impact: 'x',
    needs_plan: false,
    test_ref: 'verify:fast',
    slice_files: ['src/app.ts'],
    classification: 'fixable-now',
    status: 'pending',
    sha: '',
    ...over,
  };
}

function validFile(findings: FindingRecord[], over: Partial<FindingsFileV2> = {}): FindingsFileV2 {
  return {
    schema: 2,
    mode: 'review-and-refactor',
    generated_at: '2026-06-14T00:00:00Z',
    run_id: 'run-1',
    base_sha: 'base-1',
    revision: 0,
    verification: null,
    findings,
    ...over,
  };
}

function writeV2(fpath: string, file: FindingsFileV2): void {
  fs.writeFileSync(fpath, `${JSON.stringify(file, null, 2)}\n`);
}

function dummyDescriptor(over: Partial<RunDescriptor> = {}): RunDescriptor {
  return {
    schema: 1,
    run_id: 'run-1',
    created_at: '2026-06-14T00:00:00Z',
    canonical_root: '/repo',
    git_dir: '/repo/.git',
    git_common_dir: '/repo/.git',
    branch_ref: 'refs/heads/deep-review/x',
    base_ref: 'refs/heads/main',
    base_sha: 'base-1',
    initial_head_sha: 'HEAD0',
    ...over,
  };
}

// A spawn seam that delegates to real git (so the engine runs against a real repo),
// recording every git argv for pathspec-hardening assertions.
function realGitSpawn(gitCalls?: string[][]): SliceDeps['spawn'] {
  return (file, args, options) => {
    if (file === 'git' && gitCalls) gitCalls.push([...args]);
    const r = spawnSync(file, [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      shell: false,
      timeout: options.timeout,
      ...(options.input === undefined ? {} : { input: options.input }),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error !== undefined) return { status: null, stdout: '', stderr: r.error.message };
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

const okVerdict: RunProcessResult = { kind: 'ok', exitCode: 0, stdout: '', stderrTail: '' };
const redVerdict: RunProcessResult = { kind: 'red', exitCode: 1, stdout: '', stderrTail: 'a test failed' };
const opVerdict: RunProcessResult = { kind: 'operational', exitCode: null, stdout: '', stderrTail: 'spawn ENOENT' };

interface DepsOver {
  runProcess?: SliceDeps['runProcess'];
  setupTooling?: SliceDeps['setupTooling'];
  tmpWorktreePath?: SliceDeps['tmpWorktreePath'];
  noTouchSet?: readonly string[];
  descriptor?: RunDescriptor | null;
  gitCalls?: string[][];
  spawn?: SliceDeps['spawn'];
  mutate?: SliceDeps['mutate'];
  warn?: SliceDeps['warn'];
}

let tmpCounter = 0;
function freshTmpPath(): string {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-tmp-parent-')));
  tmpCounter += 1;
  return path.join(parent, `wt-${tmpCounter}`);
}

// Builds real slice deps against `repo`, with the verify VERDICT (runProcess) and the
// throwaway-worktree tooling injected, and findings written through the real mutator
// confined under `reports`.
function sliceDeps(repo: string, reports: string, over: DepsOver = {}): SliceDeps {
  return {
    cwd: repo,
    descriptor: over.descriptor === undefined ? dummyDescriptor({ initial_head_sha: head(repo) }) : over.descriptor,
    deadline: createDeadline(900),
    reportsRootAbs: reports,
    noTouchSet: over.noTouchSet ?? [],
    spawn: over.spawn ?? realGitSpawn(over.gitCalls),
    runProcess: over.runProcess ?? (() => okVerdict),
    setupTooling: over.setupTooling ?? ((): void => {}),
    tmpWorktreePath: over.tmpWorktreePath ?? freshTmpPath,
    readFindings: (p) => readFindings(p),
    mutate:
      over.mutate ??
      ((p, fn, expectedRevision) => mutateFindings(p, { reportsRootAbs: reports }, fn, undefined, expectedRevision)),
    warn: over.warn ?? ((): void => {}),
  };
}

function findingsPathIn(reports: string): string {
  return path.join(reports, 'findings.json');
}

// ── GREEN / RED / operational verdicts ──────────────────────────────────────────

test('GREEN (runProcess ok): commit the staged slice with the trailer, status "fixed" + sha=HEAD, verification NULLED', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()], { verification: { sha: 'stale', scope: 'verify:fast', completed_at: 't' } }));

  const result = commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => okVerdict }));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.machineError, undefined);
  const committed = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.deepEqual(committed, ['src/app.ts'], 'exactly slice_files committed');
  assert.equal(lastLine(git(repo, ['log', '-1', '--format=%B'])), `${SLICE_TRAILER_KEY}: f-001`);
  const after = readFindings(fpath);
  assert.equal(after.findings[0]?.status, 'fixed');
  assert.equal(after.findings[0]?.sha, head(repo));
  assert.equal(after.verification, null, 'a slice commit invalidates the prior verification');
});

test('RED (runProcess red): status "fix-failed", NO commit (HEAD unmoved), no infra_error', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));

  const result = commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => redVerdict }));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(head(repo), before, 'no new commit on a red test');
  const after = readFindings(fpath).findings[0];
  assert.equal(after?.status, 'fix-failed');
  assert.equal(after?.infra_error, undefined, 'a red test carries no infra_error');
});

test('operational (runProcess operational): status "infra-blocked" + infra_error, NOT "fix-failed", NO commit', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));

  const result = commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => opVerdict }));

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(head(repo), before, 'no commit on an operational failure');
  const after = readFindings(fpath).findings[0];
  assert.equal(after?.status, 'infra-blocked', 'operational -> infra-blocked, never fix-failed');
  assert.ok((after?.infra_error ?? '').length > 0, 'infra_error records the operational cause');
});

test('validation-worktree teardown ALWAYS (setupTooling throws -> infra-blocked, tmp worktree removed)', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const tmp = freshTmpPath();
  const deps = sliceDeps(repo, reports, {
    tmpWorktreePath: () => tmp,
    setupTooling: () => {
      throw new Error('boom during tooling setup');
    },
  });

  const result = commitSlice('f-001', fpath, deps);

  assert.equal(result.exitCode, EXIT_OK);
  // A harness setup failure is operational, never a red test.
  assert.equal(readFindings(fpath).findings[0]?.status, 'infra-blocked');
  // The throwaway worktree was created then torn down in the finally, even on throw.
  const list = git(repo, ['worktree', 'list', '--porcelain']);
  assert.ok(!list.includes(tmp), 'the validation worktree is removed even when setup throws');
  assert.equal(fs.existsSync(tmp), false, 'the validation worktree dir no longer exists');
});

// ── test_ref resolution ─────────────────────────────────────────────────────────

test('test_ref resolution: verify:fast -> the validation run gets scope "--fast"; verify:full -> "--full"', () => {
  for (const [ref, expected] of [['verify:fast', '--fast'], ['verify:full', '--full']] as const) {
    const repo = repoWithEditedSlice();
    const reports = reportsRoot();
    const fpath = findingsPathIn(reports);
    writeV2(fpath, validFile([validFinding({ test_ref: ref })]));
    let seen: string[] = [];
    const deps = sliceDeps(repo, reports, {
      runProcess: (input) => {
        seen = input.argv;
        return okVerdict;
      },
    });
    assert.equal(commitSlice('f-001', fpath, deps).exitCode, EXIT_OK, ref);
    assert.ok(seen[0]?.endsWith('/verify'), 'the verify shim is the argv[0]');
    assert.equal(seen[1], expected, `${ref} -> ${expected}`);
  }
});

// ── Reconciliation (ancestry-bounded) ───────────────────────────────────────────

test('reconciliation: a slice commit in the run ancestry whose finding is still pending is repaired to fixed+sha before new work', () => {
  const repo = cleanRepo();
  const initial = head(repo);
  // A prior slice commit (crash between commit and findings write) sits in ancestry.
  const reconSha = commitWithTrailer(repo, 'src/recon.ts', 'export const r = 1;\n', 'f-recon');
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  // f-recon says pending; f-002 is ineligible (no-touch), so the flow stops right after
  // reconciliation — isolating reconciliation's effect.
  writeV2(
    fpath,
    validFile([
      validFinding({ id: 'f-recon', status: 'pending' }),
      validFinding({ id: 'f-002', status: 'no-touch', classification: 'no-touch' }),
    ]),
  );

  const result = commitSlice('f-002', fpath, sliceDeps(repo, reports, { descriptor: dummyDescriptor({ initial_head_sha: initial }) }));

  assert.equal(result.exitCode, EXIT_WRONG_STATE, 'f-002 is ineligible; refused after reconciliation');
  const recon = readFindings(fpath).findings.find((f) => f.id === 'f-recon');
  assert.equal(recon?.status, 'fixed', 'the crashed slice was reconciled to fixed');
  assert.equal(recon?.sha, reconSha, 'reconciled with the trailer commit sha');
});

test('reconciliation: a slice trailer OUTSIDE the run ancestry window (at/behind initial_head) is IGNORED', () => {
  const repo = cleanRepo();
  // The trailer commit becomes the run's initial HEAD, so `initial..HEAD` excludes it.
  const reconSha = commitWithTrailer(repo, 'src/recon.ts', 'export const r = 1;\n', 'f-recon');
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(
    fpath,
    validFile([
      validFinding({ id: 'f-recon', status: 'pending' }),
      validFinding({ id: 'f-002', status: 'no-touch', classification: 'no-touch' }),
    ]),
  );

  const result = commitSlice('f-002', fpath, sliceDeps(repo, reports, { descriptor: dummyDescriptor({ initial_head_sha: reconSha }) }));

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(readFindings(fpath).findings.find((f) => f.id === 'f-recon')?.status, 'pending', 'out-of-window trailer ignored');
});

// ── Gates (refuse BEFORE any commit / test spawn) ───────────────────────────────

test('descriptor gate: a null descriptor -> EXIT_DESCRIPTOR_MISMATCH, no mutation', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const result = commitSlice('f-001', fpath, sliceDeps(repo, reports, { descriptor: null }));
  assert.equal(result.exitCode, EXIT_DESCRIPTOR_MISMATCH);
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending');
});

test('mode gate: mode "review-only" -> EXIT_WRONG_STATE, no commit', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()], { mode: 'review-only' }));
  assert.equal(commitSlice('f-001', fpath, sliceDeps(repo, reports)).exitCode, EXIT_WRONG_STATE);
  assert.equal(head(repo), before);
});

test('eligibility gate: unknown id / non-pending / non-fixable -> EXIT_WRONG_STATE', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding({ status: 'fixed', sha: 'abc' })]));
  assert.equal(commitSlice('f-001', fpath, sliceDeps(repo, reports)).exitCode, EXIT_WRONG_STATE, 'non-pending');
  assert.equal(commitSlice('nope', fpath, sliceDeps(repo, reports)).exitCode, EXIT_WRONG_STATE, 'unknown id');
});

test('no-touch gate: an editable finding.file but a no-touch slice_files entry -> EXIT_WRONG_STATE, NO commit', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding({ slice_files: ['tools/danger.sh', 'src/app.ts'] })]));
  const result = commitSlice('f-001', fpath, sliceDeps(repo, reports, { noTouchSet: ['tools/**'] }));
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(head(repo), before, 'no commit');
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending', 'findings not mutated');
});

test('scope gate: a dirty path OUTSIDE slice_files -> refused BEFORE any test run / commit', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  fs.writeFileSync(path.join(repo, 'other.ts'), 'rogue\n'); // out-of-slice dirty
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  let ran = false;
  const result = commitSlice('f-001', fpath, sliceDeps(repo, reports, {
    runProcess: () => {
      ran = true;
      return okVerdict;
    },
  }));
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(ran, false, 'the validation run never happens on an out-of-slice dirty tree');
  assert.equal(head(repo), before, 'no commit');
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending');
});

test('scope gate: the engine\'s OWN worktree-tooling footprint (node_modules/.tools/submodule) is NOT out-of-slice dirt', () => {
  const repo = repoWithEditedSlice();
  // Simulate the footprint setupWorktreeTooling leaves in a consumer worktree: the
  // node_modules/.tools symlinks and the wired submodule surface as dirty because a
  // trailing-slash .gitignore (node_modules/, dist/) does not match a symlink.
  writeFileIn(repo, 'node_modules/pkg/index.js', 'x\n');
  writeFileIn(repo, '.tools/bin', 'x\n');
  writeFileIn(repo, 'vendor/dev-standards/runner/dist/x', 'x\n');
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const result = commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => okVerdict }));
  assert.equal(result.exitCode, EXIT_OK, 'tooling dirt does not block the slice');
  const committed = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.deepEqual(committed, ['src/app.ts'], 'only the slice is committed; tooling is never swept in');
  assert.equal(readFindings(fpath).findings[0]?.status, 'fixed');
});

test('path-safety gate: an unsafe slice_files path -> status "invalid", no commit', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  // Written through the raw JSON (findings-io would otherwise localize it to invalid on read);
  // the engine re-asserts safety as defense in depth.
  writeV2(fpath, validFile([validFinding({ slice_files: ['src/app.ts'] })]));
  // Force an unsafe path past the read validation by injecting a readFindings that returns it.
  const deps = { ...sliceDeps(repo, reports), readFindings: (): FindingsFileV2 => validFile([validFinding({ slice_files: ['../escape.ts', 'src/app.ts'] })]) };
  const result = commitSlice('f-001', fpath, deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(readFindings(fpath).findings[0]?.status, 'invalid', 'persisted invalid');
});

// ── Git failure + pathspec hardening ────────────────────────────────────────────

test('git failure on GREEN commit (pre-commit hook rejects) -> EXIT_FAILURE + machine error step "commit", no commit', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));

  const result = commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => okVerdict }));

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.machineError?.step, 'commit');
  assert.match(result.machineError?.command ?? '', /^git --literal-pathspecs commit\b/);
  assert.equal(head(repo), before, 'no commit landed');
  assert.equal(readFindings(fpath).findings[0]?.status, 'pending', 'findings not written on a git error');
});

test('pathspec hardening: the GREEN `add` and `commit` argvs begin with --literal-pathspecs', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const gitCalls: string[][] = [];
  assert.equal(commitSlice('f-001', fpath, sliceDeps(repo, reports, { gitCalls, runProcess: () => okVerdict })).exitCode, EXIT_OK);
  const addCall = gitCalls.find((a) => a.includes('add'));
  const commitCall = gitCalls.find((a) => a.includes('commit'));
  assert.equal(addCall?.[0], '--literal-pathspecs', 'add argv hardened');
  assert.equal(commitCall?.[0], '--literal-pathspecs', 'commit argv hardened');
});

// ── F2 CAS wiring / F6 index restore / F8 teardown budget ────────────────────────

function porcelain(repo: string): string {
  return git(repo, ['status', '--porcelain']);
}

// A spawn seam delegating to real git EXCEPT the validation-worktree teardown, forced to
// a non-zero exit so a case can drive the §F8 unconfirmed-teardown path.
function spawnFailingTeardown(): SliceDeps['spawn'] {
  const real = realGitSpawn();
  return (file, args, options) => {
    if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
      return { status: 1, stdout: '', stderr: 'fatal: cannot remove worktree' };
    }
    return real(file, args, options);
  };
}

test('F2: commit-slice CAS-guards the status write on the revision read at the START of the span', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()], { revision: 3 }));
  let seen: number | undefined = -1;
  const deps = sliceDeps(repo, reports, {
    runProcess: () => redVerdict,
    mutate: (p, fn, expectedRevision) => {
      seen = expectedRevision;
      return mutateFindings(p, { reportsRootAbs: reports }, fn, undefined, expectedRevision);
    },
  });
  assert.equal(commitSlice('f-001', fpath, deps).exitCode, EXIT_OK);
  assert.equal(seen, 3, 'the closing mutate is CAS-guarded on the step-1 revision');
});

test('F6 (a) RED with an UNSTAGED slice file: after refusal the index is untouched (porcelain byte-identical)', () => {
  const repo = repoWithEditedSlice(); // src/app.ts EDITED, unstaged
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const before = porcelain(repo);

  assert.equal(commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => redVerdict })).exitCode, EXIT_OK);

  assert.equal(porcelain(repo), before, 'the slice is NOT left staged after a red refusal');
  assert.equal(readFindings(fpath).findings[0]?.status, 'fix-failed');
});

test('F6 (b) RED with a PARTIALLY staged slice file (staged blob != worktree): the exact staged blob is restored', () => {
  const repo = initRepo();
  writeFileIn(repo, 'src/app.ts', ORIGINAL);
  git(repo, ['add', '--', 'src/app.ts']);
  git(repo, ['commit', '-q', '-m', 'init']);
  // Stage content A, then leave content B in the worktree (staged blob != worktree).
  fs.writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 10;\n');
  git(repo, ['add', '--', 'src/app.ts']);
  fs.writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 20;\n');
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const before = porcelain(repo);
  const stagedBlobBefore = git(repo, ['ls-files', '-s', '--', 'src/app.ts']);

  assert.equal(commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => redVerdict })).exitCode, EXIT_OK);

  assert.equal(porcelain(repo), before, 'porcelain byte-identical after refusal');
  assert.equal(git(repo, ['ls-files', '-s', '--', 'src/app.ts']), stagedBlobBefore, 'the exact staged blob is restored');
});

test('F6 (c) RED with an UNTRACKED new-file in the slice: it is force-removed from the index (back to untracked)', () => {
  const repo = repoWithEditedSlice(); // src/app.ts EDITED, unstaged
  fs.writeFileSync(path.join(repo, 'src/new.ts'), 'export const n = 1;\n'); // untracked
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding({ slice_files: ['src/app.ts', 'src/new.ts'] })]));
  const before = porcelain(repo);

  assert.equal(commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => redVerdict })).exitCode, EXIT_OK);

  assert.equal(porcelain(repo), before, 'the staged new file is unstaged back to untracked; porcelain identical');
  assert.equal(fs.existsSync(path.join(repo, 'src/new.ts')), true, 'the working-tree file is never removed');
});

test('F8: an unconfirmed validation-worktree teardown appends a suffix to infra_error (operational path)', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const deps = sliceDeps(repo, reports, { runProcess: () => opVerdict, spawn: spawnFailingTeardown() });

  assert.equal(commitSlice('f-001', fpath, deps).exitCode, EXIT_OK);

  const rec = readFindings(fpath).findings[0];
  assert.equal(rec?.status, 'infra-blocked');
  assert.match(rec?.infra_error ?? '', /validation worktree teardown failed/);
});

test('F8: a teardown failure on the RED path warns but does NOT change the fix-failed verdict', () => {
  const repo = repoWithEditedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const warnings: string[] = [];
  const deps = sliceDeps(repo, reports, {
    runProcess: () => redVerdict,
    spawn: spawnFailingTeardown(),
    warn: (m) => warnings.push(m),
  });

  assert.equal(commitSlice('f-001', fpath, deps).exitCode, EXIT_OK);

  assert.equal(readFindings(fpath).findings[0]?.status, 'fix-failed', 'verdict unchanged on the red path');
  assert.ok(warnings.some((w) => /teardown failed/.test(w)), 'the teardown failure is warned');
});

// ── §G3 unmerged (UU) index restore / §G6 green-path teardown warn ────────────────

// A repo whose src/app.ts carries a manufactured UNMERGED (UU) index entry — stages 1/2/3, exactly
// as a conflicted merge leaves it, but with NO active MERGE_HEAD (keeps the fixture deterministic).
function repoWithConflictedSlice(): string {
  const repo = initRepo();
  writeFileIn(repo, 'src/app.ts', 'export const a = 1;\n');
  git(repo, ['add', '--', 'src/app.ts']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const blob = (content: string): string => {
    const r = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content, encoding: 'utf8', shell: false });
    if (r.status !== 0) throw new Error(`hash-object failed: ${r.stderr ?? ''}`);
    return (r.stdout ?? '').trim();
  };
  const s1 = blob('export const a = 1;\n');
  const s2 = blob('export const a = 2;\n');
  const s3 = blob('export const a = 3;\n');
  const ZERO = '0'.repeat(40);
  // Remove the stage-0 entry then inject stages 1/2/3 in one --index-info stream.
  const info =
    `0 ${ZERO}\tsrc/app.ts\n` +
    `100644 ${s1} 1\tsrc/app.ts\n` +
    `100644 ${s2} 2\tsrc/app.ts\n` +
    `100644 ${s3} 3\tsrc/app.ts\n`;
  const r = spawnSync('git', ['update-index', '--index-info'], { cwd: repo, input: info, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`update-index failed: ${r.stderr ?? ''}`);
  // A plausible resolved working-tree file (the AI's edit the slice would stage).
  fs.writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 2;\n');
  return repo;
}

test('G3: RED with a conflicted (UU) slice file restores the unmerged stages 1/2/3 in the index', () => {
  const repo = repoWithConflictedSlice();
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const before = git(repo, ['ls-files', '-s', '--', 'src/app.ts']);
  assert.equal(before.trim().split('\n').length, 3, 'precondition: src/app.ts is unmerged (stages 1/2/3)');

  assert.equal(commitSlice('f-001', fpath, sliceDeps(repo, reports, { runProcess: () => redVerdict })).exitCode, EXIT_OK);

  assert.equal(readFindings(fpath).findings[0]?.status, 'fix-failed');
  assert.equal(
    git(repo, ['ls-files', '-s', '--', 'src/app.ts']),
    before,
    'the unmerged stages 1/2/3 are restored after a red refusal (git add had collapsed them to stage 0)',
  );
});

test('G6: a teardown failure on the GREEN path warns but still commits (verdict unchanged)', () => {
  const repo = repoWithEditedSlice();
  const before = head(repo);
  const reports = reportsRoot();
  const fpath = findingsPathIn(reports);
  writeV2(fpath, validFile([validFinding()]));
  const warnings: string[] = [];
  const deps = sliceDeps(repo, reports, {
    runProcess: () => okVerdict,
    spawn: spawnFailingTeardown(),
    warn: (m) => warnings.push(m),
  });

  assert.equal(commitSlice('f-001', fpath, deps).exitCode, EXIT_OK);

  assert.equal(readFindings(fpath).findings[0]?.status, 'fixed', 'the green commit still lands');
  assert.notEqual(head(repo), before, 'a commit was made');
  assert.ok(warnings.some((w) => /teardown failed/.test(w)), 'the green-path teardown failure is warned, not silent');
});

// ── realSliceDeps wiring ────────────────────────────────────────────────────────

test('realSliceDeps: threads cwd + ctx (descriptor/deadline/reportsRootAbs) + the no-touch set', () => {
  const deadline = createDeadline(900);
  const descriptor = dummyDescriptor();
  const d = realSliceDeps('/some/cwd', { canonicalRoot: '/some/cwd', reportsRootAbs: '/some/reports', deadline, descriptor }, ['tools/**']);
  assert.equal(d.cwd, '/some/cwd');
  assert.equal(d.reportsRootAbs, '/some/reports');
  assert.equal(d.descriptor, descriptor);
  assert.deepEqual(d.noTouchSet, ['tools/**']);
  assert.equal(typeof d.runProcess, 'function');
  assert.equal(typeof d.mutate, 'function');
});
