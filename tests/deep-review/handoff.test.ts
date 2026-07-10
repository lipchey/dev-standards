// E6 — the ADR-012 landing handoff. `decideHandoff` is a CONTEXT-DETECT +
// INSTRUCTION-EMITTER ONLY: it lands nothing, names no merge verb, and always lands
// the standalone way — a committed `deep-review/<slug>` branch left for a human to
// open as a PR (that branch has no workflow feature record). The ONLY effect it
// performs is a read-only branch lookup behind the injected `getBranch` seam.
//
// These tests are mostly pure (injected `getBranch` stub); one CLI case drives a
// real ephemeral git repo to prove the dispatch wiring + the real `getBranch` seam
// end-to-end. A STATIC test reads the module source from disk and pins the two
// textual invariants the engine MUST never violate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import type { FindingRecord, FindingsFile } from '../../deep-review/src/types.ts';
import { decideHandoff, realHandoffDeps } from '../../deep-review/src/handoff.ts';
import type { HandoffDeps } from '../../deep-review/src/handoff.ts';
import { writeFindings } from '../../deep-review/src/findings-io.ts';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';

// ── Findings builders ─────────────────────────────────────────────────────────

function mkFinding(over: Partial<FindingRecord> = {}): FindingRecord {
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

function mkFile(
  findings: FindingRecord[],
  mode: FindingsFile['mode'] = 'review-and-refactor',
): FindingsFile {
  return { schema: 1, mode, generated_at: '2026-06-14T00:00:00Z', findings };
}

// A deps seam whose every read is counted, so a test can prove EXACTLY which
// effects ran (only `getBranch` exists on HandoffDeps; counting it proves it is the
// ONLY git read and that nothing mutating is reached).
function spyDeps(
  over: { branch?: string | (() => string); cwd?: string } = {},
): { deps: HandoffDeps; calls: { getBranch: number } } {
  const calls = { getBranch: 0 };
  const branch = over.branch ?? 'deep-review/x';
  const deps: HandoffDeps = {
    cwd: over.cwd ?? '/repo',
    getBranch: () => {
      calls.getBranch += 1;
      return typeof branch === 'function' ? branch() : branch;
    },
  };
  return { deps, calls };
}

// ── standalone (always) ─────────────────────────────────────────────────────────

test('standalone: mode "standalone"; committed branch left for a human PR; NEVER "workflow ship", NEVER "workflow merge"; only the branch read runs', () => {
  const { deps, calls } = spyDeps({ branch: 'deep-review/bar' });

  const result = decideHandoff(mkFile([mkFinding()]), deps);

  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.mode, 'standalone');
  assert.equal(result.machineError, undefined);
  const text = result.instruction ?? '';
  assert.ok(text.includes('committed branch'), 'describes a committed branch');
  assert.ok(text.includes('human'), 'names a human as the actor');
  assert.ok(text.includes('PR'), 'names a PR');
  assert.ok(text.includes('deep-review/bar'), 'names the branch');
  // deep-review must NEVER suggest the automated ship cycle (no feature record).
  assert.ok(!text.includes('workflow ship'), 'never suggests workflow ship');
  assert.ok(!text.includes('workflow merge'), 'never names the removed merge verb');
  // Only the branch read ran; nothing mutating exists on HandoffDeps and none was reached.
  assert.equal(calls.getBranch, 1, 'branch read ran once');
});

// ── mode gate ───────────────────────────────────────────────────────────────────

test('mode gate: a review-only findings file -> EXIT_WRONG_STATE before any getBranch call', () => {
  const { deps, calls } = spyDeps({ branch: 'deep-review/x' });

  const result = decideHandoff(mkFile([mkFinding()], 'review-only'), deps);

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(result.mode, undefined);
  assert.equal(result.instruction, undefined);
  assert.equal(calls.getBranch, 0, 'getBranch NOT invoked when mode gate refuses');
});

// ── findings status summary ─────────────────────────────────────────────────────

test('the emitted instruction summarizes findings status (fixed count + rejected buckets)', () => {
  const findings = [
    mkFinding({ id: 'a', status: 'fixed' }),
    mkFinding({ id: 'b', status: 'fixed' }),
    mkFinding({ id: 'c', status: 'no-touch', classification: 'no-touch' }),
    mkFinding({ id: 'd', status: 'needs-plan', classification: 'needs-plan' }),
    mkFinding({ id: 'e', status: 'fix-failed' }),
    mkFinding({ id: 'g', status: 'invalid' }),
  ];
  const { deps } = spyDeps({ branch: 'deep-review/foo' });

  const text = decideHandoff(mkFile(findings), deps).instruction ?? '';

  assert.ok(text.includes('fixed: 2'), 'fixed count present');
  assert.ok(text.includes('no-touch: 1'), 'no-touch count present');
  assert.ok(text.includes('needs-plan: 1'), 'needs-plan count present');
  assert.ok(text.includes('fix-failed: 1'), 'fix-failed count present');
  assert.ok(text.includes('invalid: 1'), 'invalid count present');
});

