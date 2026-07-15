// E6 + Phase 5 §5.5 — the ADR-012 landing handoff. `decideHandoff` is a
// COMPLETENESS-GATE + INSTRUCTION-EMITTER: it refuses (EXIT_WRONG_STATE) while any
// finding is still HANDOFF_BLOCKING (pending / infra-blocked), or the verification
// stamp is missing / stale (sha != HEAD), or the worktree is dirty; otherwise it
// emits the standalone, human-opens-PR instruction. The resolved dispositions
// (no-touch / needs-plan / invalid) do NOT block. It lands nothing and names no merge
// verb; the ONLY effects are read-only git behind injected seams.
//
// The pure cases inject getBranch/getHead/getStatus stubs; a STATIC test pins the
// textual invariants; one CLI case drives a real ephemeral git repo end-to-end (with
// the git-side identity gate injected).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import type { FindingRecord, FindingsFileV2 } from '../../deep-review/src/types.ts';
import { decideHandoff, realHandoffDeps } from '../../deep-review/src/handoff.ts';
import type { HandoffDeps, HandoffGitSpawn } from '../../deep-review/src/handoff.ts';
import { createDeadline } from '../../deep-review/src/deadline.ts';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';
import type { DescriptorVerdict, RunDescriptor } from '../../deep-review/src/descriptor.ts';

const HEAD_SHA = 'a'.repeat(40);

// ── Findings builders (schema v2) ───────────────────────────────────────────────

function mkFinding(over: Partial<FindingRecord> = {}): FindingRecord {
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
    status: 'fixed',
    sha: 'abc123',
    ...over,
  };
}

function mkFile(findings: FindingRecord[], over: Partial<FindingsFileV2> = {}): FindingsFileV2 {
  return {
    schema: 2,
    mode: 'review-and-refactor',
    generated_at: '2026-06-14T00:00:00Z',
    run_id: 'run-1',
    base_sha: 'base-1',
    revision: 3,
    verification: { sha: HEAD_SHA, scope: 'verify:fast', completed_at: 't' },
    self_review: { sha: HEAD_SHA, verdict: 'clean', noted_at: 't' },
    findings,
    ...over,
  };
}

// A deps seam whose every read is counted so a test can prove exactly which effects ran.
function spyDeps(
  over: { branch?: string | (() => string); head?: string; status?: string } = {},
): { deps: HandoffDeps; calls: { getBranch: number; getHead: number; getStatus: number } } {
  const calls = { getBranch: 0, getHead: 0, getStatus: 0 };
  const branch = over.branch ?? 'deep-review/x';
  return {
    calls,
    deps: {
      cwd: '/repo',
      getBranch: () => {
        calls.getBranch += 1;
        return typeof branch === 'function' ? branch() : branch;
      },
      getHead: () => {
        calls.getHead += 1;
        return over.head ?? HEAD_SHA;
      },
      getStatus: () => {
        calls.getStatus += 1;
        return over.status ?? '';
      },
    },
  };
}

// ── Completeness gate matrix ─────────────────────────────────────────────────────

test('OK: all fixed + verification@HEAD + clean worktree -> standalone instruction; branch read last', () => {
  const { deps, calls } = spyDeps({ branch: 'deep-review/bar' });
  const result = decideHandoff(mkFile([mkFinding()]), deps);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.mode, 'standalone');
  const text = result.instruction ?? '';
  assert.ok(text.includes('committed branch'), 'describes a committed branch');
  assert.ok(text.includes('deep-review/bar'), 'names the branch');
  assert.ok(!text.includes('workflow ship') && !text.includes('workflow merge'), 'never names a removed verb');
  assert.equal(calls.getBranch, 1);
});

test('blocked: a PENDING finding -> EXIT_WRONG_STATE, message names it, no branch read', () => {
  const { deps, calls } = spyDeps();
  const result = decideHandoff(mkFile([mkFinding({ status: 'fixed' }), mkFinding({ id: 'f-002', status: 'pending', classification: 'fixable-now', sha: '' })]), deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /not terminal/);
  assert.match(result.machineError?.message ?? '', /f-002:pending/);
  assert.equal(calls.getBranch, 0, 'no landing instruction when blocked');
});

test('blocked: an INFRA-BLOCKED finding -> EXIT_WRONG_STATE', () => {
  const { deps } = spyDeps();
  const result = decideHandoff(mkFile([mkFinding({ id: 'f-x', status: 'infra-blocked', sha: '', infra_error: 'spawn ENOENT' })]), deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /not terminal/);
});

