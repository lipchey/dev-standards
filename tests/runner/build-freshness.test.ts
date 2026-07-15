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

test('fingerprint tracks the build recipe (esbuild flags/version), not just sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fp-'));
  const src = path.join(root, 'runner', 'src');
  try {
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ scripts: { 'build:runner': 'esbuild --target=node20' }, devDependencies: { esbuild: '^0.25.0' } }));
    const before = fingerprintOf(root);

    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ scripts: { 'build:runner': 'esbuild --target=node22' }, devDependencies: { esbuild: '^0.25.0' } }));
    assert.notEqual(fingerprintOf(root), before, 'a build:runner recipe change (same sources) must change the fingerprint');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* The shim's stale-refusal is tested in an isolated repo layout (copied shim + tool +
   a fake bundle) so it never mutates the real gitignored runner/dist that other test
   files rebuild concurrently. The guard fires before any tier, so a comment-only fake
   bundle is enough. */
test('core verify shim refuses a bundle whose fingerprint stamp is stale or missing', () => {
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
    const missing = runShim();
    assert.equal(missing.status, 127, 'a missing stamp must also be treated as stale (fail-closed)');

    fs.writeFileSync(stamp, `${fingerprintOf(root)}\n`);
    const fresh = runShim();
    assert.notEqual(fresh.status, 127, `a matching stamp must pass the freshness gate: ${fresh.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
