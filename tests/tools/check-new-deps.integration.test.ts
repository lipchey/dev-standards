/* Runner-integration test for tools/check-new-deps.mjs: drive the REAL verify
   runner (tsx on source — the tests/deep-review-e2e/helper.ts precedent, never a
   `before()` esbuild rebuild that would race tests/runner/verify-runner.test.ts
   on runner/dist) over a wired `staged` tier, and assert the per-check record the
   runner writes. This proves the check spawns on a manifest commit, that a
   report-only finding does NOT fail the tier, and that an operational exit (2)
   still blocks despite report-only — the seam the unit suite can't reach because
   status mapping (fail vs skipped vs error) lives in the runner, not the tool. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
/* Local tsx (never npx — a network launcher) running the runner ENTRYPOINT on
   source, and the tool under test as an absolute path (the temp repo has no copy
   of it). argv[0] is this test's own node, so the runner's check spawn resolves
   to a real interpreter without a PATH lookup. */
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const RUNNER_ENTRY = path.join(REPO_ROOT, 'runner', 'src', 'verify-runner.ts');
const TOOL = path.join(REPO_ROOT, 'tools', 'check-new-deps.mjs');

const CLEAN_MANIFEST = JSON.stringify(
  { name: 'fixture-pkg', version: '1.0.0', dependencies: {}, devDependencies: {} },
  null,
  2,
);
const CLEAN_LOCK = JSON.stringify(
  {
    name: 'fixture-pkg',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture-pkg', version: '1.0.0' } },
  },
  null,
  2,
);

/* Env every git/runner/check process in a case carries: an isolated HOME + neutered
   global/system config so host git config can never leak in, telemetry off so no run
   event escapes to the home sink. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    DS_TELEMETRY_PATH: 'off',
  };
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed [${r.status}]: ${r.stderr ?? ''}`);
}

interface Fixture {
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  manifestPath: string;
  reportPath: string;
}

/* A throwaway git repo whose initial commit is a clean manifest+lockfile pair, plus
   a quality.json (on disk, uncommitted — the runner reads it via --manifest) wiring
   check-new-deps into the `staged` tier: report-only, operational exit 2, gated on the
   manifests_staged git_staged fileset. The manifest root (dirname of the manifest path)
   IS the repo, so the check's cwd — and thus its git index reads — land in this repo. */