test('resolved dispositions do NOT block: no-touch / needs-plan / invalid only + verification@HEAD + clean -> OK', () => {
  const { deps } = spyDeps();
  const result = decideHandoff(
    mkFile([
      mkFinding({ id: 'a', status: 'no-touch', classification: 'no-touch', sha: '' }),
      mkFinding({ id: 'b', status: 'needs-plan', classification: 'needs-plan', sha: '' }),
      mkFinding({ id: 'c', status: 'invalid', sha: '' }),
    ]),
    deps,
  );
  assert.equal(result.exitCode, EXIT_OK, 'resolved dispositions are handed to a human, not blocked');
  const text = result.instruction ?? '';
  assert.ok(text.includes('no-touch: 1') && text.includes('needs-plan: 1') && text.includes('invalid: 1'), 'summary lists the dispositions');
});

test('blocked: verification == null -> EXIT_WRONG_STATE (run verify first)', () => {
  const { deps } = spyDeps();
  const result = decideHandoff(mkFile([mkFinding()], { verification: null }), deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /no verification/);
});

test('blocked: verification stale (sha != HEAD) -> EXIT_WRONG_STATE', () => {
  const { deps } = spyDeps({ head: 'b'.repeat(40) });
  const result = decideHandoff(mkFile([mkFinding()]), deps); // verification sha is HEAD_SHA (a…)
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /stale/);
});

test('blocked: self_review == null -> EXIT_WRONG_STATE', () => {
  const { deps, calls } = spyDeps();
  const result = decideHandoff(mkFile([mkFinding()], { self_review: null }), deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /self-review/);
  assert.equal(calls.getBranch, 0);
});

test('blocked: self_review verdict violation -> EXIT_WRONG_STATE', () => {
  const { deps } = spyDeps();
  const result = decideHandoff(
    mkFile([mkFinding()], { self_review: { sha: HEAD_SHA, verdict: 'violation', noted_at: 't' } }),
    deps,
  );
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /violation/);
});

test('blocked: self_review sha is stale -> EXIT_WRONG_STATE', () => {
  const { deps } = spyDeps();
  const result = decideHandoff(
    mkFile([mkFinding()], { self_review: { sha: 'b'.repeat(40), verdict: 'clean', noted_at: 't' } }),
    deps,
  );
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /self-review is stale/);
});

test('accepted: clean self_review at current HEAD satisfies the self-review handoff predicate', () => {
  const { deps } = spyDeps();
  const result = decideHandoff(mkFile([mkFinding()]), deps);
  assert.equal(result.exitCode, EXIT_OK);
});

test('blocked: a dirty worktree (git status --porcelain non-empty) -> EXIT_WRONG_STATE', () => {
  const { deps } = spyDeps({ status: ' M src/app.ts\n' });
  const result = decideHandoff(mkFile([mkFinding()]), deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /dirty/);
});

test('tooling-only dirt does NOT block handoff (engine-created node_modules/.tools/submodule symlinks)', () => {
  const { deps } = spyDeps({ status: '?? node_modules\n?? .tools\n M vendor/dev-standards\n' });
  const result = decideHandoff(mkFile([mkFinding()]), deps);
  assert.equal(result.exitCode, EXIT_OK, "the engine's own worktree-tooling footprint is not user dirt");
  assert.equal(result.mode, 'standalone');
});

test('tooling dirt PLUS a real dirty file still blocks handoff', () => {
  const { deps } = spyDeps({ status: '?? node_modules\n M src/app.ts\n' });
  const result = decideHandoff(mkFile([mkFinding()]), deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.machineError?.message ?? '', /dirty/);
});

// ── Mode gate + read failures ────────────────────────────────────────────────────

test('mode gate: a review-only findings file -> EXIT_WRONG_STATE before ANY git read', () => {
  const { deps, calls } = spyDeps();
  const result = decideHandoff(mkFile([mkFinding()], { mode: 'review-only' }), deps);
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(calls.getHead, 0, 'no git read when the mode gate refuses');
  assert.equal(calls.getStatus, 0);
});

test('getHead failure -> EXIT_FAILURE + machine error', () => {
  const deps: HandoffDeps = {
    cwd: '/repo',
    getBranch: () => 'deep-review/x',
    getHead: () => {
      throw new Error('fatal: not a git repository');
    },
    getStatus: () => '',
  };
  const result = decideHandoff(mkFile([mkFinding()]), deps);
  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.ok(result.machineError, 'machine error present');
});

