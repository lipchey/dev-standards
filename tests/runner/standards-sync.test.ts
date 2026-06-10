// Phase 1a `standards-sync --check` shim contract. The shim is a small Bash
// wrapper at tools/standards-sync that resolves the repo root from its own
// location, runs the built validate-quality-manifest.mjs against the root
// quality.json, and asserts schemas/quality.schema.json exists.
//
// Exit-code contract (frozen): 2 usage (no args, multiple args, anything other
// than exactly `--check`), 127 missing bundle, 1 invalid manifest (propagated)
// or missing schema, 0 success with `standards-sync check passed` printed.
//
// This suite needs the real bundle built, so a before() hook builds only the
// validate-quality-manifest.ts entrypoint with the same flags as the root build
// script (mirroring fixtures.test.ts), making it robust to task order.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from this file (tests/runner/standards-sync.test.ts -> ../../).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shimPath = path.join(repoRoot, 'tools', 'standards-sync');
const bundleRel = path.join('runner', 'dist', 'validate-quality-manifest.mjs');

/**
 * Runs the shim via `bash` (not the exec bit) so the suite never depends on the
 * file's mode, with `cwd` defaulting to repoRoot. Pass a different `cwd` to
 * prove root resolution is location-based, not cwd-based.
 */
function runShim(args: string[], cwd: string = repoRoot): SpawnSyncReturns<string> {
  return spawnSync('bash', [shimPath, ...args], { cwd, encoding: 'utf8' });
}

/** Combined stdout+stderr, the way an operator sees a shell invocation. */
function combined(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

before(() => {
  // Build only validate-quality-manifest.ts with the same flags as the root
  // build script, so the suite is robust to task order.
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
  // Build a minimal temp root with everything BUT schemas/, so root resolution
  // from the shim's own location finds the bundle but not the schema.
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
    // Exit 1 must come from the schema check, not a skipped/half-run validator.
    // The manifest in this temp root is valid, so the validator must genuinely
    // run and emit its success phrase; the missing-schema message must name the
    // schema. (Pre-fix, the symlinked /var temp path made the entrypoint guard
    // export-only and exit 0 — both assertions below would have failed.)
    assert.match(combined(result), /valid quality manifest/, 'validator must actually run on the valid manifest');
    assert.match(result.stderr ?? '', /schema/i, 'expected the missing-schema message on stderr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: an invalid manifest propagates the validator exit 1 with a validation error', () => {
  // Bundle AND schema are present, but quality.json is invalid (bad `stack`
  // enum). This pins that the validator genuinely runs through the shim and its
  // exit 1 propagates — the exact failure the symlink-safe entrypoint guard
  // protects: under a symlinked (/var) temp path the pre-fix guard exported only
  // and exited 0, swallowing the invalid manifest.
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
  // Same temp-root trick, but omit runner/dist/ entirely.
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