function setupRepo(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cnd-itest-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const env = isolatedEnv(home);

  git(repo, ['init', '-q', '-b', 'main'], env);
  git(repo, ['config', 'user.email', 'itest@example.com'], env);
  git(repo, ['config', 'user.name', 'Integration Test'], env);
  git(repo, ['config', 'commit.gpgsign', 'false'], env);
  const emptyHooks = path.join(root, 'empty-hooks');
  fs.mkdirSync(emptyHooks, { recursive: true });
  git(repo, ['config', 'core.hooksPath', emptyHooks], env);

  const manifest = {
    version: 1,
    repo: 'cnd-itest',
    stack: 'node-service',
    scheduler_class: 'local-only',
    /* staged_seconds (30) >= the check's timeout_seconds (10), or the tier-budget
       validator rejects the manifest before any check runs. */
    budgets: { staged_seconds: 30, fast_seconds: 90, full_seconds: 300, audit_seconds: 300 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: false,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [{ name: 'manifests_staged', source: 'git_staged', include: ['package.json', 'package-lock.json'] }],
    tiers: {
      staged: [
        {
          name: 'check-new-deps',
          argv: [process.execPath, TOOL],
          mode: 'report-only',
          operational_exit_codes: [2],
          skip_if_empty: 'manifests_staged',
          timeout_seconds: 10,
        },
      ],
      fast: [],
      full: [],
      audit: [],
    },
  };

  fs.writeFileSync(path.join(repo, 'package.json'), CLEAN_MANIFEST);
  fs.writeFileSync(path.join(repo, 'package-lock.json'), CLEAN_LOCK);
  const manifestPath = path.join(repo, 'quality.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  git(repo, ['add', '--', 'package.json', 'package-lock.json'], env);
  git(repo, ['commit', '-q', '-m', 'init'], env);

  return { root, repo, env, manifestPath, reportPath: path.join(repo, 'reports', 'quality', 'verify-staged.json') };
}

function stage(fx: Fixture, rel: string, content: string): void {
  fs.writeFileSync(path.join(fx.repo, rel), content);
  git(fx.repo, ['add', '--', rel], fx.env);
}

function runStaged(fx: Fixture): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(TSX_BIN, [RUNNER_ENTRY, '--manifest', fx.manifestPath, '--staged'], {
    cwd: fx.repo,
    env: fx.env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) throw new Error(`failed to spawn runner: ${r.error.message}`);
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/* The check-new-deps record, found by name — never a bare-string match on the whole
   report, which would pass on an unrelated field carrying the same word. */
function record(fx: Fixture): { name: string; status: string; mode: string } {
  const report = JSON.parse(fs.readFileSync(fx.reportPath, 'utf8')) as {
    results: Array<{ name: string; status: string; mode: string }>;
  };
  const rec = report.results.find((r) => r.name === 'check-new-deps');
  assert.ok(rec, `report must contain a check-new-deps record; got ${JSON.stringify(report.results)}`);
  return rec;
}

function cleanup(fx: Fixture): void {
  fs.rmSync(fx.root, { recursive: true, force: true });
}

test('a floating-spec new dep on a manifest-only commit -> report-only fail, runner still exits 0', () => {
  const fx = setupRepo();
  try {
    stage(fx, 'package.json', JSON.stringify({ name: 'fixture-pkg', version: '1.0.0', dependencies: { 'leftpad-ai': '>=1.0.0' } }, null, 2));
    const run = runStaged(fx);
    assert.equal(run.status, 0, `report-only finding must not fail the tier; stderr:\n${run.stderr}`);
    assert.equal(record(fx).status, 'fail');
  } finally {
    cleanup(fx);
  }
});

test('nothing staged -> the check is skipped via skip_if_empty', () => {
  const fx = setupRepo();
  try {
    const run = runStaged(fx);
    assert.equal(run.status, 0, `an all-skipped tier must exit 0; stderr:\n${run.stderr}`);
    assert.equal(record(fx).status, 'skipped');
  } finally {
    cleanup(fx);
  }
});

test('new dep + a broken staged lockfile -> operational error blocks despite report-only', () => {
  const fx = setupRepo();
  try {
    stage(fx, 'package.json', JSON.stringify({ name: 'fixture-pkg', version: '1.0.0', dependencies: { 'newpkg-xyz': '1.2.3' } }, null, 2));
    /* Truncated JSON: the tool's up-front lockfile parse throws OperationalError -> exit 2.
       Exit 2 is a declared operational_exit_code, so the runner records status:'error',
       which blocks in ANY mode -> the tier (and runner) exit non-zero even though the
       check is report-only. */
    stage(fx, 'package-lock.json', '{ "lockfileVersion": 3, "packages": {');
    const run = runStaged(fx);
    assert.equal(run.status, 1, `an operational error must block the tier; stderr:\n${run.stderr}`);
    assert.equal(record(fx).status, 'error');
  } finally {
    cleanup(fx);
  }
});

/* ADR-017: existing-dep source swap end to end. A manifest-only source swap would
   be a WEAK test (D8 reports every manifest-only spec change even without source
   detection), so `a` is a committed existing registry dep and the swap ships WITH
   a matching lockfile — D8 is satisfied, leaving the source classification as the
   finding under test. */
function commitExistingDepA(fx: Fixture): void {
  fs.writeFileSync(
    path.join(fx.repo, 'package.json'),
    JSON.stringify({ name: 'fixture-pkg', version: '1.0.0', dependencies: { a: '^1.2.3' }, devDependencies: {} }, null, 2),
  );
  fs.writeFileSync(
    path.join(fx.repo, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'fixture-pkg',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'fixture-pkg', version: '1.0.0', dependencies: { a: '^1.2.3' } },
          'node_modules/a': { version: '1.2.3', resolved: 'https://registry.npmjs.org/a/-/a-1.2.3.tgz' },
        },
      },
      null,
      2,
    ),
  );
  git(fx.repo, ['add', '--', 'package.json', 'package-lock.json'], fx.env);
  git(fx.repo, ['commit', '-q', '-m', 'add existing dep a'], fx.env);
}

