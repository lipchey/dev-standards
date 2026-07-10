/* Real-git e2e harness for the deep-review engine (Phase 5 §5.7). Unlike the
   unit suites under tests/deep-review/ (which inject seams), these drive the
   engine end-to-end: the real CLI entrypoint is spawned via tsx ON SOURCE inside
   a throwaway git repo, with EVERY git invocation env-isolated
   (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, HOME=<tmp>, a local core.hooksPath) so the
   host's global config / hooks / gpg can never leak in and make a case
   non-deterministic. No mock-sims — the git graph, worktrees, trailers, locks and
   descriptors are all real. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* The dev-standards checkout root (this file is tests/deep-review-e2e/helper.ts). */
export const REPO_ROOT = path.resolve(HERE, '../..');
/* The local tsx binary (NEVER npx — a network launcher) + the engine source
   entrypoint. Verbs run through tsx on SOURCE, not the built bundle. */
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const RUNNER_ENTRY = path.join(REPO_ROOT, 'deep-review', 'src', 'deep-review-runner.ts');

/* A throwaway sandbox: an isolated repo, an isolated HOME, an empty hooks dir, and
   the env every git/verb call in the case must carry. `root` is realpath'd so
   worktree-list comparisons (macOS /tmp -> /private/tmp) match the engine's own
   realpath normalization. */
export interface Sandbox {
  root: string;
  repo: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

/* The env that isolates a git process from host config + hooks. `HOME` points at a
   throwaway dir; the global/system config files are neutered to /dev/null; hooks
   are pinned per-repo via `core.hooksPath` (set in initRepoDir). */
function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

/* A single env-isolated git call; throws (with cwd + stderr) on non-zero so a
   fixture-setup failure is loud rather than silently producing a bad repo. */
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} (in ${cwd}) failed [${r.status}]: ${r.stderr ?? ''}`);
  }
  return r.stdout ?? '';
}

export interface VerbResult {
  status: number;
  stdout: string;
  stderr: string;
}

/* Spawns the real deep-review CLI (tsx on source) with cwd = the fixture repo (or
   run-worktree) and the isolated env. The child's exit code IS the verb's exit
   code (deep-review-runner.ts calls process.exit). `extraEnv` threads case-specific
   knobs (e.g. a pidfile path for the group-kill assertion) into the child. */
export function runVerb(cwd: string, args: string[], env: NodeJS.ProcessEnv, extraEnv: Record<string, string> = {}): VerbResult {
  const childEnv = Object.keys(extraEnv).length === 0 ? env : { ...env, ...extraEnv };
  const r = spawnSync(TSX_BIN, [RUNNER_ENTRY, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) throw new Error(`failed to spawn tsx: ${r.error.message}`);
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function writeFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function writeExecutable(dir: string, rel: string, content: string): void {
  writeFile(dir, rel, content);
  fs.chmodSync(path.join(dir, rel), 0o755);
}

/* The committed source the AI "fixes": the slice edits src/app.ts from ORIGINAL to
   EDITED. The edit is what commit-slice validates + lands. */
export const ORIGINAL = 'export const a = 1;\n';
export const EDITED = 'export const a = 2;\n';

/* Verify-shim bodies (committed as `verify`, checked out into the one-shot
   validation worktree). GREEN -> commit lands; RED -> fix-failed while writing a
   residue file into its cwd (the tmp worktree) so a case can prove the residue
   never reaches the live tree. */
export const GREEN_SHIM = '#!/usr/bin/env bash\nexit 0\n';
export const RED_SHIM = '#!/usr/bin/env bash\nmkdir -p coverage\necho residue > coverage/lcov.info\nexit 1\n';
/* A verify shim that spawns a detached-group grandchild (recorded in
   $DR_E2E_PIDFILE) and then blocks far past the tiny run deadline, so the run's
   timeout must SIGKILL the whole process group — the group-kill assertion reads
   the pidfile back and confirms the grandchild died. */
export const TIMEOUT_SHIM = '#!/usr/bin/env bash\nsleep 30 &\nprintf %s "$!" > "$DR_E2E_PIDFILE"\nsleep 30\n';

const DEFAULT_PROJECT_FACTS = `# Project facts

