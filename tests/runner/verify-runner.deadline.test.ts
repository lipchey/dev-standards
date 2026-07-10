// RUN-02: one monotonic tier deadline bounds git/fileset probes and checks, so a
// slow/hung git can't blow past the tier budget, and the timeout surfaces as a
// structured error instead of a hang.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackedFiles } from '../../runner/src/git.ts';
import { runTier } from '../../runner/src/verify-runner.ts';
import type { Manifest } from '../../runner/src/types.ts';

// A fake `git` that ignores SIGTERM and hangs; killSignal SIGKILL + a bounded
// timeout must still reap it. Named `git` so a PATH prepend shadows the real one.
function writeFakeGit(dir: string): void {
  const file = path.join(dir, 'git');
  fs.writeFileSync(
    file,
    `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => process.exit(0), 5000);\n`,
  );
  fs.chmodSync(file, 0o755);
}

function withFakeGitOnPath<T>(fn: (gitDir: string) => T): T {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-slowgit-'));
  const savedPath = process.env.PATH;
  try {
    writeFakeGit(gitDir);
    process.env.PATH = `${gitDir}${path.delimiter}${savedPath ?? ''}`;
    return fn(gitDir);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    repo: 'tmp',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 300, fast_seconds: 300, full_seconds: 300, audit_seconds: 300 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: false,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [],
    tiers: { staged: [], fast: [], full: [], audit: [] },
    ...overrides,
  };
}

test('git probe times out into a structured error; SIGTERM-ignoring git is SIGKILLed (RUN-02)', () => {
  withFakeGitOnPath(() => {
    const started = Date.now();
    assert.throws(() => trackedFiles(process.cwd(), 150), /timed out/i);
    // Must not wait for the fake git's 5s sleep; SIGKILL bounded it near the 150ms timeout.
    assert.ok(Date.now() - started < 2000, 'git probe ignored the remaining-time timeout');
  });
});

test('an empty tier with a slow git trips the deadline instead of hanging (RUN-02)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-deadline-'));
  try {
    withFakeGitOnPath(() => {
      const m = manifest({
        budgets: { staged_seconds: 300, fast_seconds: 0.2, full_seconds: 300, audit_seconds: 300 },
        filesets: [{ name: 'repo_ts', source: 'repo_all', include: ['**/*.ts'], exclude: [] }],
        tiers: { staged: [], fast: [], full: [], audit: [] },
      });
      const started = Date.now();
      assert.throws(() => runTier(m, root, 'fast'), /timed out|budget|deadline/i);
      assert.ok(Date.now() - started < 2500, 'runTier hung on the slow git instead of honoring the deadline');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