test('an existing-dep source swap (manifest + matching lock) -> report-only fail, runner exits 0', () => {
  const fx = setupRepo();
  try {
    commitExistingDepA(fx);
    const gitSpec = 'git+ssh://git@example.com/u/a.git';
    stage(fx, 'package.json', JSON.stringify({ name: 'fixture-pkg', version: '1.0.0', dependencies: { a: gitSpec }, devDependencies: {} }, null, 2));
    stage(
      fx,
      'package-lock.json',
      JSON.stringify(
        {
          name: 'fixture-pkg',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'fixture-pkg', version: '1.0.0', dependencies: { a: gitSpec } },
            'node_modules/a': { version: '1.2.3', resolved: `${gitSpec}#abc123` },
          },
        },
        null,
        2,
      ),
    );
    const run = runStaged(fx);
    assert.equal(run.status, 0, `report-only finding must not fail the tier; stderr:\n${run.stderr}`);
    assert.equal(record(fx).status, 'fail');
  } finally {
    cleanup(fx);
  }
});

test('a lock-only HTTPS package swap is caught only via the committed base lock -> report-only fail, exits 0', () => {
  const fx = setupRepo();
  try {
    /* Base lock resolves `a` from …/a/-/a-1.2.3.tgz. Stage a lock that keeps the
       same host but pivots to a DIFFERENT package (…/evil/…). Signals 1 and 2 pass
       (registry root spec, https resolved); ONLY signal 3's identity diff against
       the loaded HEAD lock catches it — so deleting main()'s base-lock read turns
       this red (core-code-guidelines changed-behavior testing). */
    commitExistingDepA(fx);
    stage(
      fx,
      'package-lock.json',
      JSON.stringify(
        {
          name: 'fixture-pkg',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'fixture-pkg', version: '1.0.0', dependencies: { a: '^1.2.3' } },
            'node_modules/a': { version: '9.9.9', resolved: 'https://registry.npmjs.org/evil/-/evil-9.9.9.tgz' },
          },
        },
        null,
        2,
      ),
    );
    const run = runStaged(fx);
    assert.equal(run.status, 0, `report-only finding must not fail the tier; stderr:\n${run.stderr}`);
    assert.equal(record(fx).status, 'fail');
  } finally {
    cleanup(fx);
  }
});

test('a lock-only source swap (manifest unstaged) -> report-only fail, runner exits 0', () => {
  const fx = setupRepo();
  try {
    commitExistingDepA(fx);
    /* Only the lockfile is staged: `a`'s resolved is swapped to a git source while
       package.json still says ^1.2.3 — the vector invisible to the manifest path. */
    stage(
      fx,
      'package-lock.json',
      JSON.stringify(
        {
          name: 'fixture-pkg',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'fixture-pkg', version: '1.0.0', dependencies: { a: '^1.2.3' } },
            'node_modules/a': { version: '1.2.3', resolved: 'git+ssh://git@example.com/u/a.git#abc123' },
          },
        },
        null,
        2,
      ),
    );
    const run = runStaged(fx);
    assert.equal(run.status, 0, `report-only finding must not fail the tier; stderr:\n${run.stderr}`);
    assert.equal(record(fx).status, 'fail');
  } finally {
    cleanup(fx);
  }
});
