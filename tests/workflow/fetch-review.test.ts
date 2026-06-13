import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fetchReview } from '../../workflow/src/fetch-review.ts';
import type { FetchReviewDeps } from '../../workflow/src/fetch-review.ts';
import { createGhAdapter } from '../../workflow/src/gh.ts';
import type { GhAdapter, GhReviewNode, GhReviewThreadNode } from '../../workflow/src/gh.ts';
import { runCli } from '../../workflow/src/cli.ts';
import type { CliIO } from '../../workflow/src/cli.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, EXIT_WRONG_STATE } from '../../workflow/src/types.ts';
import type { FeatureRecord } from '../../workflow/src/types.ts';

const ROOT = '/repo';
const STATE_PATH = path.join(ROOT, '.agents', 'handoffs', 'STATE.md');

function stateDoc(records: FeatureRecord[], extraTopKey = ''): string {
  const lines = ['---'];
  if (extraTopKey !== '') lines.push(extraTopKey);
  lines.push('features:');
  for (const record of records) {
    lines.push(
      `  - slug: "${record.slug}"`,
      `    branch: "${record.branch}"`,
      `    worktree: "${record.worktree}"`,
      `    pr: ${record.pr}`,
      `    review_state: "${record.review_state}"`,
    );
  }
  lines.push('---', '', '# Handoff State', '');
  return lines.join('\n');
}

const DEFAULT_RECORDS: FeatureRecord[] = [
  { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 42, review_state: 'awaiting_human_review' },
];

// Hand-built GhAdapter: only the TWO members fetch-review uses (repoInfo +
// prReviewData) behave; every other wrapper — including viewPr, which no longer
// supplies mergeability — throws so an unexpected call fails loudly, not silently.
function makeGh(opts: {
  owner?: string;
  name?: string;
  reviews?: GhReviewNode[];
  threads?: GhReviewThreadNode[];
  mergeable?: string | boolean | null;
  truncated?: { threads: boolean; comments: boolean };
  calls?: string[];
}): GhAdapter {
  const calls = opts.calls ?? [];
  const notImpl = (member: string) => (): never => {
    throw new Error(`unexpected gh call: ${member}`);
  };
  return {
    findPrByHead: notImpl('findPrByHead'),
    viewPr: notImpl('viewPr'),
    createPr: notImpl('createPr'),
    editPrBody: notImpl('editPrBody'),
    watchChecks: notImpl('watchChecks'),
    deleteLocalBranchArgs: notImpl('deleteLocalBranchArgs'),
    repoInfo: () => {
      calls.push('repoInfo');
      return { owner: opts.owner ?? 'acme', name: opts.name ?? 'repo' };
    },
    prReviewData: () => {
      calls.push('prReviewData');
      return {
        reviews: opts.reviews ?? [],
        threads: opts.threads ?? [],
        mergeable: opts.mergeable ?? 'MERGEABLE',
        truncated: opts.truncated ?? { threads: false, comments: false },
      };
    },
  } as GhAdapter;
}

function fixture(opts: {
  gh: GhAdapter;
  state?: string;
  branch?: string;
}) {
  const files = new Map<string, string>();
  files.set(STATE_PATH, opts.state ?? stateDoc(DEFAULT_RECORDS));
  const dirs: string[] = [];
  const errLines: string[] = [];
  const deps: FetchReviewDeps = {
    repoRoot: ROOT,
    statePath: STATE_PATH,
    readFile: (file) => {
      const value = files.get(file);
      if (value === undefined) throw new Error(`no such file: ${file}`);
      return value;
    },
    writeFile: (file, content) => {
      files.set(file, content);
    },
    mkdir: (dir) => {
      dirs.push(dir);
    },
    runGit: (args) => {
      if (args[0] === 'rev-parse') return `${opts.branch ?? 'feature/dark-mode'}\n`;
      return '';
    },
    gh: opts.gh,
    stderr: (text) => {
      errLines.push(text);
    },
  };
  return { files, dirs, errLines, deps };
}

function readReviewFile(files: Map<string, string>, pr: number, reviewId: number): unknown {
  const file = path.join(ROOT, 'reports', 'reviews', `pr-${pr}-review-${reviewId}.json`);
  const text = files.get(file);
  assert.ok(text !== undefined, `expected review file at ${file}`);
  return JSON.parse(text);
}