## Layer map
- \`src/**\` — application code

## Domain terms
- app: the sample module under test

## No-Touch Zones

## Repo type
- node-service, solo
`;

export interface QualityOpts {
  budgetSeconds?: number | undefined;
  noTouchGlobsRef?: string | undefined;
}

/* A minimal VALID quality manifest with deep_review enabled for
   review-and-refactor. `paths.reports` is `reports/quality`, and the fixture
   gitignores `/reports/` so the findings file (+ its lock + the written report)
   live under the reports root — passing mutateFindings' confinement while staying
   invisible to commit-slice's scope gate. */
export function qualityJson(opts: QualityOpts = {}): string {
  const deepReview: Record<string, unknown> = {
    enabled: true,
    trigger: 'manual-only',
    modes: ['review-only', 'review-and-refactor'],
    budget: { seconds: opts.budgetSeconds ?? 900 },
    guides_dir: '.agents/review-guides',
  };
  if (opts.noTouchGlobsRef !== undefined) deepReview['no_touch_globs_ref'] = opts.noTouchGlobsRef;
  const manifest = {
    version: 1,
    repo: 'e2e-fixture',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 120, fast_seconds: 300, full_seconds: 900, audit_seconds: 1800 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: false,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [],
    tiers: { staged: [], fast: [], full: [] },
    deep_review: deepReview,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface CoreFixtureOpts {
  budgetSeconds?: number;
  /* Verify-shim body, or null to OMIT the shim entirely (drives the spawn-fault ->
     infra-blocked case: the validation worktree has no `verify` to spawn). */
  verifyShim?: string | null;
  projectFacts?: string;
  noTouchGlobsRef?: string;
  /* Extra committed files (rel -> content), staged into the initial commit. */
  extraFiles?: Record<string, string>;
}

function initRepoDir(root: string, repo: string, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main'], env);
  git(repo, ['config', 'user.email', 'e2e@example.com'], env);
  git(repo, ['config', 'user.name', 'E2E Test'], env);
  git(repo, ['config', 'commit.gpgsign', 'false'], env);
  /* Pin hooks to an empty dir so no host hook (or a fixture pre-commit) fires
     unless a case installs one deliberately. */
  const hooks = path.join(root, 'empty-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  git(repo, ['config', 'core.hooksPath', hooks], env);
}

/* Builds a committed core-repo fixture (no consumer gitlink) ready for
   select-worktree: quality.json, project-facts, a review-guide, src/app.ts at
   ORIGINAL, a green `verify` shim, and a gitignored reports root. */
export function initCoreRepo(opts: CoreFixtureOpts = {}): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-e2e-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const repo = path.join(root, 'repo');
  const env = isolatedEnv(home);
  initRepoDir(root, repo, env);

  writeFile(repo, '.gitignore', '/reports/\n');
  writeFile(repo, 'quality.json', qualityJson({ budgetSeconds: opts.budgetSeconds, noTouchGlobsRef: opts.noTouchGlobsRef }));
  writeFile(repo, '.agents/project-facts.md', opts.projectFacts ?? DEFAULT_PROJECT_FACTS);
  writeFile(repo, '.agents/review-guides/core.md', '# Core review guide\n\n- placeholder\n');
  writeFile(repo, 'src/app.ts', ORIGINAL);
  if (opts.verifyShim !== null) writeExecutable(repo, 'verify', opts.verifyShim ?? GREEN_SHIM);
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) writeFile(repo, rel, content);

  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', 'init'], env);
  return { root, repo, home, env };
}

/* A consumer-repo fixture: a real repo whose `vendor/dev-standards` is a genuine
   gitlink submodule (added over file:// with `protocol.file.allow=always`, which
   git >=2.38 requires for local submodule transport), carrying a committed
   pre-commit hook. The main checkout holds the tooling SOURCES a fresh run-worktree
   symlinks (built dist / node_modules / .tools) plus the build stamp
   (runner/dist/.built-from). `stampFresh` sets the stamp to the pinned submodule SHA
   (tooling wires successfully) or a bogus SHA (setupWorktreeTooling must fail loud).
   The predicted run-worktree path is returned so the stale case can assert rollback. */
export interface Consumer extends Sandbox {
  pinnedSha: string;
  worktreePath: string;
  branch: string;
}

export function initConsumerRepo(opts: { stampFresh: boolean; slug?: string } ): Consumer {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-e2e-consumer-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  /* Allow the file:// submodule transport git >=2.38 blocks by default, injected as
     ISOLATED config via GIT_CONFIG_* env so it propagates to EVERY nested git child
     — including the engine's own `submodule update --init` clone, which does not
     pass `-c` and would otherwise fail `transport 'file' not allowed`. (A repo-local
     `protocol.file.allow` is NOT honored by that nested clone.) */
  const env = isolatedEnv(home, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: 'always',
  });

  /* The upstream dev-standards repo that becomes the submodule source. */
  const substd = path.join(root, 'substd');
  fs.mkdirSync(substd, { recursive: true });
  git(substd, ['init', '-q', '-b', 'main'], env);
  git(substd, ['config', 'user.email', 'e2e@example.com'], env);
  git(substd, ['config', 'user.name', 'E2E Test'], env);
  git(substd, ['config', 'commit.gpgsign', 'false'], env);
  writeFile(substd, 'README.md', '# upstream dev-standards\n');
  git(substd, ['add', '-A'], env);
  git(substd, ['commit', '-q', '-m', 'upstream init'], env);

  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main'], env);
  git(repo, ['config', 'user.email', 'e2e@example.com'], env);
  git(repo, ['config', 'user.name', 'E2E Test'], env);
  git(repo, ['config', 'commit.gpgsign', 'false'], env);
  /* A real committed pre-commit hook + per-repo hooksPath (a realistic consumer). */
  writeExecutable(repo, '.githooks/pre-commit', '#!/usr/bin/env bash\nexit 0\n');
  git(repo, ['config', 'core.hooksPath', '.githooks'], env);

  writeFile(repo, '.gitignore', '/reports/\n');
  writeFile(repo, 'quality.json', qualityJson());
  writeFile(repo, '.agents/project-facts.md', DEFAULT_PROJECT_FACTS);
  writeFile(repo, '.agents/review-guides/core.md', '# Core review guide\n\n- placeholder\n');
  writeFile(repo, 'src/app.ts', ORIGINAL);
  writeExecutable(repo, 'verify', GREEN_SHIM);
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', 'init'], env);

  git(repo, ['submodule', 'add', `file://${substd}`, 'vendor/dev-standards'], env);
  git(repo, ['commit', '-q', '-m', 'add vendor/dev-standards submodule'], env);
  const pinnedSha = git(repo, ['rev-parse', 'HEAD:vendor/dev-standards'], env).trim();

  /* The tooling SOURCES + build stamp, created AFTER the commits so they stay
     untracked fs artifacts in the main checkout (exactly how a bootstrapped dist
     lives). */
  const stamp = opts.stampFresh ? pinnedSha : 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  writeFile(repo, 'vendor/dev-standards/runner/dist/.built-from', `${stamp}\n`);
  writeFile(repo, 'vendor/dev-standards/runner/dist/verify-runner.mjs', '/* built */\n');
  writeFile(repo, 'vendor/dev-standards/deep-review/dist/deep-review-runner.mjs', '/* built */\n');
  writeFile(repo, 'node_modules/.keep', '');
  writeFile(repo, '.tools/.keep', '');

  const slug = opts.slug ?? 'e2e';
  const worktreePath = path.join(root, 'worktrees', `${DIR_PREFIX}${slug}`);
  return { root, repo, home, env, pinnedSha, worktreePath, branch: `${BRANCH_PREFIX}${slug}` };
}

