// standards-sync --check validates the root manifest via the built bundle and requires the schema.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shimPath = path.join(repoRoot, 'tools', 'standards-sync');
const bundleRel = path.join('runner', 'dist', 'validate-quality-manifest.mjs');

// Use bash so the suite never depends on the file's executable bit.
function runShim(args: string[], cwd: string = repoRoot): SpawnSyncReturns<string> {
  return spawnSync('bash', [shimPath, ...args], { cwd, encoding: 'utf8' });
}

function combined(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

before(() => {
  const build = spawnSync(
    'npx',
    [
      'esbuild',
      'runner/src/validate-quality-manifest.ts',
      '--bundle',
      '--platform=node',
      '--target=node20',
      '--format=esm',
      '--sourcemap=external',
      '--outdir=runner/dist',
      '--out-extension:.js=.mjs',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  assert.equal(build.status, 0, 'esbuild build of validate-quality-manifest.ts must succeed');
});

test('standards-sync: no args prints usage on stderr and exits 2', () => {
  const result = runShim([]);
  assert.equal(result.status, 2, `expected exit 2; got ${result.status}`);
  assert.ok(
    /usage/i.test(result.stderr ?? ''),
    `expected a usage message on stderr; got ${JSON.stringify(result.stderr)}`,
  );
});

test('standards-sync: an unknown flag exits 2', () => {
  const result = runShim(['--frobnicate']);
  assert.equal(result.status, 2, `expected exit 2; got ${result.status}`);
  assert.ok((result.stderr ?? '').length > 0, 'expected a usage message on stderr');
});

test('standards-sync: an extra arg after --check exits 2', () => {
  const result = runShim(['--check', 'extra']);
  assert.equal(result.status, 2, `expected exit 2; got ${result.status}`);
  assert.ok((result.stderr ?? '').length > 0, 'expected a usage message on stderr');
});

test('standards-sync: --check against the real repo root exits 0 and prints both phrases', () => {
  const result = runShim(['--check']);
  assert.equal(result.status, 0, `expected exit 0; got ${result.status}: ${combined(result)}`);
  const blob = combined(result);
  assert.match(blob, /valid quality manifest/, `expected the validator phrase; got ${blob}`);
  assert.match(blob, /standards-sync check passed/, `expected the success phrase; got ${blob}`);
});

test('standards-sync: a missing schema exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sync-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'runner', 'dist'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'quality.json'), path.join(dir, 'quality.json'));
    fs.copyFileSync(path.join(repoRoot, bundleRel), path.join(dir, bundleRel));
    fs.copyFileSync(shimPath, path.join(dir, 'tools', 'standards-sync'));

    const result = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `expected exit 1; got ${result.status}: ${combined(result)}`);
    // The validator must actually run before the schema check fails.
    assert.match(combined(result), /valid quality manifest/, 'validator must actually run on the valid manifest');
    assert.match(result.stderr ?? '', /schema/i, 'expected the missing-schema message on stderr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: an invalid manifest propagates the validator exit 1 with a validation error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sync-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'runner', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'schemas'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, bundleRel), path.join(dir, bundleRel));
    fs.copyFileSync(
      path.join(repoRoot, 'schemas', 'quality.schema.json'),
      path.join(dir, 'schemas', 'quality.schema.json'),
    );
    fs.copyFileSync(shimPath, path.join(dir, 'tools', 'standards-sync'));

    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'quality.json'), 'utf8'));
    manifest.stack = 'not-a-real-stack';
    fs.writeFileSync(path.join(dir, 'quality.json'), JSON.stringify(manifest, null, 2));

    const result = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `expected exit 1; got ${result.status}: ${combined(result)}`);
    assert.match(result.stderr ?? '', /^stack: must be one of/m, `expected a validation error line; got ${JSON.stringify(result.stderr)}`);
    assert.doesNotMatch(combined(result), /standards-sync check passed/, 'the shim must not report success on an invalid manifest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: a missing bundle exits 127 with a build hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sync-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'schemas'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'quality.json'), path.join(dir, 'quality.json'));
    fs.copyFileSync(
      path.join(repoRoot, 'schemas', 'quality.schema.json'),
      path.join(dir, 'schemas', 'quality.schema.json'),
    );
    fs.copyFileSync(shimPath, path.join(dir, 'tools', 'standards-sync'));

    const result = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 127, `expected exit 127; got ${result.status}: ${combined(result)}`);
    assert.match(result.stderr ?? '', /npm run build/, 'expected a "run npm run build" hint on stderr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
