import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertCleanAtImplementStart,
  commitScopeForImplement,
  CommitScopeError,
  planningRelPath,
  worktreeChangesExcept,
} from '../../workflow/src/commit-scope.ts';
import { runGit } from '../../workflow/src/trailers.ts';

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-scope-'));
  runGit(['init', '-q'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Workflow Test'], dir);
  fs.writeFileSync(path.join(dir, 'workflow-session-planning.md'), 'plan\n');
  fs.writeFileSync(path.join(dir, 'src.txt'), 'v1\n');
  runGit(['add', '--', 'workflow-session-planning.md', 'src.txt'], dir);
  runGit(['commit', '-q', '-m', 'seed'], dir);
  return dir;
}

test('planning-phase-commits-exactly-planning-file', () => {
  const dir = initRepo();
  try {
    assert.equal(planningRelPath(dir, path.join(dir, 'workflow-session-planning.md')), 'workflow-session-planning.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('implement-requires-clean-tree-at-start', () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'src.txt'), 'dirty\n');
    assert.throws(() => assertCleanAtImplementStart(dir, runGit), CommitScopeError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('implement-stages-changed-since-start-sha-minus-exclusions', () => {
  const dir = initRepo();
  try {
    const startSha = runGit(['rev-parse', 'HEAD'], dir).trim();
    fs.writeFileSync(path.join(dir, 'src.txt'), 'v2\n');
    fs.writeFileSync(path.join(dir, 'debug.log'), 'noise\n');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'noise\n');
    const scope = commitScopeForImplement(dir, 'workflow-session-planning.md', startSha, ['*.log', '.DS_Store'], runGit);
    assert.deepEqual(scope.paths, ['src.txt']);
    assert.deepEqual(worktreeChangesExcept(dir, 'workflow-session-planning.md', runGit, ['*.log', '.DS_Store']), ['src.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged-only-escape-records-staging-manual', () => {
  const dir = initRepo();
  try {
    const startSha = runGit(['rev-parse', 'HEAD'], dir).trim();
    fs.writeFileSync(path.join(dir, 'src.txt'), 'v2\n');
    runGit(['add', '--', 'src.txt'], dir);
    const scope = commitScopeForImplement(dir, 'workflow-session-planning.md', startSha, [], runGit);
    assert.deepEqual(scope.paths, ['src.txt']);
    assert.deepEqual(scope.preStaged, ['src.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('never-git-add-A', () => {
  const calls: string[][] = [];
  const run = (args: string[], cwd: string): string => {
    calls.push(args);
    return runGit(args, cwd);
  };
  const dir = initRepo();
  try {
    const startSha = runGit(['rev-parse', 'HEAD'], dir).trim();
    fs.writeFileSync(path.join(dir, 'src.txt'), 'v2\n');
    commitScopeForImplement(dir, 'workflow-session-planning.md', startSha, [], run);
    assert.equal(calls.some((a) => a[0] === 'add' && (a.includes('-A') || a.includes('.'))), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