test('normalizes-latest-review-and-all-threads', () => {
  const fx = fixture({
    gh: makeGh({
      reviews: [
        { databaseId: 100, state: 'COMMENTED', submittedAt: '2026-06-10T00:00:00Z' },
        { databaseId: 200, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-12T00:00:00Z' },
      ],
      threads: [
        {
          id: 'PRRT_a',
          isResolved: false,
          comments: { nodes: [{ databaseId: 11, path: 'src/a.ts', line: 5, body: 'fix this', replyTo: null }] },
        },
        {
          id: 'PRRT_b',
          isResolved: false,
          comments: { nodes: [{ databaseId: 22, path: 'src/b.ts', line: null, body: 'and this', replyTo: null }] },
        },
      ],
    }),
  });

  const result = fetchReview({}, fx.deps);

  assert.equal(result.exitCode, EXIT_OK, result.message);
  assert.deepEqual(readReviewFile(fx.files, 42, 200), {
    pr: 42,
    review_id: 200,
    verdict: 'changes_requested',
    submitted_at: '2026-06-12T00:00:00Z',
    pr_mergeable: true,
    comments: [
      { id: 11, thread_id: 'PRRT_a', resolved: false, file: 'src/a.ts', line: 5, body: 'fix this', in_reply_to: 0 },
      { id: 22, thread_id: 'PRRT_b', resolved: false, file: 'src/b.ts', line: 0, body: 'and this', in_reply_to: 0 },
    ],
  });
});

test('resolved-threads-flagged-not-dropped', () => {
  const fx = fixture({
    gh: makeGh({
      reviews: [{ databaseId: 5, state: 'APPROVED', submittedAt: '2026-06-12T00:00:00Z' }],
      threads: [
        {
          id: 'PRRT_resolved',
          isResolved: true,
          comments: { nodes: [{ databaseId: 1, path: 'a.ts', line: 1, body: 'done already', replyTo: null }] },
        },
      ],
    }),
  });

  const result = fetchReview({}, fx.deps);
  assert.equal(result.exitCode, EXIT_OK, result.message);

  const review = readReviewFile(fx.files, 42, 5) as { comments: Array<{ id: number; resolved: boolean }> };
  assert.equal(review.comments.length, 1, 'resolved-thread comment is included, never dropped');
  assert.deepEqual(review.comments[0], {
    id: 1,
    thread_id: 'PRRT_resolved',
    resolved: true,
    file: 'a.ts',
    line: 1,
    body: 'done already',
    in_reply_to: 0,
  });
});

test('multi-comment-thread-order', () => {
  const fx = fixture({
    gh: makeGh({
      reviews: [{ databaseId: 9, state: 'COMMENTED', submittedAt: '2026-06-12T00:00:00Z' }],
      threads: [
        {
          id: 'PRRT_multi',
          isResolved: false,
          comments: {
            nodes: [
              { databaseId: 1, path: 'a.ts', line: 1, body: 'first', replyTo: null },
              { databaseId: 2, path: 'a.ts', line: 1, body: 'second', replyTo: { databaseId: 1 } },
              { databaseId: 3, path: 'a.ts', line: 1, body: 'third', replyTo: { databaseId: 1 } },
            ],
          },
        },
      ],
    }),
  });

  const result = fetchReview({}, fx.deps);
  assert.equal(result.exitCode, EXIT_OK, result.message);

  const review = readReviewFile(fx.files, 42, 9) as { comments: Array<{ id: number; in_reply_to: number; body: string }> };
  assert.deepEqual(review.comments.map((c) => c.id), [1, 2, 3]);
  assert.deepEqual(review.comments.map((c) => c.in_reply_to), [0, 1, 1]);
  assert.deepEqual(review.comments.map((c) => c.body), ['first', 'second', 'third']);
});

test('records-pr-mergeable', () => {
  const reviews: GhReviewNode[] = [{ databaseId: 3, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-12T00:00:00Z' }];

  const conflicting = fixture({ gh: makeGh({ reviews, mergeable: 'CONFLICTING' }) });
  assert.equal(fetchReview({}, conflicting.deps).exitCode, EXIT_OK);
  assert.equal((readReviewFile(conflicting.files, 42, 3) as { pr_mergeable: boolean }).pr_mergeable, false);

  const mergeable = fixture({ gh: makeGh({ reviews, mergeable: 'MERGEABLE' }) });
  assert.equal(fetchReview({}, mergeable.deps).exitCode, EXIT_OK);
  assert.equal((readReviewFile(mergeable.files, 42, 3) as { pr_mergeable: boolean }).pr_mergeable, true);
});

test('sets-processing-review', () => {
  const records: FeatureRecord[] = [
    { slug: 'other', branch: 'feature/other', worktree: '/wt/other', pr: 7, review_state: 'building' },
    { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 42, review_state: 'awaiting_human_review' },
  ];
  const before = stateDoc(records, 'schema: 1');
  const fx = fixture({
    state: before,
    gh: makeGh({ reviews: [{ databaseId: 8, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-12T00:00:00Z' }] }),
  });

  const result = fetchReview({}, fx.deps);
  assert.equal(result.exitCode, EXIT_OK, result.message);

  const after = fx.files.get(STATE_PATH) ?? '';
  // Target record advanced.
  assert.match(after, /slug: "dark-mode"[\s\S]*?review_state: "processing_review"/);
  // Unrelated record and unrelated top-level key round-trip byte-stable.
  assert.match(after, /slug: "other"[\s\S]*?review_state: "building"/);
  assert.match(after, /^schema: 1$/m);
  // The non-features key and the markdown body are unchanged byte-for-byte.
  assert.ok(after.startsWith('---\nschema: 1\nfeatures:\n'), 'top-level key order preserved');
  assert.ok(after.endsWith('\n# Handoff State\n'), 'markdown body preserved');
  // The ONLY review_state change is the target record.
  assert.equal((after.match(/review_state: "processing_review"/g) ?? []).length, 1);
});

test('gh-failure-error-contract', () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const responses = [
    { status: 1, stderr: 'gh: HTTP 503\nupstream unavailable\n' },
    { status: 0, stdout: '{}' },
  ];
  const spawn = (file: string, args: string[]) => {
    calls.push({ file, args });
    const response = responses.shift() ?? { status: 0, stdout: '{}' };
    return { status: response.status, stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  };

  const files = new Map<string, string>();
  files.set(STATE_PATH, stateDoc(DEFAULT_RECORDS));
  const errLines: string[] = [];
  const io: CliIO = {
    cwd: () => ROOT,
    readFile: (file) => {
      const value = files.get(file);
      if (value === undefined) throw new Error(`no such file: ${file}`);
      return value;
    },
    writeFile: (file, content) => {
      files.set(file, content);
    },
    mkdir: () => {},
    runGit: (args) => (args[0] === 'rev-parse' ? 'feature/dark-mode\n' : ''),
    stdout: () => {},
    stderr: (text) => {
      errLines.push(text);
    },
    ghAdapter: createGhAdapter({ spawn }),
  };

  const exit = runCli(['fetch-review'], io);

  assert.equal(exit, EXIT_FAILURE);
  assert.equal(calls.length, 1, 'a gh failure is surfaced once, never retried silently');
  const lastLine = errLines.join('').trimEnd().split('\n').at(-1) ?? '';
  const parsed = JSON.parse(lastLine) as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(parsed.error), ['command', 'step', 'message', 'stderr_tail']);
  assert.equal(parsed.error.step, 'repo-view');
  assert.equal(parsed.error.stderr_tail, 'gh: HTTP 503\nupstream unavailable');
  // STATE.md is untouched by a failed fetch.
  assert.equal(files.get(STATE_PATH), stateDoc(DEFAULT_RECORDS));
});

// ── §2.7 PR resolution (the --pr flag and its fallback) ──────────────────────

const TWO_RECORDS: FeatureRecord[] = [
  { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 42, review_state: 'awaiting_human_review' },
  { slug: 'light-mode', branch: 'feature/light-mode', worktree: '/wt/light', pr: 99, review_state: 'awaiting_human_review' },
];

test('pr-flag-matches-record-by-pr', () => {
  // Current branch is dark-mode (pr 42), but --pr 99 must advance the light-mode
  // record (matched by pr), NOT the current-branch record. Exactly two gh spawns.
  const calls: string[] = [];
  const fx = fixture({
    state: stateDoc(TWO_RECORDS),
    gh: makeGh({ reviews: [{ databaseId: 70, state: 'APPROVED', submittedAt: '2026-06-12T00:00:00Z' }], calls }),
  });

  const result = fetchReview({ pr: 99 }, fx.deps);

  assert.equal(result.exitCode, EXIT_OK, result.message);
  assert.equal(result.pr, 99);
  // The review file is written under the resolved PR.
  assert.deepEqual((readReviewFile(fx.files, 99, 70) as { pr: number }).pr, 99);
  const after = fx.files.get(STATE_PATH) ?? '';
  // ONLY the pr-99 record advanced; the current-branch record is left alone.
  assert.match(after, /slug: "light-mode"[\s\S]*?review_state: "processing_review"/);
  assert.match(after, /slug: "dark-mode"[\s\S]*?review_state: "awaiting_human_review"/);
  assert.equal((after.match(/review_state: "processing_review"/g) ?? []).length, 1);
  // mergeability now rides in prReviewData: exactly repoInfo + prReviewData, no viewPr.
  assert.deepEqual(calls, ['repoInfo', 'prReviewData']);
  // No spurious truncation warning on a within-cap PR.
  assert.equal(fx.errLines.length, 0);
});

test('no-pr-flag-resolves-by-current-branch', () => {
  // No --pr: the current branch's record (dark-mode, pr 42) supplies the PR.
  const fx = fixture({
    state: stateDoc(TWO_RECORDS),
    gh: makeGh({ reviews: [{ databaseId: 8, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-12T00:00:00Z' }] }),
  });

  const result = fetchReview({}, fx.deps);

  assert.equal(result.exitCode, EXIT_OK, result.message);
  assert.equal(result.pr, 42);
  assert.deepEqual((readReviewFile(fx.files, 42, 8) as { pr: number }).pr, 42);
  const after = fx.files.get(STATE_PATH) ?? '';
  assert.match(after, /slug: "dark-mode"[\s\S]*?review_state: "processing_review"/);
});

test('no-resolvable-pr-wrong-state', () => {
  // No --pr and the current-branch record carries no PR (pr 0): refuse with
  // EXIT_WRONG_STATE and leave STATE.md untouched.
  const records: FeatureRecord[] = [
    { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 0, review_state: 'building' },
  ];
  const before = stateDoc(records);
  const fx = fixture({ state: before, gh: makeGh({}) });

  const result = fetchReview({}, fx.deps);

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.message, /branch "feature\/dark-mode"/);
  assert.match(result.message, /--pr/);
  assert.equal(fx.files.get(STATE_PATH), before, 'STATE.md untouched on a wrong-state refusal');
});

test('pr-flag-mismatched-branch-record-wrong-state', () => {
  // --pr 99 matches no record by pr; the current-branch record is pr 42 (≠ 99),
  // so the fallback must REFUSE rather than advance the mismatched record.
  const records: FeatureRecord[] = [
    { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 42, review_state: 'awaiting_human_review' },
  ];
  const before = stateDoc(records);
  const fx = fixture({ state: before, gh: makeGh({}) });

  const result = fetchReview({ pr: 99 }, fx.deps);

  assert.equal(result.exitCode, EXIT_WRONG_STATE);
  assert.match(result.message, /is PR 42, not 99/);
  assert.equal(fx.files.get(STATE_PATH), before, 'STATE.md untouched on a mismatch refusal');
});

test('pr-flag-claims-unset-branch-record', () => {
  // --pr 99 matches no record by pr, but the current-branch record has pr 0 (unset)
  // — it may legitimately claim PR 99 and advance.
  const records: FeatureRecord[] = [
    { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 0, review_state: 'awaiting_human_review' },
  ];
  const fx = fixture({
    state: stateDoc(records),
    gh: makeGh({ reviews: [{ databaseId: 12, state: 'APPROVED', submittedAt: '2026-06-12T00:00:00Z' }] }),
  });

  const result = fetchReview({ pr: 99 }, fx.deps);

  assert.equal(result.exitCode, EXIT_OK, result.message);
  assert.equal(result.pr, 99);
  const after = fx.files.get(STATE_PATH) ?? '';
  assert.match(after, /slug: "dark-mode"[\s\S]*?review_state: "processing_review"/);
});

// ── §2.7 CLI argv parsing of --pr (exit 2) ───────────────────────────────────

function parseOnlyIo(): { io: CliIO; err: string[] } {
  const err: string[] = [];
  const io: CliIO = {
    cwd: () => ROOT,
    readFile: () => {
      throw new Error('unexpected readFile: a usage error must return before any IO');
    },
    writeFile: () => {
      throw new Error('unexpected writeFile');
    },
    mkdir: () => {},
    runGit: () => {
      throw new Error('unexpected runGit');
    },
    stdout: () => {},
    stderr: (text) => {
      err.push(text);
    },
  };
  return { io, err };
}

test('cli-pr-flag-rejects-non-integer', () => {
  const { io } = parseOnlyIo();
  assert.equal(runCli(['fetch-review', '--pr', 'x'], io), EXIT_USAGE);
});

test('cli-pr-flag-missing-value', () => {
  const { io } = parseOnlyIo();
  assert.equal(runCli(['fetch-review', '--pr'], io), EXIT_USAGE);
});

test('cli-pr-flag-rejects-duplicate', () => {
  const { io } = parseOnlyIo();
  assert.equal(runCli(['fetch-review', '--pr', '1', '--pr', '2'], io), EXIT_USAGE);
});

test('cli-pr-flag-rejects-non-positive', () => {
  const { io } = parseOnlyIo();
  assert.equal(runCli(['fetch-review', '--pr', '0'], io), EXIT_USAGE);
  assert.equal(runCli(['fetch-review', '--pr', '-3'], io), EXIT_USAGE);
});

// ── P3-3: non-silent truncation past the 100-item cap ────────────────────────

test('truncation-warns-to-stderr-and-still-writes', () => {
  const fx = fixture({
    gh: makeGh({
      reviews: [{ databaseId: 7, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-12T00:00:00Z' }],
      threads: [
        {
          id: 'PRRT_a',
          isResolved: false,
          comments: { nodes: [{ databaseId: 1, path: 'a.ts', line: 1, body: 'x', replyTo: null }] },
        },
      ],
      truncated: { threads: true, comments: true },
    }),
  });

  const result = fetchReview({}, fx.deps);

  // Truncation is NON-fatal: the command still succeeds and writes the file.
  assert.equal(result.exitCode, EXIT_OK, result.message);
  const review = readReviewFile(fx.files, 42, 7) as { comments: unknown[] };
  assert.equal(review.comments.length, 1, 'the fetched comment is still written');
  // A clear WARNING names exactly what overflowed and the cap.
  const warning = fx.errLines.join('');
  assert.match(warning, /WARNING/);
  assert.match(warning, /review threads and comments/);
  assert.match(warning, /100/);
});

// ── FIX 3 (P2): no synthetic review when none is submitted / PR node is null ──
// The §2.5 file is for the LATEST SUBMITTED review and the process-review
// precondition is a submitted PR review. When no review has been submitted (the
// would-be review_id:0 case) OR the PR node is null/missing, fetch-review must NOT
// fabricate a `pr-<n>-review-0.json` success and must NOT advance the record — it
// returns EXIT_WRONG_STATE, writes NO file, and leaves STATE.md untouched.

test('no-submitted-review-wrong-state-no-file-no-advance', () => {
  const before = stateDoc(DEFAULT_RECORDS);
  const fx = fixture({
    state: before,
    gh: makeGh({ reviews: [], threads: [] }), // PR exists, but nothing submitted
  });

  const result = fetchReview({}, fx.deps);

  assert.equal(result.exitCode, EXIT_WRONG_STATE, result.message);
  // NO review file written (in particular no synthetic pr-42-review-0.json).
  const synthetic = path.join(ROOT, 'reports', 'reviews', 'pr-42-review-0.json');
  assert.equal(fx.files.has(synthetic), false, 'no synthetic review-0 file');
  for (const key of fx.files.keys()) {
    assert.ok(!key.includes(path.join('reports', 'reviews')), `no review file written: ${key}`);
  }
  // STATE.md untouched (record not advanced to processing_review).
  assert.equal(fx.files.get(STATE_PATH), before, 'STATE.md untouched on a no-review refusal');
});

test('only-pending-or-dismissed-reviews-wrong-state', () => {
  // PENDING / DISMISSED are NOT submitted verdicts, so latestSubmittedReview yields
  // no submitted review — same WRONG_STATE refusal as an empty review list.
  const before = stateDoc(DEFAULT_RECORDS);
  const fx = fixture({
    state: before,
    gh: makeGh({
      reviews: [
        { databaseId: 1, state: 'PENDING', submittedAt: null },
        { databaseId: 2, state: 'DISMISSED', submittedAt: '2026-06-12T00:00:00Z' },
      ],
    }),
  });

  const result = fetchReview({}, fx.deps);

  assert.equal(result.exitCode, EXIT_WRONG_STATE, result.message);
  for (const key of fx.files.keys()) {
    assert.ok(!key.includes(path.join('reports', 'reviews')), `no review file written: ${key}`);
  }
  assert.equal(fx.files.get(STATE_PATH), before, 'STATE.md untouched');
});

test('null-pr-node-wrong-state-no-file-no-advance', () => {
  // A null/missing pullRequest node normalizes (in the adapter) to empty reviews +
  // null mergeable — fetch-review must refuse with WRONG_STATE, write no file, and
  // leave STATE.md untouched, exactly like the no-submitted-review case.
  const before = stateDoc(DEFAULT_RECORDS);
  const fx = fixture({
    state: before,
    gh: makeGh({ reviews: [], threads: [], mergeable: null }), // null PR node shape
  });

  const result = fetchReview({}, fx.deps);

  assert.equal(result.exitCode, EXIT_WRONG_STATE, result.message);
  const synthetic = path.join(ROOT, 'reports', 'reviews', 'pr-42-review-0.json');
  assert.equal(fx.files.has(synthetic), false, 'no synthetic review-0 file for a null PR node');
  assert.equal(fx.files.get(STATE_PATH), before, 'STATE.md untouched on a null-PR refusal');
});

// ── FIX 4 (P2): refuse to advance from invalid lifecycle states ──────────────
// §2.4 allows fetch-review only from awaiting_human_review or ci_failed (plus an
// idempotent re-run while already processing_review). A stale/hand-edited
// building/done/'' record with a matching PR must NOT be advanced to
// processing_review — return EXIT_WRONG_STATE, write no file, leave STATE.md
// untouched. The state-precondition guard runs BEFORE the gh fetch.

test('building-record-fetch-review-wrong-state-no-advance', () => {
  const records: FeatureRecord[] = [
    { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 42, review_state: 'building' },
  ];
  const before = stateDoc(records);
  const fx = fixture({
    state: before,
    // gh must NOT be called: the state guard precedes the fetch. makeGh()'s repoInfo/
    // prReviewData would still answer, so we additionally assert no file/advance.
    gh: makeGh({ reviews: [{ databaseId: 9, state: 'APPROVED', submittedAt: '2026-06-12T00:00:00Z' }] }),
  });

  const result = fetchReview({}, fx.deps);

  assert.equal(result.exitCode, EXIT_WRONG_STATE, result.message);
  for (const key of fx.files.keys()) {
    assert.ok(!key.includes(path.join('reports', 'reviews')), `no review file written: ${key}`);
  }
  assert.equal(fx.files.get(STATE_PATH), before, 'STATE.md untouched for a building record');
});

test('done-record-fetch-review-wrong-state-no-advance', () => {
  const records: FeatureRecord[] = [
    { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 42, review_state: 'done' },
  ];
  const before = stateDoc(records);
  const fx = fixture({
    state: before,
    gh: makeGh({ reviews: [{ databaseId: 9, state: 'APPROVED', submittedAt: '2026-06-12T00:00:00Z' }] }),
  });

  const result = fetchReview({}, fx.deps);

  assert.equal(result.exitCode, EXIT_WRONG_STATE, result.message);
  for (const key of fx.files.keys()) {
    assert.ok(!key.includes(path.join('reports', 'reviews')), `no review file written: ${key}`);
  }
  assert.equal(fx.files.get(STATE_PATH), before, 'STATE.md untouched for a done record');
});

test('ci-failed-and-processing-review-records-proceed', () => {
  // ci_failed proceeds (a re-fetch after CI failure), and an idempotent re-run while
  // already processing_review proceeds — both write the file and advance/stay.
  for (const startState of ['ci_failed', 'processing_review'] as const) {
    const records: FeatureRecord[] = [
      { slug: 'dark-mode', branch: 'feature/dark-mode', worktree: '/repo', pr: 42, review_state: startState },
    ];
    const fx = fixture({
      state: stateDoc(records),
      gh: makeGh({ reviews: [{ databaseId: 9, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-12T00:00:00Z' }] }),
    });

    const result = fetchReview({}, fx.deps);

    assert.equal(result.exitCode, EXIT_OK, `${startState} should proceed: ${result.message}`);
    assert.deepEqual((readReviewFile(fx.files, 42, 9) as { pr: number }).pr, 42, `${startState} writes the review file`);
    const after = fx.files.get(STATE_PATH) ?? '';
    assert.match(after, /slug: "dark-mode"[\s\S]*?review_state: "processing_review"/, `${startState} -> processing_review`);
  }
});
