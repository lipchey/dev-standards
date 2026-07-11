// CLI dispatch — the §2.4 machine-error boundary + the §5.0 preflight gate + the §5.2
// run-identity gate.
//
// The findings file and quality manifest are UNTRUSTED: a malformed JSON, a bad enum,
// or a missing/invalid quality.json must NEVER escape a handler as a raw stack trace +
// exit 1 — they become a §2.4 `{ "error": { … } }` object as the LAST stderr line +
// EXIT_FAILURE.
//
// §5.0 preflight gates select-worktree / commit-slice / verify / handoff (AFTER
// argv/usage validation, BEFORE the engine). §5.2 then runs the identity gate on the
// three fix verbs (commit-slice / verify / handoff): the git-side descriptor gate
// (injected here via `verifyDescriptor` so the matrix is unit-testable) + the findings
// binding check. Any divergence -> EXIT_DESCRIPTOR_MISMATCH before any mutation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';
import { EXIT_FAILURE, EXIT_USAGE, EXIT_PREFLIGHT, EXIT_DESCRIPTOR_MISMATCH } from '../../deep-review/src/types.ts';
import type { MachineError } from '../../deep-review/src/types.ts';
import type { DescriptorVerdict, RunDescriptor } from '../../deep-review/src/descriptor.ts';

const REPO_QUALITY = fileURLToPath(new URL('../../quality.json', import.meta.url));
// The canonical guide set the §5.0 preflight requires — the real templates dir the engine itself
// resolves from import.meta.url (both this test file and the src sit at depth 2 from the repo root).
const TEMPLATES_DIR = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-cli-')));
}

// A temp repo whose quality.json passes the §5.0 preflight (fix-mode enabled + allowed
// + a guides dir holding the FULL canonical set), with the reports root created (findings live
// under it).
function dirWithFixMode(over: Record<string, unknown> = {}): string {
  const dir = tmpDir();
  const manifest = JSON.parse(fs.readFileSync(REPO_QUALITY, 'utf8')) as Record<string, unknown>;
  manifest['deep_review'] = {
    enabled: true,
    modes: ['review-only', 'review-and-refactor'],
    guides_dir: 'guides',
    ...over,
  };
  fs.writeFileSync(path.join(dir, 'quality.json'), JSON.stringify(manifest));
  fs.mkdirSync(path.join(dir, 'guides'), { recursive: true });
  // Seed every canonical guide by NAME (empty is fine — preflight checks availability, not content).
  for (const name of fs.readdirSync(TEMPLATES_DIR).filter((n) => n.endsWith('.md'))) {
    fs.writeFileSync(path.join(dir, 'guides', name), '');
  }
  fs.mkdirSync(path.join(dir, 'reports', 'quality'), { recursive: true });
  return dir;
}

// A valid v2 findings file under reports/quality; `over` tweaks run_id/base_sha/etc.
function writeFindings(dir: string, over: Record<string, unknown> = {}): string {
  const fpath = path.join(dir, 'reports', 'quality', 'findings.json');
  fs.writeFileSync(
    fpath,
    `${JSON.stringify(
      { schema: 2, mode: 'review-and-refactor', generated_at: 't', run_id: 'run-1', base_sha: 'base-1', revision: 0, verification: null, findings: [], ...over },
      null,
      2,
    )}\n`,
  );
  return fpath;
}