test('getBranch failure on the success path -> EXIT_FAILURE + machine error step "rev-parse"', () => {
  const { deps } = spyDeps({
    branch: () => {
      throw new Error('fatal: not a git repository');
    },
  });
  const result = decideHandoff(mkFile([mkFinding()]), deps);
  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.machineError?.step, 'rev-parse');
});

// ── static source invariants ─────────────────────────────────────────────────────

test('static: the module SOURCE names neither "workflow merge" nor "workflow ship"', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../../deep-review/src/handoff.ts', import.meta.url)), 'utf8');
  assert.ok(!src.includes('workflow merge'), 'source never names the removed merge verb');
  assert.ok(!src.includes('workflow ship'), 'source never names the removed ship verb');
});

test('realHandoffDeps wires cwd + the real read seams', () => {
  const d = realHandoffDeps('/some/cwd');
  assert.equal(d.cwd, '/some/cwd');
  assert.equal(typeof d.getBranch, 'function');
  assert.equal(typeof d.getHead, 'function');
  assert.equal(typeof d.getStatus, 'function');
});

test('F7: realHandoffDeps bounds every git read with a deadline-derived timeout (<= 15s)', () => {
  const timeouts: Array<number | undefined> = [];
  const spawn: HandoffGitSpawn = (args, _cwd, timeout) => {
    timeouts.push(timeout);
    if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'deep-review/x\n', stderr: '' };
    if (args.includes('status')) return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
  };
  const d = realHandoffDeps('/repo', createDeadline(900), spawn);
  d.getHead();
  d.getStatus();
  d.getBranch();
  assert.ok(timeouts.length >= 3, 'each read seam spawned git');
  for (const t of timeouts) {
    assert.equal(typeof t, 'number', 'each git read is timeout-bounded');
    assert.ok((t as number) > 0 && (t as number) <= 15_000, 'timeout within the 15s cap');
  }
});

// ── CLI dispatch + real git ──────────────────────────────────────────────────────

const REPO_QUALITY = fileURLToPath(new URL('../../quality.json', import.meta.url));

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

test('CLI handoff: missing --findings -> EXIT_USAGE (before config / preflight)', () => {
  const errs: string[] = [];
  assert.equal(runCli(['handoff'], { stdout: () => {}, stderr: (t) => errs.push(t) }), EXIT_USAGE);
  assert.ok(errs.join('').includes('--findings'), 'usage names the missing flag');
});

test('CLI handoff (real git, complete run): all fixed + verification@HEAD + clean -> EXIT_OK, standalone instruction', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-handoff-')));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Handoff Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  const manifest = JSON.parse(fs.readFileSync(REPO_QUALITY, 'utf8')) as Record<string, unknown>;
  manifest['deep_review'] = { enabled: true, modes: ['review-only', 'review-and-refactor'], guides_dir: 'guides' };
  fs.writeFileSync(path.join(repo, 'quality.json'), JSON.stringify(manifest));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  const headSha = git(repo, ['rev-parse', 'HEAD']).trim();

  // Findings OUTSIDE the repo (handoff never mutates, so no confinement / dirtiness).
  const fpath = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-handoff-f-'))), 'findings.json');
  fs.writeFileSync(
    fpath,
    `${JSON.stringify(
      mkFile([mkFinding({ status: 'fixed' })], {
        verification: { sha: headSha, scope: 'verify:fast', completed_at: 't' },
        self_review: { sha: headSha, verdict: 'clean', noted_at: 't' },
      }),
      null,
      2,
    )}\n`,
  );

  const descriptor: RunDescriptor = {
    schema: 1, run_id: 'run-1', created_at: 't', canonical_root: repo, git_dir: path.join(repo, '.git'),
    git_common_dir: path.join(repo, '.git'), branch_ref: 'refs/heads/main', base_ref: 'refs/heads/main', base_sha: 'base-1', initial_head_sha: headSha,
  };
  const out: string[] = [];
  const cli: CliDeps = {
    stdout: (t) => out.push(t),
    stderr: () => {},
    cwd: () => repo,
    verifyDescriptor: (): DescriptorVerdict => ({ ok: true, descriptor }),
  };

  const code = runCli(['handoff', '--findings', fpath], cli);
  assert.equal(code, EXIT_OK);
  assert.ok(out.join('').includes('Landing mode: standalone'), 'standalone instruction printed');
  fs.rmSync(repo, { recursive: true, force: true });
});