/* Mirrors worktree.ts' fixed engine conventions so a consumer case can predict the
   worktree dir + branch without parsing (used to assert rollback on failure). */
const DIR_PREFIX = 'deep-review-';
const BRANCH_PREFIX = 'deep-review/';

/* Runs select-worktree and returns the created run-worktree path (parsed from the
   `dedicated <path> <branch>` line). Throws with the captured output on any
   non-zero exit so a fixture failure surfaces immediately. */
export function selectWorktree(repo: string, env: NodeJS.ProcessEnv, slug = 'e2e'): string {
  const res = runVerb(repo, ['select-worktree', '--slug', slug], env);
  if (res.status !== 0) throw new Error(`select-worktree failed [${res.status}]: ${res.stderr}${res.stdout}`);
  const parts = res.stdout.trim().split(' ');
  const wt = parts[1];
  if (wt === undefined || wt === '') throw new Error(`could not parse worktree path from: ${JSON.stringify(res.stdout)}`);
  return wt;
}

/* The run descriptor written by select-worktree, read straight off the worktree's
   absolute git-dir — a case uses its run_id/base_sha/initial_head_sha to hand-write
   a BOUND findings file (or to assert the recorded run identity). */
export interface RunDescriptorShape {
  run_id: string;
  base_sha: string;
  initial_head_sha: string;
  branch_ref: string;
  canonical_root: string;
}