function descriptor(over: Partial<RunDescriptor> = {}): RunDescriptor {
  return {
    schema: 1,
    run_id: 'run-1',
    created_at: 't',
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

function capture(cwd: string, verifyDescriptor?: (c: string) => DescriptorVerdict): { deps: CliDeps; errLines: () => string[] } {
  const err: string[] = [];
  const deps: CliDeps = { stdout: () => {}, stderr: (t) => err.push(t), cwd: () => cwd, warn: () => {} };
  if (verifyDescriptor !== undefined) deps.verifyDescriptor = verifyDescriptor;
  return { deps, errLines: () => err.join('').split('\n').filter((l) => l.length > 0) };
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

// ── §2.4 machine-error boundary (review-only path, not preflight-gated) ────────

test('check-path with no resolvable quality.json -> EXIT_FAILURE + a machine-error JSON last stderr line', () => {
  const dir = tmpDir();
  const cap = capture(dir);
  const code = runCli(['check-path', 'src/app.ts'], cap.deps);
  assert.equal(code, EXIT_FAILURE);
  assert.match(lastError(cap.errLines()).command, /deep-review check-path/);
});

// ── §5.0 preflight gate (runs BEFORE the identity gate) ────────────────────────

test('preflight: commit-slice with fix-mode DISABLED -> EXIT_PREFLIGHT (before any identity gate)', () => {
  const dir = dirWithFixMode({ enabled: false });
  const fpath = writeFindings(dir);
  const cap = capture(dir);
  const code = runCli(['commit-slice', 'f-001', '--findings', fpath], cap.deps);
  assert.equal(code, EXIT_PREFLIGHT);
  const error = lastError(cap.errLines());
  assert.equal(error.command, 'deep-review commit-slice');
  assert.match(error.message, /disabled|enabled/);
});

test('preflight ORDER: commit-slice with a MISSING finding-id -> EXIT_USAGE even when fix-mode is disabled', () => {
  const dir = dirWithFixMode({ enabled: false });
  const cap = capture(dir);
  const code = runCli(['commit-slice', '--findings', path.join(dir, 'reports', 'quality', 'f.json')], cap.deps);
  assert.equal(code, EXIT_USAGE);
});

test('preflight ORDER: select-worktree --slug ../evil -> EXIT_USAGE even with fix-mode disabled', () => {
  const cap = capture(dirWithFixMode({ enabled: false }));
  assert.equal(runCli(['select-worktree', '--slug', '../evil'], cap.deps), EXIT_USAGE);
});

test('preflight ORDER: select-worktree with a missing --slug -> EXIT_USAGE', () => {
  const cap = capture(dirWithFixMode({ enabled: false }));
  assert.equal(runCli(['select-worktree'], cap.deps), EXIT_USAGE);
});

// ── §5.2 identity-mismatch matrix (commit-slice / verify / handoff) ────────────

test('identity: verifyDescriptor refuses (root/branch mismatch) -> EXIT_DESCRIPTOR_MISMATCH before any mutation', () => {
  const dir = dirWithFixMode();
  const fpath = writeFindings(dir);
  const cap = capture(dir, () => ({ ok: false, reason: 'canonical root mismatch: worktree moved' }));
  const code = runCli(['commit-slice', 'f-001', '--findings', fpath], cap.deps);
  assert.equal(code, EXIT_DESCRIPTOR_MISMATCH);
  assert.match(lastError(cap.errLines()).message, /root mismatch/);
});

test('identity: findings run_id != descriptor.run_id -> EXIT_DESCRIPTOR_MISMATCH', () => {
  const dir = dirWithFixMode();
  const fpath = writeFindings(dir, { run_id: 'run-1', base_sha: 'base-1' });
  const cap = capture(dir, () => ({ ok: true, descriptor: descriptor({ run_id: 'run-OTHER' }) }));
  assert.equal(runCli(['commit-slice', 'f-001', '--findings', fpath], cap.deps), EXIT_DESCRIPTOR_MISMATCH);
  assert.match(lastError(cap.errLines()).message, /identity mismatch/);
});

test('identity: findings base_sha != descriptor.base_sha -> EXIT_DESCRIPTOR_MISMATCH', () => {
  const dir = dirWithFixMode();
  const fpath = writeFindings(dir, { run_id: 'run-1', base_sha: 'base-1' });
  const cap = capture(dir, () => ({ ok: true, descriptor: descriptor({ base_sha: 'base-OTHER' }) }));
  assert.equal(runCli(['commit-slice', 'f-001', '--findings', fpath], cap.deps), EXIT_DESCRIPTOR_MISMATCH);
});

test('identity: UNBOUND findings (run_id null) -> EXIT_DESCRIPTOR_MISMATCH (no path to a fix verb until classify binds)', () => {
  const dir = dirWithFixMode();
  const fpath = writeFindings(dir, { run_id: null, base_sha: null });
  const cap = capture(dir, () => ({ ok: true, descriptor: descriptor() }));
  assert.equal(runCli(['commit-slice', 'f-001', '--findings', fpath], cap.deps), EXIT_DESCRIPTOR_MISMATCH);
  assert.match(lastError(cap.errLines()).message, /unbound/);
});

test('identity mismatch also gates verify and handoff', () => {
  const dir = dirWithFixMode();
  const fpath = writeFindings(dir);
  const fail = (): DescriptorVerdict => ({ ok: false, reason: 'branch mismatch' });
  assert.equal(runCli(['verify', '--findings', fpath], capture(dir, fail).deps), EXIT_DESCRIPTOR_MISMATCH);
  assert.equal(runCli(['handoff', '--findings', fpath], capture(dir, fail).deps), EXIT_DESCRIPTOR_MISMATCH);
});

// ── commit-slice past the identity gate ────────────────────────────────────────

test('commit-slice: identity OK but a malformed findings file -> EXIT_FAILURE + {error} last stderr line', () => {
  const dir = dirWithFixMode();
  const fpath = path.join(dir, 'reports', 'quality', 'findings.json');
  fs.writeFileSync(fpath, '{ this is not valid json');
  const cap = capture(dir, () => ({ ok: true, descriptor: descriptor() }));
  const code = runCli(['commit-slice', 'f-001', '--findings', fpath], cap.deps);
  assert.equal(code, EXIT_FAILURE);
  assert.match(lastError(cap.errLines()).command, /deep-review commit-slice/);
});

test('commit-slice: identity OK + bound findings but NO project-facts -> EXIT_PREFLIGHT (fail-closed fix-mode no-touch build)', () => {
  const dir = dirWithFixMode();
  const fpath = writeFindings(dir); // bound to run-1 / base-1
  const cap = capture(dir, () => ({ ok: true, descriptor: descriptor() }));
  const code = runCli(['commit-slice', 'f-001', '--findings', fpath], cap.deps);
  assert.equal(code, EXIT_PREFLIGHT, 'a missing project-facts fails closed rather than a silent baseline');
  assert.match(lastError(cap.errLines()).message, /no-touch source|project-facts|could not read/);
});

// ── §F11 review-only ref confinement ───────────────────────────────────────────

test('F11: classify (review-only) rejects a no_touch_globs_ref that ESCAPES the repo root (never a silent baseline)', () => {
  const dir = dirWithFixMode({ no_touch_globs_ref: '.agents/facts.md' });
  // The ref is a clean in-repo path, but on disk it is a SYMLINK escaping the repo root,
  // so realpath resolves outside — the confinement (now enforced in review-only too) must reject it.
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  const outside = path.join(path.dirname(dir), 'escaping-facts.md');
  fs.writeFileSync(outside, '## No-Touch Zones\n- `x/**`\n');
  fs.symlinkSync(outside, path.join(dir, '.agents', 'facts.md'));

  const cap = capture(dir);
  const code = runCli(['classify', '--findings', path.join(dir, 'reports', 'quality', 'findings.json')], cap.deps);

  assert.notEqual(code, 0, 'classify must NOT succeed on an escaping ref');
  assert.match(cap.errLines().join('\n'), /outside the repo root/);
});