// ── branch comes from the injected seam ─────────────────────────────────────────

test('branch comes from the injected getBranch() seam (appears verbatim in the standalone instruction)', () => {
  const { deps } = spyDeps({ branch: 'deep-review/known-branch' });

  const text = decideHandoff(mkFile([mkFinding()]), deps).instruction ?? '';

  assert.ok(text.includes('deep-review/known-branch'), 'the seam-provided branch is used');
});

// ── getBranch failure ───────────────────────────────────────────────────────────

test('getBranch failure (stub throws) -> EXIT_FAILURE + machine error naming step "rev-parse"', () => {
  const { deps } = spyDeps({
    branch: () => {
      throw new Error('fatal: not a git repository');
    },
  });

  const result = decideHandoff(mkFile([mkFinding()]), deps);

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.ok(result.machineError, 'machine error present');
  assert.equal(result.machineError?.step, 'rev-parse');
  assert.equal(result.instruction, undefined);
});

test('getBranch fail-closed (real git, detached HEAD): the REAL defaultGetBranch refuses an unresolvable branch -> EXIT_FAILURE + machine error step "rev-parse"', () => {
  // Exercises the real seam (not the stub): a detached HEAD makes
  // `git rev-parse --abbrev-ref HEAD` resolve to the sentinel "HEAD", which
  // defaultGetBranch's fail-closed guard rejects, surfacing the §2.4 git error.
  const repo = initRepoOnMain();
  git(repo, ['checkout', '--detach']);

  const result = decideHandoff(mkFile([mkFinding({ status: 'fixed' })]), realHandoffDeps(repo));

  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.ok(result.machineError, 'machine error present');
  assert.equal(result.machineError?.step, 'rev-parse');
  assert.equal(result.instruction, undefined);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── static source + runtime text invariants ────────────────────────────────────

test('static: the module SOURCE names neither "workflow merge" nor "workflow ship"; the runtime output names neither', () => {
  // After D2 the in-session ship cycle is gone: the SOURCE must never name the
  // removed merge verb OR the automated ship verb anywhere (comments included).
  const src = fs.readFileSync(
    fileURLToPath(new URL('../../deep-review/src/handoff.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(!src.includes('workflow merge'), 'source never names the removed merge verb');
  assert.ok(!src.includes('workflow ship'), 'source never names the removed ship verb');
  const { deps } = spyDeps({ branch: 'deep-review/z' });
  const standalone = decideHandoff(mkFile([mkFinding()]), deps).instruction ?? '';
  assert.ok(!standalone.includes('workflow ship'), 'runtime output never suggests workflow ship');
  assert.ok(!standalone.includes('workflow merge'), 'runtime output never names the removed merge verb');
});

// ── CLI dispatch + real getBranch seam (real ephemeral git repo) ───────────────

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

function initRepoOnMain(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-handoff-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Handoff Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(dir, ['branch', '-m', 'main']);
  return dir;
}

test('CLI handoff: missing --findings -> EXIT_USAGE', () => {
  const out: string[] = [];
  const errs: string[] = [];
  const cli: CliDeps = { stdout: (t) => out.push(t), stderr: (t) => errs.push(t) };
  assert.equal(runCli(['handoff'], cli), EXIT_USAGE);
  assert.ok(errs.join('').includes('--findings'), 'usage names the missing flag');
});

test('CLI handoff (real git, standalone): prints the standalone instruction with the real branch; exit 0', () => {
  const repo = initRepoOnMain();
  const fpath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-handoff-f-')), 'findings.json');
  writeFindings(fpath, mkFile([mkFinding({ status: 'fixed' })]));

  const out: string[] = [];
  const errs: string[] = [];
  const cli: CliDeps = { stdout: (t) => out.push(t), stderr: (t) => errs.push(t), cwd: () => repo };

  const code = runCli(['handoff', '--findings', fpath], cli);

  assert.equal(code, EXIT_OK);
  const text = out.join('');
  assert.ok(text.includes('Landing mode: standalone'), 'standalone instruction printed');
  assert.ok(text.includes('main'), 'the real HEAD branch (main) appears');
  assert.ok(!text.includes('workflow ship'), 'standalone never suggests workflow ship');
  assert.ok(!text.includes('workflow merge'), 'no merge verb');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('realHandoffDeps wires cwd + the real getBranch seam', () => {
  const d = realHandoffDeps('/some/cwd');
  assert.equal(d.cwd, '/some/cwd');
  assert.equal(typeof d.getBranch, 'function');
});
