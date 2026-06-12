import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../workflow/src/cli.ts';
import type { CliIO } from '../../workflow/src/cli.ts';
import { serializeFrontMatter, parseFrontMatter } from '../../workflow/src/front-matter.ts';
import { realLockSeams } from '../../workflow/src/lock.ts';
import { splitPlanningFile } from '../../workflow/src/recover.ts';
import { runGit, withWorkflowPhaseTrailer } from '../../workflow/src/trailers.ts';
import type { FrontMatter } from '../../workflow/src/types.ts';
import { EXIT_FAILURE } from '../../workflow/src/types.ts';

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-hooks-'));
  runGit(['init', '-q'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Workflow Test'], dir);
  runGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function fm(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'demo',
    branch: 'feature/demo',
    worktree: '../demo',
    base: 'main',
    base_sha: '0'.repeat(40),
    cmux_section: 'demo',
    state: 'created',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: '',
    updated: '2026-06-12T00:00:00Z',
    phases: {},
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

function seed(dir: string, overrides: Partial<FrontMatter> = {}): string {
  const planningPath = path.join(dir, 'workflow-session-planning.md');
  const frontMatter = fm(overrides);
  fs.writeFileSync(planningPath, `${serializeFrontMatter(frontMatter)}\n# Plan\n`);
  runGit(['add', '--', 'workflow-session-planning.md'], dir);
  runGit(['commit', '-q', '-m', withWorkflowPhaseTrailer('seed', frontMatter.state)], dir);
  return planningPath;
}

function installFailingHook(dir: string): void {
  const hooksDir = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho hook says no 1>&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
}

function readFm(planningPath: string): FrontMatter {
  return parseFrontMatter(splitPlanningFile(fs.readFileSync(planningPath, 'utf8')).frontMatterText);
}

function io(dir: string): { io: CliIO; err: () => string } {
  const err: string[] = [];
  return {
    io: {
      cwd: () => dir,
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      writeFile: (p, c) => fs.writeFileSync(p, c),
      runGit,
      stdout: () => {},
      stderr: (t) => err.push(t),
      now: () => Date.parse('2026-06-12T00:01:00Z'),
      claimedBy: 'pane-1:claude',
    },
    err: () => err.join(''),
  };
}

test('hook-rejection-sets-phase-failed-with-captured-output', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    installFailingHook(dir);
    const cap = io(dir);
    const code = runCli(['start', 'plan', '--file', planningPath], cap.io, realLockSeams());

    assert.equal(code, EXIT_FAILURE);
    assert.equal(readFm(planningPath).state, 'plan-failed');
    assert.match(cap.err(), /hook says no/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-blind-retry-after-rejection', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    installFailingHook(dir);
    const cap = io(dir);
    runCli(['start', 'plan', '--file', planningPath], cap.io, realLockSeams());
    const commits = Number(runGit(['rev-list', '--count', 'HEAD'], dir).trim());
    assert.equal(commits, 2, 'seed plus one failed-state commit; no hidden retry loop');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planning-commits-run-hook-surface', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir, {
      state: 'plan-inprogress',
      claimed_by: 'pane-1:claude',
      phases: { plan: { last_success_loop: null, attempts: 1, start_sha: '0'.repeat(40), complete_sha: null } },
    });
    installFailingHook(dir);
    const cap = io(dir);
    const code = runCli(['complete', 'plan', '--file', planningPath], cap.io, realLockSeams());
    assert.equal(code, EXIT_FAILURE);
    assert.equal(readFm(planningPath).state, 'plan-failed');
    assert.match(cap.err(), /hook says no/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

