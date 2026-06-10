// Fixture matrix for the built verify-runner. This suite is AUTHORED in Task 8
// (session S2) but first EXECUTED in Task 10 (session S3), once the four
// fixtures it iterates exist under tests/fixtures/. It is intentionally
// EXCLUDED from the S2 verification boundary: S2 only typechecks it. Running it
// before the fixtures exist will fail, by design.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from this file (tests/runner/fixtures.test.ts -> ../../).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerPath = path.join(repoRoot, 'runner', 'dist', 'verify-runner.mjs');

/** The four Phase 1a fixtures, created in Task 10. */
const FIXTURES = ['node-service', 'frontend-web', 'n8n-ops', 'workspace-repo'] as const;

/** Absolute path to a fixture's manifest (never the root quality.json). */
function fixtureManifest(name: string): string {
  return path.join(repoRoot, 'tests', 'fixtures', name, 'quality.json');
}

/** Absolute path to the report a tier run should write under the fixture dir. */
function fixtureReport(name: string, scope: string): string {
  return path.join(repoRoot, 'tests', 'fixtures', name, 'reports', 'quality', `verify-${scope}.json`);
}

/** Runs the built runner against a fixture manifest with one scope flag. */
function runRunner(manifest: string, scopeFlag: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [runnerPath, '--manifest', manifest, scopeFlag], {
    encoding: 'utf8',
  });
}

/**
 * Ensures a fixture is a git repo with its baseline commit. The nested `.git`
 * dirs are local-only (never cloned into the parent repo), so a fresh clone has
 * the fixture FILES tracked as ordinary blobs but no `.git`. The runner shells
 * out to `git ls-files` from the fixture root, which would fail there. This
 * re-creates the baseline repo when `.git` is absent; an existing repo is left
 * untouched. The committer identity is set inline so it also works in clean CI
 * environments with no global git config.
 */
function ensureFixtureRepo(name: string): void {
  const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', name);
  if (fs.existsSync(path.join(fixtureDir, '.git'))) return;

  const opts = { cwd: fixtureDir, stdio: 'inherit' as const };
  const init = spawnSync('git', ['init', '-q'], opts);
  assert.equal(init.status, 0, `git init must succeed for fixture ${name}`);
  const add = spawnSync('git', ['add', '.'], opts);
  assert.equal(add.status, 0, `git add must succeed for fixture ${name}`);
  const commit = spawnSync(
    'git',
    [
      '-c',
      'user.email=fixtures@dev-standards.local',
      '-c',
      'user.name=fixtures',
      'commit',
      '-q',
      '-m',
      'fixture baseline',
    ],
    opts,
  );
  assert.equal(commit.status, 0, `git commit must succeed for fixture ${name}`);
}

before(() => {
  // Build only verify-runner.ts (Task 9 entrypoints do not exist yet), with the
  // same flags as the root build script, so the suite is robust to task order.
  const build = spawnSync(
    'npx',
    [
      'esbuild',
      'runner/src/verify-runner.ts',
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
  assert.equal(build.status, 0, 'esbuild build of verify-runner.ts must succeed');

  // Fresh-clone robustness: re-create each fixture's local-only git repo when
  // its `.git` is missing, so the runner's `git ls-files` discovery works.
  for (const name of FIXTURES) ensureFixtureRepo(name);
});

for (const name of FIXTURES) {
  test(`fixture ${name}: doctor, fast, and full all pass and write reports`, () => {
    const manifest = fixtureManifest(name);

    const doctorRun = runRunner(manifest, '--doctor');
    assert.equal(doctorRun.status, 0, `--doctor must exit 0 for ${name}`);

    const fastRun = runRunner(manifest, '--fast');
    assert.equal(fastRun.status, 0, `--fast must exit 0 for ${name}`);
    assert.ok(
      fs.existsSync(fixtureReport(name, 'fast')),
      `--fast must write ${fixtureReport(name, 'fast')}`,
    );

    const fullRun = runRunner(manifest, '--full');
    assert.equal(fullRun.status, 0, `--full must exit 0 for ${name}`);
    assert.ok(
      fs.existsSync(fixtureReport(name, 'full')),
      `--full must write ${fixtureReport(name, 'full')}`,
    );
  });
}
