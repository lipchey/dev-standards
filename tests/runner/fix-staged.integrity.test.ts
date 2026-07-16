import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  linkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFixStaged } from '../../runner/src/fix-staged.ts';
import type { Manifest } from '../../runner/src/types.ts';

// A fake formatter that uppercases each file argument, so "was it formatted" is observable.
const UPPERCASE = "const fs=require('node:fs');for(const f of process.argv.slice(1))fs.writeFileSync(f,fs.readFileSync(f,'utf8').toUpperCase());";

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fixstaged-int-'));
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

function manifest(formatterArgv: string[]): Manifest {
  return {
    version: 1,
    repo: 'fixture',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 30, fast_seconds: 60, full_seconds: 120, audit_seconds: 120 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: true,
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

// ── BUG-04: hardlinks are unsupported input — a repo file may share an inode with a path OUTSIDE
// the repo, so formatting it in place would silently rewrite that external file (and git checkout,
// which restores by path not inode, cannot undo it). Reject nlink !== 1 before AND re-check after. ──

test('BUG-04: a hardlinked staged file is skipped before the formatter; its external twin is untouched', () => {
  const dir = setupRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), 'fixstaged-outside-'));
  const outside = join(outsideDir, 'twin.txt');
  writeFileSync(outside, 'external\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  linkSync(outside, join(dir, 'src/a.ts')); // src/a.ts now shares outside's inode → nlink 2
  git(dir, 'add', 'src/a.ts');
  assert.equal(lstatSync(join(dir, 'src/a.ts')).nlink, 2, 'precondition: the staged file is hardlinked');

  const { code, err } = run(manifest(['node', '-e', UPPERCASE]), dir);
  assert.equal(code, 0); // skipped (nlink != 1), so nothing to format — a clean no-op
  assert.match(err, /hardlinked/);
  assert.equal(readFileSync(outside, 'utf8'), 'external\n', 'the external twin must NOT be formatted');
  assert.equal(stagedBlob(dir, 'src/a.ts'), 'external\n', 'index unchanged (the file was never formatted)');
});

test('BUG-04: a hardlinked file is skipped while a normal sibling is still formatted', () => {
  const dir = setupRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), 'fixstaged-outside2-'));
  const outside = join(outsideDir, 'twin.txt');
  writeFileSync(outside, 'external\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  linkSync(outside, join(dir, 'src/linked.ts'));
  git(dir, 'add', 'src/linked.ts');
  writeAndStage(dir, 'src/normal.ts', 'plain\n');

  const { code, err } = run(manifest(['node', '-e', UPPERCASE]), dir);
  assert.equal(code, 0);
  assert.match(err, /hardlinked/);
  assert.equal(stagedBlob(dir, 'src/normal.ts'), 'PLAIN\n', 'the normal file is formatted');
  assert.equal(readFileSync(outside, 'utf8'), 'external\n', 'the external twin stays untouched');
});

test('BUG-04: a formatter that hardlinks an operand to an outside file is caught and rolled back', () => {
  const dir = setupRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), 'fixstaged-outside3-'));
  const outside = join(outsideDir, 'twin.txt');
  writeFileSync(outside, 'external\n');
  writeAndStage(dir, 'src/a.ts', 'staged\n'); // starts as a normal nlink-1 file (passes the pre-check)

  // The formatter unlinks the operand and re-creates it as a hardlink to the outside file: a REGULAR
  // file (isFile() alone would pass), so only the post-format nlink !== 1 check catches it.
  const HARDLINK = `const fs=require('node:fs');const f=process.argv[1];fs.unlinkSync(f);fs.linkSync(${JSON.stringify(outside)},f);`;
  const { code } = run(manifest(['node', '-e', HARDLINK]), dir);
  assert.equal(code, 1, 'a post-format nlink != 1 must trigger rollback');
  assert.ok(lstatSync(join(dir, 'src/a.ts')).isFile(), 'operand restored to a regular file');
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'staged\n', 'operand content restored');
  assert.equal(stagedBlob(dir, 'src/a.ts'), 'staged\n', 'index unchanged');
});

// ── BUG-07: a {files:<fileset>} token in format.argv must never turn a staged file into argv[0].
// format.argv is kept VERBATIM; only the internally-appended safe list is token-expanded, so argv[0]
// is always the configured formatter, never a staged file executed as a program. ──

test('BUG-07: a placeholder in format.argv never executes a staged file as argv[0]', () => {
  const dir = setupRepo();
  // A staged file that, IF spawned as the program, would create EXECUTED in the repo root.
  const abs = join(dir, 'src/a.ts');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '#!/bin/sh\ntouch EXECUTED\n');
  chmodSync(abs, 0o755);
  git(dir, 'add', 'src/a.ts');

  // format.argv is ONLY the (unknown, zero-expanding) token. Pre-fix this collapsed so the appended
  // staged path became argv[0] and ran; post-fix argv[0] stays the literal token → ENOENT, no exec.
  const { code } = run(manifest(['{files:ghost}']), dir);
  assert.equal(existsSync(join(dir, 'EXECUTED')), false, 'the staged file must NOT have been executed');
  assert.equal(code, 1, 'a non-existent formatter (the literal token) fails cleanly and rolls back');
  assert.equal(stagedBlob(dir, 'src/a.ts'), '#!/bin/sh\ntouch EXECUTED\n', 'index unchanged');
});
