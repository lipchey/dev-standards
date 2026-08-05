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

/* The failure line carries a percentage and no file, so until the shortfall was printed the
   only way to learn WHICH file to test was to open diff-coverage.json — which exists solely on
   the machine that ran the gate. Whoever reads a remote or CI run reads stdout, so the actionable
   part has to be there. Asserting the fully covered file is ABSENT is the half that matters: a
   listing of every changed file would technically contain the answer while burying it. */
test('diff-cover CLI: a failing run names only the files with uncovered changed lines', () => {
  const repo = initRepo();
  try {
    write(repo, 'README.md', '# base\n');
    commitAll(repo, 'init');
    const baseSha = git(repo, ['rev-parse', 'HEAD']);

    write(repo, 'src/covered.ts', 'export const a = 1;\nexport const b = 2;\n');
    write(repo, 'src/gap.ts', 'export const c = 3;\nexport const d = 4;\n');
    write(repo, 'src/worse.ts', 'export const e = 5;\nconst f = 6;\nconst g = 7;\nconst h = 8;\n');
    commitAll(repo, 'add src');

    const lineMap = (n: number): Record<number, unknown> =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [i, { start: { line: i + 1 }, end: { line: i + 1 } }]),
      );
    /* 4 covered of 8 changed executable lines → 50% total, well under the 90 threshold. */
    writeCoverage(repo, {
      'src/covered.ts': { statementMap: lineMap(2), s: { 0: 1, 1: 1 } },
      'src/gap.ts': { statementMap: lineMap(2), s: { 0: 1, 1: 0 } },
      'src/worse.ts': { statementMap: lineMap(4), s: { 0: 1, 1: 0, 2: 0, 3: 0 } },
    });

    const r = runTool(repo, ['--base-ref', baseSha, '--threshold', '90']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    /* The aggregate's parenthetical counts are derived separately from `result.total` (one reduces
       `result.files`, the other comes out of computeCoverage), so nothing stopped the two halves of
       the same line from disagreeing: narrowing that reduce to the shortfall files alone prints
       `50% (4/6 changed lines)` — arithmetic that cannot be true — with every other assertion in
       the suite still green. Pin the whole line, not just the percentage. */
    assert.match(r.stdout, /^diff-coverage: 50% \(4\/8 changed lines\) threshold 90 — FAIL$/m);
    assert.match(r.stdout, /^ {2}uncovered: src\/gap\.ts 1\/2 changed lines \(50%\)$/m);
    assert.match(r.stdout, /^ {2}uncovered: src\/worse\.ts 1\/4 changed lines \(25%\)$/m);
    assert.equal(r.stdout.includes('src/covered.ts'), false, r.stdout);
    /* TWO shortfall files, and the worse one first. Both halves are load-bearing: with a single
       uncovered file in the fixture, a `.slice(0, 1)` cap would pass the test while contradicting
       the "not capped" contract, and nothing would pin the worst-first ordering that makes the
       list scannable. */
    assert.ok(
      r.stdout.indexOf('src/worse.ts') < r.stdout.indexOf('src/gap.ts'),
      `worst shortfall must be listed first:\n${r.stdout}`,
    );
  } finally {
    cleanup(repo);
  }
});
