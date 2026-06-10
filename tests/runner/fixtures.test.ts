import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerPath = path.join(repoRoot, 'runner', 'dist', 'verify-runner.mjs');

const FIXTURES = ['node-service', 'frontend-web', 'n8n-ops', 'workspace-repo'] as const;

function fixtureManifest(name: string): string {
  return path.join(repoRoot, 'tests', 'fixtures', name, 'quality.json');
}

function fixtureReport(name: string, scope: string): string {
  return path.join(repoRoot, 'tests', 'fixtures', name, 'reports', 'quality', `verify-${scope}.json`);
}

function runRunner(manifest: string, scopeFlag: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [runnerPath, '--manifest', manifest, scopeFlag], {
    encoding: 'utf8',
  });
}

// Fresh clones omit nested .git dirs; recreate fixture repos for git ls-files.
function ensureFixtureRepo(name: string): void {
  const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', name);
  if (fs.existsSync(path.join(fixtureDir, '.git'))) return;

  const opts = { cwd: fixtureDir, stdio: 'inherit' as const };
  const init = spawnSync('git', ['init', '-q'], opts);
  assert.equal(init.error, undefined, `git init must spawn for fixture ${name}: ${init.error?.message}`);
  assert.equal(init.status, 0, `git init must succeed for fixture ${name}`);
  const add = spawnSync('git', ['add', '.'], opts);
  assert.equal(add.error, undefined, `git add must spawn for fixture ${name}: ${add.error?.message}`);
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
  assert.equal(
    commit.error,
    undefined,
    `git commit must spawn for fixture ${name}: ${commit.error?.message}`,
  );
  assert.equal(commit.status, 0, `git commit must succeed for fixture ${name}`);
}

before(() => {
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
  assert.equal(build.error, undefined, `esbuild must spawn: ${build.error?.message}`);
  assert.equal(build.status, 0, 'esbuild build of verify-runner.ts must succeed');

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

    // Written reports must stay ignored inside each nested fixture repo.
    const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', name);
    const status = spawnSync('git', ['-C', fixtureDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(status.error, undefined, `git status must spawn for ${name}: ${status.error?.message}`);
    assert.equal(status.status, 0, `git status must succeed for ${name}`);
    assert.equal(
      status.stdout,
      '',
      `fixture ${name} nested repo must stay clean (reports/ gitignored), got: ${status.stdout}`,
    );
  });
}
