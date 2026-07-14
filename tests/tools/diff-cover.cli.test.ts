import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* Exercises the CLI wrapper the exported pure fns cannot: base-ref resolution, the
   loadCoverage-BEFORE-rev-list ordering (stale coverage must beat an empty range),
   report writing, and the exit-code contract (0 N/A, 1 threshold fail, 2 operational).
   Each case owns a throwaway real-git repo run as a genuine subprocess. */

const TOOL = fileURLToPath(new URL('../../tools/diff-cover.mjs', import.meta.url));

interface Repo {
  root: string; // mkdtemp dir; parent of the checkout, cleaned up wholesale
  dir: string; // the git checkout (tool cwd)
  env: NodeJS.ProcessEnv;
}

/* Neuter global/system git config and redirect HOME so host config never leaks
   into the fixture or the tool's own git children (spawned with this same env). */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(repo: Repo, args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo.dir, env: repo.env, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed [${r.status}]: ${r.stderr ?? ''}`);
  return (r.stdout ?? '').trim();
}

function initRepo(): Repo {
  /* realpath so the checkout equals `git rev-parse --show-toplevel` (macOS /tmp is a
     symlink); synthetic coverage keys then resolve against the same root the tool sees. */
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-cover-cli-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dir = path.join(root, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  const repo: Repo = { root, dir, env: isolatedEnv(home) };
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'cli@example.com']);
  git(repo, ['config', 'user.name', 'CLI Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
}

function write(repo: Repo, rel: string, contents: string): void {
  const file = path.join(repo.dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function commitAll(repo: Repo, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

/* Write fresh synthetic v8 coverage at the tool's default path. Keys are absolute
   (v8 provider shape); the tool normalizes them against the repo root. */
function writeCoverage(
  repo: Repo,
  entries: Record<string, { statementMap: unknown; s: unknown }>,
): string {
  const byAbs: Record<string, unknown> = {};
  for (const [rel, entry] of Object.entries(entries)) {
    const abs = path.join(repo.dir, rel);
    byAbs[abs] = { path: abs, ...entry };
  }
  write(repo, 'coverage/coverage-final.json', JSON.stringify(byAbs));
  return path.join(repo.dir, 'coverage/coverage-final.json');
}

function runTool(repo: Repo, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: repo.dir,
    env: repo.env,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function reportPath(repo: Repo): string {
  return path.join(repo.dir, 'reports', 'quality', 'diff-coverage.json');
}

function cleanup(repo: Repo): void {
  try {
    fs.rmSync(repo.root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test('diff-cover CLI: empty range → N/A exit 0 and the report IS written', () => {
  const repo = initRepo();
  try {
    write(repo, 'README.md', '# base\n');
    commitAll(repo, 'init');
    writeCoverage(repo, {}); // fresh; the range is empty so no entries are consulted
    const r = runTool(repo, ['--base-ref', 'HEAD']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /N\/A \(no commits to measure\)/);
    const report = JSON.parse(fs.readFileSync(reportPath(repo), 'utf8'));
    assert.equal(report.total, null);
    /* The N/A report is the audit trail — base and headSha must be recorded
       (ratified contract), not just the null total. */
    assert.equal(report.base, 'HEAD');
    assert.equal(report.headSha, git(repo, ['rev-parse', 'HEAD']));
  } finally {
    cleanup(repo);
  }
});

test('diff-cover CLI: unresolvable base ref → loud exit 2, no report', () => {
  const repo = initRepo();
  try {
    write(repo, 'README.md', '# base\n');
    commitAll(repo, 'init');
    /* A previous run's report must survive an operational failure untouched:
       the contract is "no NEW report on exit 2", not "delete the old one". */
    fs.mkdirSync(path.dirname(reportPath(repo)), { recursive: true });
    fs.writeFileSync(reportPath(repo), '{"marker":"previous-run"}\n');
    /* No remote: the deepen fallback fails offline-safely, then loud fail — before
       loadCoverage, so no coverage file is even needed and no report is written. */
    const r = runTool(repo, ['--base-ref', 'no-such-ref-xyz']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /unresolvable/);
    assert.match(fs.readFileSync(reportPath(repo), 'utf8'), /previous-run/);
  } finally {
    cleanup(repo);
  }
});

test('diff-cover CLI: stale coverage beats empty range → exit 2, no report', () => {
  const repo = initRepo();
  try {
    write(repo, 'README.md', '# base\n');
    commitAll(repo, 'init');
    const cov = writeCoverage(repo, {});
    const old = Math.floor(Date.now() / 1000) - 1200; // 20 min > 600s freshness backstop
    fs.utimesSync(cov, old, old);
    /* HEAD..HEAD is empty, but main() loads coverage BEFORE rev-list, so the stale
       guard fires first and there is no silent N/A pass on old data. */
    const r = runTool(repo, ['--base-ref', 'HEAD']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /stale/);
    assert.equal(fs.existsSync(reportPath(repo)), false);
  } finally {
    cleanup(repo);
  }
});

test('diff-cover CLI: committed delta is measured end-to-end (50% < threshold → exit 1)', () => {
  const repo = initRepo();
  try {
    write(repo, 'README.md', '# base\n');
    commitAll(repo, 'init');
    const baseSha = git(repo, ['rev-parse', 'HEAD']);

    write(repo, 'src/new.ts', 'export const a = 1;\nexport const b = 2;\n');
    commitAll(repo, 'add src');

    /* Synthetic fresh coverage: line 1 hit, line 2 miss → 1/2 = 50%. Hermetic proof
       of end-to-end % measurement the pilot smoke record cannot give (Gate P F7). */
    writeCoverage(repo, {
      'src/new.ts': {
        statementMap: {
          0: { start: { line: 1 }, end: { line: 1 } },
          1: { start: { line: 2 }, end: { line: 2 } },
        },
        s: { 0: 1, 1: 0 },
      },
    });

    const r = runTool(repo, ['--base-ref', baseSha, '--threshold', '70']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /50% .* FAIL/);
    const report = JSON.parse(fs.readFileSync(reportPath(repo), 'utf8'));
    assert.equal(report.total, 50);
  } finally {
    cleanup(repo);
  }
});
