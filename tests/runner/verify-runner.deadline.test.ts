// RUN-02: one monotonic tier deadline bounds git/fileset probes and checks, so a
// slow/hung git can't blow past the tier budget, and the timeout surfaces as a
// structured error instead of a hang.
import './helpers/telemetry-off.ts'; // MUST be first: default the sink off for direct (non-npm) runs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
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

// FIX #5: a git probe that spawns a descendant must have its WHOLE group reaped on
// timeout, so no grandchild outlives the tier and keeps mutating the repo (mirrors
// the exec.ts RUN-01 tree-kill). `git` spawns a grandchild that writes `marker`
// after `writeAfterMs`, then (for the kill case) ignores SIGTERM and hangs. The
// marker path is passed as argv, never interpolated into the -e string (its quotes
// would otherwise terminate the literal and the grandchild would never run).
function writeFakeGitWithGrandchild(dir: string, marker: string, writeAfterMs: number, hangMs: number): void {
  const file = path.join(dir, 'git');
  fs.writeFileSync(
    file,
    `#!${process.execPath}\n` +
      "const { spawn } = require('node:child_process');\n" +
      `spawn(process.execPath, ['-e', 'setTimeout(()=>require("fs").writeFileSync(process.argv[1],"x"),${writeAfterMs})', ${JSON.stringify(
        marker,
      )}], { stdio: 'ignore' });\n` +
      "process.on('SIGTERM', () => {});\n" +
      `setTimeout(() => process.exit(0), ${hangMs});\n`,
  );
  fs.chmodSync(file, 0o755);
}

function withFakeGitDir<T>(gitDir: string, fn: () => T): T {
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${gitDir}${path.delimiter}${savedPath ?? ''}`;
    return fn();
  } finally {
    process.env.PATH = savedPath;
  }
}

test('FIX #5: a timed-out git probe leaves no surviving grandchild (whole group reaped)', async () => {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-gitreap-'));
  const marker = path.join(gitDir, 'marker');
  try {
    // Grandchild would write at ~2s; probe times out at 150ms and reaps the group.
    writeFakeGitWithGrandchild(gitDir, marker, 2000, 60000);
    withFakeGitDir(gitDir, () => {
      assert.throws(() => trackedFiles(process.cwd(), 150), /timed out/i);
    });
    await delay(2500);
    assert.equal(
      fs.existsSync(marker),
      false,
      'grandchild survived the git-probe timeout — process group was not reaped',
    );
  } finally {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
});

test('FIX #5 control: the grandchild marker really writes when the git probe is NOT killed', async () => {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-gitreap-ctl-'));
  const marker = path.join(gitDir, 'marker');
  try {
    // Grandchild writes at 100ms; git exits at 300ms; generous timeout → no kill.
    writeFakeGitWithGrandchild(gitDir, marker, 100, 300);
    withFakeGitDir(gitDir, () => {
      // A fake git that exits 0 with no output → trackedFiles returns [].
      assert.deepEqual(trackedFiles(process.cwd(), 30000), []);
    });
    await delay(300);
    assert.equal(fs.existsSync(marker), true, 'grandchild should have written its marker when not killed');
  } finally {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
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

// FIX #2: a tier with ZERO checks whose fileset expansion succeeds but crosses the
// deadline must fail closed, not write a report and return 0. The injected clock lets
// git succeed (huge remaining) yet reports the deadline already spent right after the
// expansion, isolating the post-expansion budget check from real timing.
test('FIX #2: a 0-check tier fails closed once the deadline is spent after fileset expansion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-emptytier-'));
  try {
    execFileSync('git', ['init', root], { stdio: 'ignore' }); // real repo → git ls-files exits 0
    const budgetMs = 300 * 1000;
    let n = 0;
    // startedAt and the single fileset's git-timeout sample read 0 (remaining = full budget,
    // so git succeeds); the after-expansion check reads past the deadline.
    const clock = (): number => (n++ < 2 ? 0 : budgetMs + 1);
    const m = manifest({
      filesets: [{ name: 'repo_ts', source: 'repo_all', include: ['**/*.ts'], exclude: [] }],
      tiers: { staged: [], fast: [], full: [], audit: [] }, // ZERO checks
    });
    assert.throws(() => runTier(m, root, 'fast', clock), /budget exceeded|deadline/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