export function readRunDescriptor(worktree: string, env: NodeJS.ProcessEnv): RunDescriptorShape {
  const gitDir = git(worktree, ['rev-parse', '--absolute-git-dir'], env).trim();
  const raw = fs.readFileSync(path.join(gitDir, 'deep-review-run.json'), 'utf8');
  return JSON.parse(raw) as RunDescriptorShape;
}

/* ── Findings builders (schema v2) ─────────────────────────────────────────── */

export interface FindingOver {
  id?: string;
  file?: string;
  slice_files?: string[];
  classification?: 'fixable-now' | 'no-touch' | 'needs-plan' | '';
  status?: string;
  test_ref?: 'verify:fast' | 'verify:full';
  needs_plan?: boolean;
  sha?: string;
}

export function finding(over: FindingOver = {}): Record<string, unknown> {
  const file = over.file ?? 'src/app.ts';
  return {
    id: over.id ?? 'f-001',
    severity: 'P1',
    file,
    line: 1,
    title: 'fix the thing',
    impact: 'x',
    needs_plan: over.needs_plan ?? false,
    test_ref: over.test_ref ?? 'verify:fast',
    slice_files: over.slice_files ?? [file],
    classification: over.classification ?? '',
    status: over.status ?? 'pending',
    sha: over.sha ?? '',
  };
}

export interface FindingsOver {
  mode?: 'review-only' | 'review-and-refactor';
  run_id?: string | null;
  base_sha?: string | null;
  verification?: unknown;
}

export function findingsFile(findings: Array<Record<string, unknown>>, over: FindingsOver = {}): string {
  const file = {
    schema: 2,
    mode: over.mode ?? 'review-and-refactor',
    generated_at: '2026-01-01T00:00:00Z',
    run_id: over.run_id ?? null,
    base_sha: over.base_sha ?? null,
    revision: 0,
    verification: over.verification ?? null,
    findings,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/* Writes a findings file under the (gitignored) reports root of `cwd`, creating the
   reports dir so mutateFindings' realpath confinement resolves. Returns the
   repo-relative path passed to `--findings`. */
export const FINDINGS_REL = 'reports/quality/findings.json';

export function placeFindings(cwd: string, json: string): string {
  writeFile(cwd, FINDINGS_REL, json);
  return FINDINGS_REL;
}

export function readFindingsJson(cwd: string): { revision: number; verification: unknown; findings: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(cwd, FINDINGS_REL), 'utf8');
  return JSON.parse(raw) as { revision: number; verification: unknown; findings: Array<Record<string, unknown>> };
}

export function findingById(cwd: string, id: string): Record<string, unknown> | undefined {
  return readFindingsJson(cwd).findings.find((f) => f['id'] === id);
}

/* Best-effort teardown: force-remove all leaked worktrees, then the sandbox root.
   Never throws — a leaked worktree is prunable and must not fail an otherwise-green
   case. */
export function cleanup(box: Sandbox): void {
  try {
    git(box.repo, ['worktree', 'prune'], box.env);
  } catch {
    /* repo may already be gone */
  }
  try {
    fs.rmSync(box.root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
