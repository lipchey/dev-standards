import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tool = path.join(repoRoot, 'tools', 'build-fingerprint.mjs');

function fingerprintOf(root: string): string {
  const run = spawnSync('node', [tool, '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, `build-fingerprint.mjs must exit 0, stderr: ${run.stderr}`);
  return run.stdout.trim();
}

test('fingerprint is deterministic and sensitive to source content and file set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fp-'));
  const src = path.join(root, 'runner', 'src');
  try {
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(src, 'b.ts'), 'export const b = 2;\n');

    const h1 = fingerprintOf(root);
    assert.ok(h1.length > 0, 'fingerprint must be non-empty');
    assert.equal(fingerprintOf(root), h1, 'identical inputs must fingerprint identically');

    fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 999;\n');
    assert.notEqual(fingerprintOf(root), h1, 'changed content must change the fingerprint');

    fs.writeFileSync(path.join(src, 'c.ts'), 'export const c = 3;\n');
    const hThree = fingerprintOf(root);
    assert.notEqual(hThree, h1, 'adding a file must change the fingerprint');

    fs.rmSync(path.join(src, 'c.ts'));
    fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n');
    assert.equal(fingerprintOf(root), h1, 'restoring the exact inputs must restore the fingerprint');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fingerprint tracks the build recipe — both the build:runner flags and the esbuild version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fp-'));
  const src = path.join(root, 'runner', 'src');
  const pkg = path.join(root, 'package.json');
  const writePkg = (buildRunner: string, esbuild: string) =>
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { 'build:runner': buildRunner }, devDependencies: { esbuild } }));
  try {
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n');

    writePkg('esbuild --target=node20', '^0.25.0');
    const base = fingerprintOf(root);

    writePkg('esbuild --target=node22', '^0.25.0'); // change ONLY the build:runner flags
    assert.notEqual(fingerprintOf(root), base, 'a build:runner flag change (same sources) must change the fingerprint');

    writePkg('esbuild --target=node20', '^0.26.0'); // change ONLY the esbuild version
    assert.notEqual(fingerprintOf(root), base, 'an esbuild version change (same sources/flags) must change the fingerprint');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* The shim's stale-refusal is tested in an isolated repo layout (copied shim + tool +
   a fake bundle) so it never mutates the real gitignored runner/dist that other test
   files rebuild concurrently. The guard fires before any tier, so a fake bundle is enough.
   The stamp is written via the tool's real `--write` path (the build-side contract), and
   compared against print mode, so the write branch/output-path/atomic-replace is exercised. */
test('core verify shim refuses a stale or missing stamp, passes a --write-produced one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shim-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(root, 'runner', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'runner', 'dist'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'verify'), path.join(root, 'verify'));
    fs.chmodSync(path.join(root, 'verify'), 0o755);
    fs.copyFileSync(tool, path.join(root, 'tools', 'build-fingerprint.mjs'));
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'));
    fs.writeFileSync(path.join(root, 'runner', 'src', 'x.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(root, 'runner', 'dist', 'verify-runner.mjs'), 'process.exit(0);\n');
    const stamp = path.join(root, 'runner', 'dist', '.build-fingerprint');
    const shim = path.join(root, 'verify');
    const runShim = () => spawnSync(shim, ['--doctor'], { encoding: 'utf8', cwd: root });

    fs.writeFileSync(stamp, 'DEADBEEF\n');
    const stale = runShim();
    assert.equal(stale.status, 127, `stale stamp must exit 127, got ${stale.status}: ${stale.stderr}`);
    assert.match(stale.stderr, /stale/, 'stderr must report the stale bundle');

    fs.rmSync(stamp);
    assert.equal(runShim().status, 127, 'a missing stamp must also be treated as stale (fail-closed)');

    // Produce the stamp the way `build:runner` does — the actual --write contract.
    const write = spawnSync('node', [path.join(root, 'tools', 'build-fingerprint.mjs'), '--root', root, '--write'], { encoding: 'utf8' });
    assert.equal(write.status, 0, `--write must exit 0: ${write.stderr}`);
    assert.equal(fs.readFileSync(stamp, 'utf8').trim(), fingerprintOf(root), '--write must write the same value print mode computes');
    assert.equal(runShim().status, 0, `a --write-produced stamp must pass the freshness gate and reach the doctor (exit 0), got: ${runShim().stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
