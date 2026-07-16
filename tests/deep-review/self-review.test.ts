import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSelfReview } from '../../deep-review/src/self-review.ts';
import type { SelfReviewDeps } from '../../deep-review/src/self-review.ts';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';
import { FindingsConflictError } from '../../deep-review/src/findings-io.ts';
import { createDeadline } from '../../deep-review/src/deadline.ts';
import { EXIT_FAILURE, EXIT_FINDINGS_CONFLICT, EXIT_OK, EXIT_WRONG_STATE } from '../../deep-review/src/types.ts';
import type { FindingsFileV2 } from '../../deep-review/src/types.ts';
import type { DescriptorVerdict, RunDescriptor } from '../../deep-review/src/descriptor.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_QUALITY = path.resolve(HERE, '..', '..', 'quality.json');
const HEAD_SHA = 'a'.repeat(40);

function baseFile(revision = 7): FindingsFileV2 {
  return {
    schema: 2,
    mode: 'review-and-refactor',
    generated_at: '2026-07-15T00:00:00Z',
    run_id: 'run-1',
    base_sha: 'base-1',
    revision,
    verification: null,
    self_review: null,
    findings: [],
  };
}

function baseDeps(over: Partial<SelfReviewDeps> = {}): SelfReviewDeps {
  return {
    cwd: '/work/tree',
    findingsPath: '/work/tree/reports/quality/findings.json',
    deadline: createDeadline(900),
    readHead: () => HEAD_SHA,
    getStatus: () => '',
    readFindings: () => baseFile(),
    mutate: (_path, fn) => fn(baseFile()),
    now: () => '2026-07-15T12:34:56.000Z',
    ...over,
  };
}

test('writes a HEAD-bound self-review record with verdict, note, timestamp, and revision CAS', () => {
  const events: string[] = [];
  const written: FindingsFileV2[] = [];
  let expectedRevision: number | undefined;
  const deps = baseDeps({
    readFindings: () => {
      events.push('read-findings');
      return baseFile();
    },
    readHead: (cwd, deadline) => {
      events.push('read-head');
      assert.equal(cwd, '/work/tree');
      assert.equal(typeof deadline.remainingMs(), 'number');
      return HEAD_SHA;
    },
    mutate: (_path, fn, expected) => {
      events.push('mutate');
      expectedRevision = expected;
      const next = fn(baseFile());
      written.push(next);
      return next;
    },
  });
  const result = runSelfReview(
    { verdict: 'clean', note: 'same-lens review complete' },
    deps,
  );
  assert.equal(result.exitCode, EXIT_OK);
  assert.deepEqual(events, ['read-findings', 'read-head', 'mutate']);
  assert.equal(expectedRevision, 7);
  assert.deepEqual(written[0]?.self_review, {
    sha: HEAD_SHA,
    verdict: 'clean',
    noted_at: '2026-07-15T12:34:56.000Z',
    note: 'same-lens review complete',
  });
});

test('a non-tooling-dirty worktree returns EXIT_WRONG_STATE and does not mutate findings', () => {
  let mutated = false;
  const result = runSelfReview(
    { verdict: 'clean' },
    baseDeps({
      getStatus: () => ' M src/app.ts\n',
      mutate: (_path, fn) => {
        mutated = true;
        return fn(baseFile());
      },
    }),
  );
  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.equal(result.machineError?.step, 'self-review');
  assert.match(result.machineError?.message ?? '', /uncommitted non-tooling changes/);
  assert.equal(mutated, false);
});

test('a worktree dirty only with engine tooling (node_modules) still records the verdict', () => {
  let mutated = false;
  const result = runSelfReview(
    { verdict: 'clean' },
    baseDeps({
      getStatus: () => '?? node_modules/\n?? .tools/\n',
      mutate: (_path, fn) => {
        mutated = true;
        return fn(baseFile());
      },
    }),
  );
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(mutated, true);
});

test('HEAD-read failure returns EXIT_FAILURE and does not mutate findings', () => {
  let mutated = false;
  const result = runSelfReview(
    { verdict: 'violation' },
    baseDeps({
      readHead: () => {
        throw new Error('git rev-parse HEAD failed');
      },
      mutate: (_path, fn) => {
        mutated = true;
        return fn(baseFile());
      },
    }),
  );
  assert.equal(result.exitCode, EXIT_FAILURE);
  assert.equal(result.machineError?.step, 'self-review');
  assert.match(result.machineError?.message ?? '', /rev-parse HEAD failed/);
  assert.equal(mutated, false);
});

test('revision conflict propagates EXIT_FINDINGS_CONFLICT without replacing the record', () => {
  const conflict = new FindingsConflictError(
    '/work/tree/reports/quality/findings.json.lock',
    null,
    'findings revision conflict: expected 7, found 8',
  );
  assert.throws(
    () =>
      runSelfReview(
        { verdict: 'clean' },
        baseDeps({
          mutate: () => {
            throw conflict;
          },
        }),
      ),
    (error: unknown) =>
      error instanceof FindingsConflictError && error.exitCode === EXIT_FINDINGS_CONFLICT,
  );
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('CLI maps a self-review findings conflict to EXIT_FINDINGS_CONFLICT', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-self-review-')));
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Self Review Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    const manifest = JSON.parse(fs.readFileSync(REPO_QUALITY, 'utf8')) as Record<string, unknown>;
    manifest['deep_review'] = {
      enabled: true,
      modes: ['review-only', 'review-and-refactor'],
      guides_dir: 'guides',
      budget: { seconds: 900 },
    };
    fs.writeFileSync(path.join(repo, 'quality.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    /* Gitignore the reports root so the findings file + its lock are not porcelain dirt —
       matches the consumer seed, so the self-review capture gate sees a clean tree. */
    fs.writeFileSync(path.join(repo, '.gitignore'), '/reports/\n');
    git(repo, ['add', 'quality.json', '.gitignore']);
    git(repo, ['commit', '-q', '-m', 'init']);

    const reports = path.join(repo, 'reports', 'quality');
    fs.mkdirSync(reports, { recursive: true });
    const findingsPath = path.join(reports, 'findings.json');
    fs.writeFileSync(findingsPath, `${JSON.stringify(baseFile(3), null, 2)}\n`);
    fs.writeFileSync(
      `${findingsPath}.lock`,
      JSON.stringify({ pid: process.pid, nonce: 'live-holder', created_at: '2026-07-15T00:00:00Z' }),
    );
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const descriptor: RunDescriptor = {
      schema: 1,
      run_id: 'run-1',
      created_at: 't',
      canonical_root: repo,
      git_dir: path.join(repo, '.git'),
      git_common_dir: path.join(repo, '.git'),
      branch_ref: 'refs/heads/main',
      base_ref: 'refs/heads/main',
      base_sha: 'base-1',
      initial_head_sha: head,
    };
    const errors: string[] = [];
    const deps: CliDeps = {
      stdout: () => {},
      stderr: (text) => errors.push(text),
      cwd: () => repo,
      verifyDescriptor: (): DescriptorVerdict => ({ ok: true, descriptor }),
    };
    const code = runCli(
      ['self-review', '--findings', findingsPath, '--verdict', 'clean'],
      deps,
    );
    assert.equal(code, EXIT_FINDINGS_CONFLICT);
    assert.match(errors.join(''), /locked by a live process/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
