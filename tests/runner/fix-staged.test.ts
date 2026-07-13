import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFixStaged } from '../../runner/src/fix-staged.ts';
import type { Manifest } from '../../runner/src/types.ts';

// A fake formatter that uppercases each file argument, so "was it formatted" is observable.
const UPPERCASE = "const fs=require('node:fs');for(const f of process.argv.slice(1))fs.writeFileSync(f,fs.readFileSync(f,'utf8').toUpperCase());";
// A fake formatter that mutates its first file then fails, to exercise the rollback path.
const MUTATE_THEN_FAIL = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'MUTATED');process.exit(1);";

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fixstaged-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  return dir;
}

function writeAndStage(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, 'add', rel);
}

function stagedBlob(dir: string, rel: string): string {
  return git(dir, 'show', `:${rel}`);
}

function manifest(formatterArgv: string[], allowed = true): Manifest {
  return {
    version: 1,
    repo: 'fixture',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 30, fast_seconds: 60, full_seconds: 120, audit_seconds: 120 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: allowed,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [{ name: 'staged_fmt', source: 'git_staged', include: ['src/**/*.ts'] }],
    tiers: { staged: [], fast: [], full: [] },
    format: { argv: formatterArgv, fileset: 'staged_fmt', timeout_seconds: 30 },
  };
}

function run(m: Manifest, dir: string): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (buf: string[]) =>
    ({ write: (s: string) => (buf.push(s), true) }) as unknown as NodeJS.WriteStream;
  const code = runFixStaged(m, dir, sink(out), sink(err));
  return { code, out: out.join(''), err: err.join('') };
}

test('formats and re-stages fully-staged files', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/a.ts', 'alpha\n');
  writeAndStage(dir, 'src/b.ts', 'beta\n');
  const { code } = run(manifest(['node', '-e', UPPERCASE]), dir);
  assert.equal(code, 0);
  assert.equal(stagedBlob(dir, 'src/a.ts'), 'ALPHA\n');
  assert.equal(stagedBlob(dir, 'src/b.ts'), 'BETA\n');
});

test('skips a partially-staged file, formats the clean one', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/clean.ts', 'clean\n');
  writeAndStage(dir, 'src/dirty.ts', 'staged\n');
  writeFileSync(join(dir, 'src/dirty.ts'), 'staged-then-edited\n'); // worktree now differs from index
  const { code, err } = run(manifest(['node', '-e', UPPERCASE]), dir);
  assert.equal(code, 0);
  assert.equal(stagedBlob(dir, 'src/clean.ts'), 'CLEAN\n');
  assert.equal(stagedBlob(dir, 'src/dirty.ts'), 'staged\n', 'partially-staged index must be untouched');
  assert.match(err, /skipping 1 partially-staged/);
});

test('a formatter failure rolls back the working tree and leaves the index unformatted', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/a.ts', 'staged\n');
  const { code } = run(manifest(['node', '-e', MUTATE_THEN_FAIL]), dir);
  assert.equal(code, 1);
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'staged\n', 'working tree must be reverted');
  assert.equal(stagedBlob(dir, 'src/a.ts'), 'staged\n', 'index must be unchanged');
});

test('no staged files is a clean no-op', () => {
  const dir = setupRepo();
  const { code } = run(manifest(['node', '-e', UPPERCASE]), dir);
  assert.equal(code, 0);
});

test('disabled by policy is a no-op even with staged files', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/a.ts', 'alpha\n');
  const { code } = run(manifest(['node', '-e', UPPERCASE], false), dir);
  assert.equal(code, 0);
  assert.equal(stagedBlob(dir, 'src/a.ts'), 'alpha\n', 'index must be untouched when policy forbids');
});

test('a staged symlink is skipped, not fed to the formatter', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/real.ts', 'real\n');
  writeFileSync(join(dir, 'target.txt'), 'external\n');
  symlinkSync('../target.txt', join(dir, 'src/link.ts'));
  git(dir, 'add', 'src/link.ts');
  const { code, err } = run(manifest(['node', '-e', UPPERCASE]), dir);
  assert.equal(code, 0);
  assert.equal(stagedBlob(dir, 'src/real.ts'), 'REAL\n');
  assert.ok(lstatSync(join(dir, 'src/link.ts')).isSymbolicLink(), 'symlink must remain a symlink');
  assert.equal(readFileSync(join(dir, 'target.txt'), 'utf8'), 'external\n', 'symlink target must be untouched');
  assert.match(err, /skipping 1 non-regular/);
});

test('a formatter that retypes an operand to a symlink is caught and rolled back', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/a.ts', 'staged\n');
  const RETYPE = "const fs=require('node:fs');const f=process.argv[1];fs.unlinkSync(f);fs.symlinkSync('/etc/passwd',f);";
  const { code } = run(manifest(['node', '-e', RETYPE]), dir);
  assert.equal(code, 1);
  assert.ok(lstatSync(join(dir, 'src/a.ts')).isFile(), 'operand must be restored to a regular file');
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'staged\n', 'original content restored');
  assert.equal(stagedBlob(dir, 'src/a.ts'), 'staged\n', 'index unchanged');
});

test('a filename with glob metacharacters only affects itself (literal pathspecs)', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/ab.ts', 'plain\n'); // pathspec "a[b].ts" would glob-match this
  writeFileSync(join(dir, 'src/a[b].ts'), 'bracket\n');
  git(dir, '--literal-pathspecs', 'add', '--', 'src/a[b].ts');
  writeFileSync(join(dir, 'src/ab.ts'), 'plain-edited\n'); // unstaged edit → ab.ts is partially staged
  const { code } = run(manifest(['node', '-e', UPPERCASE]), dir);
  assert.equal(code, 0);
  assert.equal(stagedBlob(dir, 'src/a[b].ts'), 'BRACKET\n', 'the literal bracket file is formatted+staged');
  assert.equal(stagedBlob(dir, 'src/ab.ts'), 'plain\n', 'ab.ts index must not be swept by the glob');
  assert.equal(readFileSync(join(dir, 'src/ab.ts'), 'utf8'), 'plain-edited\n', 'ab.ts unstaged edit preserved');
});

test('a formatter that makes lstat throw (ENOTDIR) is caught, not propagated', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/deep/a.ts', 'staged\n');
  // Replace the operand's parent dir with a file, so lstat(src/deep/a.ts) raises ENOTDIR.
  const ENOTDIR = "const fs=require('node:fs'),p=require('node:path');const f=process.argv[1];fs.unlinkSync(f);fs.rmdirSync(p.dirname(f));fs.writeFileSync(p.dirname(f),'x');";
  const { code } = run(manifest(['node', '-e', ENOTDIR]), dir);
  assert.equal(code, 1); // handled via the rollback-on-throw boundary, no unhandled exception
});

test('a deleted staged file is never sent to the formatter (ACMR default)', () => {
  const dir = setupRepo();
  writeAndStage(dir, 'src/keep.ts', 'keep\n');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'rm', '-q', 'src/keep.ts'); // stages a deletion (status D)
  const { code } = run(manifest(['node', '-e', UPPERCASE]), dir);
  assert.equal(code, 0); // D is excluded by the default ACMR filter; formatter gets no path
});
