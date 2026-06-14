import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXIT_ALREADY_DONE,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_WRONG_STATE,
} from '../../workflow/src/types.ts';
import type { FrontMatter, WorkflowState } from '../../workflow/src/types.ts';
import { parseFrontMatter, serializeFrontMatter } from '../../workflow/src/front-matter.ts';
import {
  readHeadWorkflowPhase,
  runGit,
  withWorkflowPhaseTrailer,
} from '../../workflow/src/trailers.ts';
import { computeDivergence, splitPlanningFile } from '../../workflow/src/recover.ts';
import { lockPathFor, realLockSeams } from '../../workflow/src/lock.ts';
import type { LockSeams } from '../../workflow/src/lock.ts';
import { gate } from '../../workflow/src/gate.ts';
import type { GateDeps } from '../../workflow/src/gate.ts';
import { complete, requestChanges, start } from '../../workflow/src/transactions.ts';
import type { TransactionDeps } from '../../workflow/src/transactions.ts';
import { resume } from '../../workflow/src/resume.ts';
import type { ResumeDeps } from '../../workflow/src/resume.ts';
import { runCli } from '../../workflow/src/cli.ts';
import type { CliIO } from '../../workflow/src/cli.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLANNING_FILE = 'workflow-session-planning.md';
const BODY = '\n# Plan\n\nthe plan body lives here\n';
const T0 = '2026-06-10T12:00:00Z';

// Distinct seat identities (claimed_by is just an opaque string). The producer
// owner claims plan/consolidate/implement; the reviewer owner claims the reviews.
const PRODUCER = 'pane-1:claude';
const REVIEWER = 'pane-2:codex';

function makeFrontMatter(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'dark-mode-toggle',
    branch: 'feature/dark-mode-toggle',
    worktree: '../app-dark-mode-toggle',
    base: 'main',
    base_sha: '9c1f2a',
    cmux_section: 'dark-mode-toggle',
    state: 'created',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: '',
    updated: T0,
    phases: {},
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-tx-'));
  runGit(['init', '-q'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Workflow Test'], dir);
  runGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Writes + commits a starting planning file whose Workflow-Phase trailer matches
// its `state`, so the durable record and runtime state agree (no divergence) at
// the start of a scenario. Returns the planning-file path.
function seed(dir: string, overrides: Partial<FrontMatter> = {}): string {
  const fm = makeFrontMatter(overrides);
  const planningPath = path.join(dir, PLANNING_FILE);
  fs.writeFileSync(planningPath, serializeFrontMatter(fm) + BODY);
  runGit(['add', '--', PLANNING_FILE], dir);
  runGit(['commit', '-q', '-m', withWorkflowPhaseTrailer('seed', fm.state)], dir);
  return planningPath;
}

interface DepOpts {
  claimedBy?: string;
  now?: () => number;
  lockSeams?: LockSeams;
  commitExclude?: string[];
  budget?: { totalSeconds: number; perPassSeconds?: number };
}

function txDeps(dir: string, planningPath: string, opts: DepOpts = {}): TransactionDeps {
  const deps: TransactionDeps = {
    planningFile: planningPath,
    worktree: dir,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    run: runGit,
    lockSeams: opts.lockSeams ?? realLockSeams(),
    now: opts.now ?? (() => Date.parse(T0)),
    claimedBy: opts.claimedBy ?? PRODUCER,
  };
  if (opts.commitExclude !== undefined) deps.commitExclude = opts.commitExclude;
  if (opts.budget !== undefined) deps.budget = opts.budget;
  return deps;
}

function resumeDeps(dir: string, planningPath: string, opts: DepOpts = {}): ResumeDeps {
  return txDeps(dir, planningPath, opts);
}

function readFm(planningPath: string): FrontMatter {
  const { frontMatterText } = splitPlanningFile(fs.readFileSync(planningPath, 'utf8'));
  return parseFrontMatter(frontMatterText);
}

function diverged(dir: string, planningPath: string): boolean {
  return computeDivergence({
    planningFile: planningPath,
    worktree: dir,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    run: runGit,
  });
}

function gateDeps(dir: string, planningPath: string): GateDeps {
  return {
    readState: () => readFm(planningPath),
    checkDivergence: () => diverged(dir, planningPath),
    now: () => 0,
    sleep: () => {},
    recordForcedAction: () => {},
  };
}

function commitCount(dir: string): number {
  const out = runGit(['rev-list', '--count', 'HEAD'], dir).trim();
  return out === '' ? 0 : Number(out);
}

function revParse(dir: string, rev: string): string {
  return runGit(['rev-parse', rev], dir).trim();
}

function commitMessage(dir: string, rev: string): string {
  return runGit(['log', '-1', '--format=%B', rev], dir);
}

function commitFiles(dir: string, rev: string): string[] {
  return runGit(['show', '--name-only', '--format=', rev], dir)
    .split('\n')
    .filter((l) => l !== '');
}

// `git status --porcelain` output, trimmed. Empty string == a clean worktree
// (nothing staged, modified, or untracked). The §2.10 lockfile is released before
// this is read, so it never shows up.
function porcelain(dir: string): string {
  return runGit(['status', '--porcelain'], dir).trim();
}

function writeCode(dir: string, name: string, contents: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return p;
}

// Drives plan -> plan-ready (start + complete) under the producer owner.
function drivePlanReady(dir: string, planningPath: string, opts: DepOpts = {}): void {
  start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER, ...opts }));
  complete('plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER, ...opts }));
}

// Drives plan-ready -> review-plan-inprogress (start review-plan) under reviewer.
function driveReviewPlanInprogress(dir: string, planningPath: string, opts: DepOpts = {}): void {
  drivePlanReady(dir, planningPath, opts);
  start('review-plan', txDeps(dir, planningPath, { claimedBy: REVIEWER, ...opts }));
}

// ── 1. start ─────────────────────────────────────────────────────────────────

test('start-sets-claimed-start-sha-attempts', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    const seedSha = revParse(dir, 'HEAD');

    const res = start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));

    assert.equal(res.exitCode, EXIT_OK);
    assert.equal(res.outcome, 'started');
    assert.equal(res.toState, 'plan-inprogress');

    const fm = readFm(planningPath);
    assert.equal(fm.state, 'plan-inprogress');
    assert.equal(fm.claimed_by, PRODUCER, 'start claims the phase for the caller');
    const record = fm.phases.plan;
    assert.ok(record, 'a plan phase record is created');
    assert.equal(record.start_sha, seedSha, 'start_sha anchors on the prior resting commit');
    assert.equal(record.attempts, 1, 'attempts is incremented from 0');
    assert.equal(diverged(dir, planningPath), false, 'start carries its own trailer');
  } finally {
    cleanup(dir);
  }
});

// ── 2. complete (single-commit fold) ─────────────────────────────────────────

test('complete-folds-mutation-into-trailer-commit', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    const before = commitCount(dir);

    const res = complete('plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER }));

    assert.equal(res.exitCode, EXIT_OK);
    assert.equal(res.toState, 'plan-ready');
    assert.equal(commitCount(dir), before + 1, 'the mutation folds into ONE commit');
    assert.match(commitMessage(dir, 'HEAD'), /Workflow-Phase: plan-ready/, 'trailer rides the same commit');
    assert.deepEqual(commitFiles(dir, 'HEAD'), [PLANNING_FILE], 'only the planning file is committed');

    const fm = readFm(planningPath);
    assert.equal(fm.state, 'plan-ready', 'front-matter mutation is folded in');
    assert.equal(fm.phases.plan?.last_success_loop, 0, 'phase marked succeeded in this round');
    // Fix 3 (P2): the planning-phase complete_sha is recorded as null in the single
    // trailered transaction commit and NO post-commit rewrite is made, so the tree
    // stays CLEAN. The trailer commit itself is the planning phase's "complete_sha"
    // (derivable if ever needed; NOT consumed by gate/transitions/recover).
    assert.equal(fm.phases.plan?.complete_sha, null, 'planning-phase complete_sha is null (no post-commit rewrite)');
    assert.equal(porcelain(dir), '', 'the worktree is CLEAN after complete (no dirty planning metadata)');
    assert.equal(diverged(dir, planningPath), false);
  } finally {
    cleanup(dir);
  }
});

// ── 3. implement-plan two-commit shape ───────────────────────────────────────

test('implement-two-commit-shape-anchors-on-code-commit', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    drivePlanReady(dir, planningPath);
    start('review-plan', txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    complete('review-plan', { approved: true }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    // plan-consolidated reached via auto-advance; now implement.
    start('implement-plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    writeCode(dir, 'feature.ts', 'export const f = 1;\n');
    writeCode(dir, 'helper.ts', 'export const g = 2;\n');
    const before = commitCount(dir);

    const res = complete('implement-plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER }));

    assert.equal(res.exitCode, EXIT_OK);
    assert.equal(res.toState, 'implemented');
    assert.equal(commitCount(dir), before + 2, 'two commits: code, then planning');

    // HEAD = the planning commit: planning file only, WITH the trailer.
    assert.deepEqual(commitFiles(dir, 'HEAD'), [PLANNING_FILE]);
    assert.match(commitMessage(dir, 'HEAD'), /Workflow-Phase: implemented/);

    // HEAD~1 = the CODE commit: the code files, NO trailer. complete_sha anchors here.
    const codeSha = revParse(dir, 'HEAD~1');
    assert.deepEqual(commitFiles(dir, 'HEAD~1').sort(), ['feature.ts', 'helper.ts']);
    assert.doesNotMatch(commitMessage(dir, 'HEAD~1'), /Workflow-Phase:/, 'the code commit carries no trailer');

    const fm = readFm(planningPath);
    assert.equal(fm.phases['implement-plan']?.complete_sha, codeSha, 'complete_sha anchors on the CODE commit');
    assert.equal(fm.state, 'implemented');
    assert.equal(readHeadWorkflowPhase(dir, runGit), 'implemented', 'trailer reachable past the untrailed code commit');
    assert.equal(diverged(dir, planningPath), false);
  } finally {
    cleanup(dir);
  }
});

test('implement-refuses-pre-staged-excluded-path-before-code-commit', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    driveReviewPlanInprogress(dir, planningPath);
    complete('review-plan', { approved: true }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    start('implement-plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    writeCode(dir, 'feature.ts', 'export const f = 1;\n');
    writeCode(dir, 'sub/debug.log', 'nested noise\n');
    runGit(['add', '--', 'sub/debug.log'], dir);
    const before = commitCount(dir);

    assertCommitScopeRefusal(() =>
      complete('implement-plan', {}, txDeps(dir, planningPath, {
        claimedBy: PRODUCER,
        commitExclude: ['*.log'],
      })),
    );

    assert.equal(commitCount(dir), before, 'no code or failure commit was made');
    assert.equal(readFm(planningPath).state, 'implement-inprogress', 'state is unchanged');
    assert.deepEqual(commitFiles(dir, 'HEAD'), [PLANNING_FILE], 'HEAD is still the implement start commit');
  } finally {
    cleanup(dir);
  }
});

// ── 4. ownership refusal ─────────────────────────────────────────────────────

test('complete-refuses-wrong-claimed-by', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    start('plan', txDeps(dir, planningPath, { claimedBy: 'owner-A' }));
    const before = commitCount(dir);

    const res = complete('plan', {}, txDeps(dir, planningPath, { claimedBy: 'intruder-B' }));

    assert.equal(res.outcome, 'wrong-owner');
    assert.equal(res.exitCode, EXIT_WRONG_STATE, 'a wrong-claimed_by refusal maps to WRONG_STATE (ownership precondition)');
    assert.equal(commitCount(dir), before, 'a refused complete makes no commit');
    assert.equal(readFm(planningPath).state, 'plan-inprogress', 'state is untouched');
  } finally {
    cleanup(dir);
  }
});

// ── 5. request-changes accumulation ──────────────────────────────────────────

test('request-changes-increments-loopback-and-budget', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    const clock = () => Date.parse(T0);
    driveReviewPlanInprogress(dir, planningPath, { now: clock });
    // The review pass runs for 5s before changes are requested.
    const later = () => Date.parse(T0) + 5000;

    const res = requestChanges(
      'plan',
      { reason: 'tighten the error handling' },
      txDeps(dir, planningPath, { claimedBy: REVIEWER, now: later }),
    );

    assert.equal(res.exitCode, EXIT_OK);
    assert.equal(res.outcome, 'changes-requested');
    assert.equal(res.toState, 'plan-changes-requested');

    const fm = readFm(planningPath);
    assert.equal(fm.loopback_count, 1, 'loopback_count is incremented');
    assert.equal(fm.budget_spent.total_seconds, 5, 'the rejected pass duration is accumulated');
    assert.equal(fm.state, 'plan-changes-requested');
    assert.match(commitMessage(dir, 'HEAD'), /tighten the error handling/, 'the reason rides the commit body');
    assert.equal(diverged(dir, planningPath), false);
  } finally {
    cleanup(dir);
  }
});

// ── 6. ADR-009 auto-advance ──────────────────────────────────────────────────

test('approved-review-plan-auto-advances-same-transaction', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    driveReviewPlanInprogress(dir, planningPath);
    const before = commitCount(dir);

    const res = complete('review-plan', { approved: true }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));

    assert.equal(res.autoAdvanced, true, 'the approved review auto-advances');
    assert.equal(res.toState, 'plan-consolidated');
    assert.equal(commitCount(dir), before + 1, 'the auto-advance is the SAME transaction (one commit)');

    const fm = readFm(planningPath);
    assert.equal(fm.state, 'plan-consolidated');
    assert.equal(fm.phases['review-plan']?.last_success_loop, 0);
    // §2.9 pinned write shape.
    const consolidate = fm.phases['consolidate-plan'];
    assert.ok(consolidate, 'a consolidate-plan record is written');
    assert.equal(consolidate.auto_advanced, true, 'auto_advanced: true is written');
    assert.equal(consolidate.last_success_loop, 0, 'keyed on the current loopback_count');
    // Fix 3 (P2): the auto-advance no longer rewrites complete_sha post-commit, so
    // both the review-plan and the auto-advanced consolidate complete_sha stay null
    // and the worktree stays CLEAN (the contracted dirty-refusing `ship` won't trip).
    assert.equal(fm.phases['review-plan']?.complete_sha, null, 'review-plan complete_sha is null');
    assert.equal(consolidate.complete_sha, null, 'auto-advanced consolidate complete_sha is null');
    assert.equal(porcelain(dir), '', 'the worktree is CLEAN after the auto-advance complete');
    assert.equal(readHeadWorkflowPhase(dir, runGit), 'plan-consolidated', 'the single trailer is the final resting state');

    // §2.9: the consolidate gate now observes ALREADY_DONE (no agent launched).
    const g = gate('consolidate-plan', { waitSeconds: 60 }, gateDeps(dir, planningPath));
    assert.equal(g.outcome, 'already-done');
    assert.equal(g.exitCode, EXIT_ALREADY_DONE);
    assert.equal(diverged(dir, planningPath), false);
  } finally {
    cleanup(dir);
  }
});

// ── 7. no auto-advance without --approved ────────────────────────────────────

test('non-approved-review-plan-does-not-auto-advance', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    driveReviewPlanInprogress(dir, planningPath);

    const res = complete('review-plan', {}, txDeps(dir, planningPath, { claimedBy: REVIEWER }));

    assert.notEqual(res.autoAdvanced, true);
    assert.equal(res.toState, 'plan-reviewed', 'state rests at plan-reviewed');

    const fm = readFm(planningPath);
    assert.equal(fm.state, 'plan-reviewed');
    assert.equal(fm.phases['consolidate-plan'], undefined, 'consolidate is NOT auto-advanced');

    // The consolidate gate still PROCEEDs (its precondition is met), not already-done.
    const g = gate('consolidate-plan', { waitSeconds: 60 }, gateDeps(dir, planningPath));
    assert.equal(g.outcome, 'proceed');
    assert.equal(diverged(dir, planningPath), false);
  } finally {
    cleanup(dir);
  }
});

// ── 8. last_success_loop keying ──────────────────────────────────────────────

test('re-review-not-skipped-after-loopback', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    // Round 0: plan -> review-plan --approved (review-plan.last_success_loop = 0).
    driveReviewPlanInprogress(dir, planningPath);
    complete('review-plan', { approved: true }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));

    // In round 0 the review-plan gate self-completes (skips re-running).
    const round0 = gate('review-plan', { waitSeconds: 60 }, gateDeps(dir, planningPath));
    assert.equal(round0.outcome, 'already-done', 'round 0: keyed on last_success_loop == loopback_count');

    // Advance to a review-implementation that loops back to implement-plan,
    // bumping the global loopback_count to 1.
    start('implement-plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    writeCode(dir, 'impl.ts', 'export const x = 1;\n');
    complete('implement-plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    start('review-implementation', txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    const rc = requestChanges('implement-plan', { reason: 'rework the edge case' }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    assert.equal(rc.toState, 'impl-changes-requested');
    assert.equal(readFm(planningPath).loopback_count, 1, 'the loopback bumped the global counter');

    // After the loopback, review-plan's prior-round success no longer keys to the
    // current round, so its gate is NOT skipped (re-review is never lost).
    const round1 = gate('review-plan', { waitSeconds: 60 }, gateDeps(dir, planningPath));
    assert.notEqual(round1.outcome, 'already-done', 'after the loopback the prior success does not skip re-review');
    assert.notEqual(round1.exitCode, EXIT_ALREADY_DONE);
  } finally {
    cleanup(dir);
  }
});

// ── 9. lock serialization ────────────────────────────────────────────────────

test('concurrent-complete-vs-request-changes-serialized', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    driveReviewPlanInprogress(dir, planningPath);
    const before = commitCount(dir);

    // Simulate another holder of the worktree mutex: a live-PID lockfile.
    fs.writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquired_at: T0 }),
    );

    // Fast-failing seams: the clock jumps past the retry budget, the holder PID is
    // alive (never stolen), sleep is a no-op -> deterministic LOCK_BUSY in zero time.
    const busySeams = (): LockSeams => {
      let t = Date.parse(T0);
      return {
        now: () => {
          const v = t;
          t += 10_000;
          return v;
        },
        sleep: () => {},
        isPidAlive: () => true,
        pid: process.pid,
        hostname: os.hostname(),
        warn: () => {},
      };
    };

    // Both mutating verbs are serialized behind the held lock -> LOCK_BUSY.
    assert.throws(
      () => complete('review-plan', { approved: true }, txDeps(dir, planningPath, { claimedBy: REVIEWER, lockSeams: busySeams() })),
      /LOCK_BUSY|could not acquire/,
      'complete is blocked while the lock is held',
    );
    assert.throws(
      () => requestChanges('plan', { reason: 'x' }, txDeps(dir, planningPath, { claimedBy: REVIEWER, lockSeams: busySeams() })),
      /LOCK_BUSY|could not acquire/,
      'request-changes is blocked while the lock is held',
    );
    assert.equal(commitCount(dir), before, 'no blocked verb mutated anything');
    assert.equal(readFm(planningPath).state, 'review-plan-inprogress', 'state untouched while serialized out');

    // Release the lock: exactly one verb now proceeds (serialized, one at a time).
    fs.unlinkSync(lockPathFor(dir));
    const res = requestChanges('plan', { reason: 'rework it' }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    assert.equal(res.exitCode, EXIT_OK);
    assert.equal(readFm(planningPath).state, 'plan-changes-requested');
    assert.equal(readFm(planningPath).loopback_count, 1);
  } finally {
    cleanup(dir);
  }
});

// §5 Concurrency: concurrent `start`. `start` is a mutating verb that takes the
// same worktree mutex (withLock) as complete/request-changes, so two racers
// cannot both claim a phase. A held live lock blocks the racer (LOCK_BUSY, zero
// mutation); on release exactly one `start` claims the seat (attempts -> 1).
test('concurrent-start-serialized-one-claims-seat', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    const before = commitCount(dir);

    // Another holder of the worktree mutex: a live-PID lockfile.
    fs.writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquired_at: T0 }),
    );

    // Fast-failing seams: clock jumps past the retry budget, holder PID alive
    // (never stolen), sleep is a no-op -> deterministic LOCK_BUSY in zero time.
    const busySeams = (): LockSeams => {
      let t = Date.parse(T0);
      return {
        now: () => {
          const v = t;
          t += 10_000;
          return v;
        },
        sleep: () => {},
        isPidAlive: () => true,
        pid: process.pid,
        hostname: os.hostname(),
        warn: () => {},
      };
    };

    // The racing `start` is serialized behind the held lock -> LOCK_BUSY.
    assert.throws(
      () => start('plan', txDeps(dir, planningPath, { claimedBy: REVIEWER, lockSeams: busySeams() })),
      /LOCK_BUSY|could not acquire/,
      'a second start is blocked while the lock is held',
    );
    assert.equal(commitCount(dir), before, 'the blocked start mutated nothing');
    assert.equal(readFm(planningPath).state, 'created', 'state untouched while serialized out');
    assert.equal(readFm(planningPath).claimed_by, '', 'no seat claimed while blocked');

    // Release the lock: exactly one start now proceeds and claims the seat.
    fs.unlinkSync(lockPathFor(dir));
    const res = start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    assert.equal(res.exitCode, EXIT_OK);
    const fm = readFm(planningPath);
    assert.equal(fm.state, 'plan-inprogress');
    assert.equal(fm.claimed_by, PRODUCER, 'the winning start claims the seat');
    assert.equal(fm.phases.plan?.attempts, 1, 'attempts incremented exactly once');
  } finally {
    cleanup(dir);
  }
});

// ── 10. the divergence invariant (robustness, beyond the pinned set) ─────────

test('happy-path-never-diverges', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    assert.equal(diverged(dir, planningPath), false, 'rest: created');

    start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    assert.equal(diverged(dir, planningPath), false, 'rest: plan-inprogress');
    complete('plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    assert.equal(diverged(dir, planningPath), false, 'rest: plan-ready');

    start('review-plan', txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    assert.equal(diverged(dir, planningPath), false, 'rest: review-plan-inprogress');
    complete('review-plan', { approved: true }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    assert.equal(diverged(dir, planningPath), false, 'rest: plan-consolidated (auto-advanced)');

    start('implement-plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    assert.equal(diverged(dir, planningPath), false, 'rest: implement-inprogress');
    writeCode(dir, 'src.ts', 'export const v = 42;\n');
    complete('implement-plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    assert.equal(diverged(dir, planningPath), false, 'rest: implemented (past the untrailed code commit)');

    start('review-implementation', txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    assert.equal(diverged(dir, planningPath), false, 'rest: review-impl-inprogress');
    complete('review-implementation', { approved: true }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    assert.equal(diverged(dir, planningPath), false, 'rest: implementation-reviewed');

    assert.equal(readFm(planningPath).state, 'implementation-reviewed', 'reached the end of the reviewed main line');
  } finally {
    cleanup(dir);
  }
});

// ── CLI wiring (file-reading callers through runCli) ─────────────────────────

interface CliCapture {
  io: CliIO;
  out: () => string;
  err: () => string;
}

function makeCliIO(dir: string, claimedBy: string): CliCapture {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    cwd: () => dir,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    runGit,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => Date.parse(T0),
    sleep: () => {},
    claimedBy,
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

test('cli-wires-start-complete-and-gate', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    const cap = makeCliIO(dir, PRODUCER);

    assert.equal(runCli(['start', 'plan', '--file', planningPath], cap.io, realLockSeams()), EXIT_OK);
    assert.equal(readFm(planningPath).state, 'plan-inprogress');

    assert.equal(runCli(['complete', 'plan', '--file', planningPath], cap.io, realLockSeams()), EXIT_OK);
    assert.equal(readFm(planningPath).state, 'plan-ready');

    // The review-plan gate now PROCEEDs (its precondition plan-ready is met).
    const code = runCli(['gate', 'review-plan', '--file', planningPath], cap.io, realLockSeams());
    assert.equal(code, EXIT_OK);
    assert.match(cap.out(), /review-plan proceed/);
  } finally {
    cleanup(dir);
  }
});

test('cli-complete-wrong-owner-maps-to-wrong-state-exit', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    runCli(['start', 'plan', '--file', planningPath], makeCliIO(dir, 'owner-A').io, realLockSeams());

    const code = runCli(['complete', 'plan', '--file', planningPath], makeCliIO(dir, 'intruder-B').io, realLockSeams());
    assert.equal(code, EXIT_WRONG_STATE);
    assert.equal(readFm(planningPath).state, 'plan-inprogress', 'the refused complete did not advance state');
  } finally {
    cleanup(dir);
  }
});

test('cli-gate-force-records-forced-action-under-lock', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir); // state: created
    const cap = makeCliIO(dir, 'pane-9:human');

    // implement-plan's precondition is unmet at `created` -> wrong-state, which
    // --force overrides, recording a forced action persisted under the lock.
    const code = runCli(
      ['gate', 'implement-plan', '--force', '--reason', 'manual recovery', '--file', planningPath],
      cap.io,
      realLockSeams(),
    );
    assert.equal(code, EXIT_OK);
    assert.match(cap.out(), /implement-plan forced-proceed/);

    const fm = readFm(planningPath);
    assert.equal(fm.forced_actions?.length, 1);
    assert.equal(fm.forced_actions?.[0]?.reason, 'manual recovery');
    assert.equal(fm.forced_actions?.[0]?.from_state, 'created');
    assert.equal(fm.forced_actions?.[0]?.claimed_by, 'pane-9:human');
  } finally {
    cleanup(dir);
  }
});

// Installs an executable pre-commit hook that rejects every commit, so a `complete`
// transaction's `git commit` fails with a non-zero status (driving the structured
// GitError -> §2.7 machine-readable error path) without any global git config.
function installFailingPreCommitHook(dir: string): void {
  const hooksDir = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by fixture pre-commit hook" 1>&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
}

function installFailingWorkflowPhaseCommitMsgHook(dir: string): void {
  const hooksDir = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'commit-msg');
  fs.writeFileSync(
    hook,
    '#!/bin/sh\nif grep -q "Workflow-Phase:" "$1"; then\n  echo "rejected workflow trailer commit" 1>&2\n  exit 1\nfi\n',
  );
  fs.chmodSync(hook, 0o755);
}

// ── Fix 4: git failures emit the §2.7 machine-readable error (last stderr line) ─

test('git-commit-failure-emits-machine-readable-error-as-last-stderr-line', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    // Reach plan-inprogress (the seed + this start commit succeed; the hook is
    // installed only AFTER, so it bites the `complete` planning commit).
    runCli(['start', 'plan', '--file', planningPath], makeCliIO(dir, PRODUCER).io, realLockSeams());
    assert.equal(readFm(planningPath).state, 'plan-inprogress');

    installFailingPreCommitHook(dir);

    const cap = makeCliIO(dir, PRODUCER);
    const code = runCli(['complete', 'plan', '--file', planningPath], cap.io, realLockSeams());

    // The git failure exits FAILURE (1) — no new exit code, no silent retry.
    assert.equal(code, EXIT_FAILURE, 'a git/infra failure exits 1');

    // The LAST line of stderr parses as the §2.7 machine-readable error object.
    const stderr = cap.err();
    const lines = stderr.split('\n').filter((l) => l.trim() !== '');
    const last = lines[lines.length - 1];
    assert.ok(last, 'stderr has a final line');
    const parsed = JSON.parse(last) as { error?: { command?: string; stderr_tail?: string; message?: string } };
    assert.ok(parsed.error, 'the last line is the { error: ... } object (§2.7)');
    assert.ok(
      typeof parsed.error.command === 'string' && parsed.error.command.startsWith('git commit'),
      'the error names the failing git command',
    );
    assert.ok(
      typeof parsed.error.stderr_tail === 'string' && /rejected by fixture pre-commit hook/.test(parsed.error.stderr_tail),
      'the error carries the git stderr tail',
    );
    assert.ok(typeof parsed.error.message === 'string' && parsed.error.message.length > 0, 'a message is populated');
  } finally {
    cleanup(dir);
  }
});

// ── Atomicity (P1): a refused or failed transaction leaves the tree UNCHANGED ──
//
// Every state-mutating verb saves the advanced front matter then commits it. If
// the commit is REFUSED (a foreign path was pre-staged -> the planning-only
// commit shape is violated) or FAILS (a pre-commit hook rejects it), the verb
// must leave the planning file EXACTLY as it was — `state` not advanced, the tree
// non-divergent — so the next gate/verb does not see a phantom divergence that
// `recover` would have to rewind.

// Stages an unrelated, already-tracked file so the index carries a FOREIGN path
// at the top of the transaction (the planning-only commit-shape refusal trigger).
function stageForeignFile(dir: string): void {
  const foreign = writeCode(dir, 'foreign.txt', 'v1\n');
  runGit(['add', '--', 'foreign.txt'], dir);
  // Make it a tracked, committed file first so it is unambiguously a foreign
  // staged CHANGE vs HEAD when we re-stage a modification below.
  runGit(['commit', '-q', '-m', 'chore: add foreign file'], dir);
  fs.writeFileSync(foreign, 'v2\n');
  runGit(['add', '--', 'foreign.txt'], dir);
}

// A foreign staged path violates the planning-only commit shape. The refusal is a
// thrown CommitScopeError carrying EXIT_WRONG_STATE (the established commit-scope
// refusal path; the CLI maps it to exit 11). The pre-flight check fires BEFORE any
// save, so `state` on disk never advances.
function assertCommitScopeRefusal(fn: () => unknown): void {
  assert.throws(
    fn,
    (err: unknown) =>
      err instanceof Error &&
      (err as { kind?: unknown }).kind === 'commit-scope' &&
      (err as { exitCode?: unknown }).exitCode === EXIT_WRONG_STATE,
    'refuses with a CommitScopeError carrying EXIT_WRONG_STATE',
  );
}

test('start-refusal-with-foreign-staged-file-leaves-state-unchanged', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    stageForeignFile(dir);
    const before = commitCount(dir);
    const stateBefore = readFm(planningPath).state;

    assertCommitScopeRefusal(() => start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER })));

    assert.equal(commitCount(dir), before, 'no commit was made');
    assert.equal(readFm(planningPath).state, stateBefore, 'the planning state is UNCHANGED');
    assert.equal(diverged(dir, planningPath), false, 'the tree is non-divergent after the refusal');
  } finally {
    cleanup(dir);
  }
});

test('complete-refusal-with-foreign-staged-file-leaves-state-unchanged', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    stageForeignFile(dir);
    const before = commitCount(dir);
    const stateBefore = readFm(planningPath).state; // plan-inprogress

    assertCommitScopeRefusal(() => complete('plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER })));

    assert.equal(commitCount(dir), before, 'no commit was made');
    assert.equal(readFm(planningPath).state, stateBefore, 'the planning state is UNCHANGED (not advanced to plan-ready)');
    assert.equal(diverged(dir, planningPath), false, 'the tree is non-divergent after the refusal');
  } finally {
    cleanup(dir);
  }
});

test('start-commit-failure-records-failed-state', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    const before = commitCount(dir);
    installFailingPreCommitHook(dir);

    assert.throws(
      () => start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER })),
      'a rejected commit propagates as a throw',
    );

    assert.equal(commitCount(dir), before + 1, 'one failed-state commit was recorded');
    assert.equal(readFm(planningPath).state, 'plan-failed', 'the hook rejection records the phase failure state');
    assert.match(commitMessage(dir, 'HEAD'), /Workflow-Phase: plan-failed/, 'the failed-state commit carries a matching trailer');
    assert.match(commitMessage(dir, 'HEAD'), /rejected by fixture pre-commit hook/, 'the hook output is captured');
    assert.equal(diverged(dir, planningPath), false, 'the tree is non-divergent after the hook rejection');
    assert.equal(porcelain(dir), '', 'the tree is fully CLEAN — the advanced state is not left staged in the index');
  } finally {
    cleanup(dir);
  }
});

test('complete-commit-failure-records-failed-state', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    start('plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    const before = commitCount(dir);
    installFailingPreCommitHook(dir); // bites the complete planning commit

    assert.throws(
      () => complete('plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER })),
      'a rejected commit propagates as a throw',
    );

    assert.equal(commitCount(dir), before + 1, 'one failed-state commit was recorded');
    const fm = readFm(planningPath);
    assert.equal(fm.state, 'plan-failed', 'the hook rejection records the phase failure state');
    assert.equal(fm.phases.plan?.last_success_loop, null, 'a failed complete is not recorded as a phase success');
    assert.equal(fm.phases.plan?.complete_sha, null, 'a failed complete has no completion sha');
    assert.match(commitMessage(dir, 'HEAD'), /Workflow-Phase: plan-failed/, 'the failed-state commit carries a matching trailer');
    assert.match(commitMessage(dir, 'HEAD'), /rejected by fixture pre-commit hook/, 'the hook output is captured');
    assert.equal(diverged(dir, planningPath), false, 'the tree is non-divergent after the hook rejection');
    assert.equal(porcelain(dir), '', 'the tree is fully CLEAN — the advanced state is not left staged in the index');
  } finally {
    cleanup(dir);
  }
});

test('implement-planning-commit-failure-does-not-record-phase-success', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir);
    driveReviewPlanInprogress(dir, planningPath);
    complete('review-plan', { approved: true }, txDeps(dir, planningPath, { claimedBy: REVIEWER }));
    start('implement-plan', txDeps(dir, planningPath, { claimedBy: PRODUCER }));
    writeCode(dir, 'feature.ts', 'export const f = 1;\n');
    const before = commitCount(dir);
    installFailingWorkflowPhaseCommitMsgHook(dir);

    assert.throws(
      () => complete('implement-plan', {}, txDeps(dir, planningPath, { claimedBy: PRODUCER })),
      'the rejected planning commit propagates as a throw',
    );

    assert.equal(commitCount(dir), before + 2, 'code commit lands, then one failed-state commit is recorded');
    assert.deepEqual(commitFiles(dir, 'HEAD~1'), ['feature.ts'], 'the untrailed code commit is retained');
    const fm = readFm(planningPath);
    assert.equal(fm.state, 'implement-failed');
    assert.equal(fm.phases['implement-plan']?.last_success_loop, null, 'failed planning commit is not a successful implement');
    assert.equal(fm.phases['implement-plan']?.complete_sha, null, 'failed planning commit does not record the code sha as complete');
    assert.match(commitMessage(dir, 'HEAD'), /Workflow-Phase: implement-failed/);
    assert.equal(diverged(dir, planningPath), false);
  } finally {
    cleanup(dir);
  }
});

test('request-changes-commit-failure-does-not-persist-needs-human-or-counter-mutations', () => {
  const dir = initRepo();
  try {
    const planningPath = seed(dir, { loopback_cap: 0 });
    const clock = () => Date.parse(T0);
    driveReviewPlanInprogress(dir, planningPath, { now: clock });
    const before = commitCount(dir);
    installFailingPreCommitHook(dir);

    assert.throws(
      () => requestChanges(
        'plan',
        { reason: 'tighten the error handling' },
        txDeps(dir, planningPath, {
          claimedBy: REVIEWER,
          now: () => Date.parse(T0) + 5000,
        }),
      ),
      'the rejected request-changes commit propagates as a throw',
    );

    assert.equal(commitCount(dir), before + 1, 'one failed-state commit was recorded');
    const fm = readFm(planningPath);
    assert.equal(fm.state, 'review-plan-failed');
    assert.equal(fm.loopback_count, 0, 'failed request-changes does not consume a loopback round');
    assert.equal(fm.budget_spent.total_seconds, 0, 'failed request-changes does not consume budget');
    assert.equal(fm.needs_human_reason, undefined, 'failed-state record is not also needs-human');
    assert.equal(fm.needs_human_from, undefined, 'failed-state record has no needs-human return state');
    assert.equal(diverged(dir, planningPath), false);
  } finally {
    cleanup(dir);
  }
});

// resume smoke (bonus): a refused resume (foreign staged file) leaves needs-human
// state untouched and the tree non-divergent — same atomicity guarantee.
test('resume-refusal-with-foreign-staged-file-leaves-state-unchanged', () => {
  const dir = initRepo();
  try {
    // Seed a needs-human record whose durable trailer agrees (no entry divergence).
    const planningPath = seed(dir, {
      state: 'needs-human',
      needs_human_reason: 'guide-missing',
      needs_human_from: 'plan-ready',
    });
    stageForeignFile(dir);
    const before = commitCount(dir);

    assertCommitScopeRefusal(() => resume(resumeDeps(dir, planningPath)));

    assert.equal(commitCount(dir), before, 'no commit was made');
    assert.equal(readFm(planningPath).state, 'needs-human', 'the needs-human state is UNCHANGED');
    assert.equal(diverged(dir, planningPath), false, 'the tree is non-divergent after the refusal');
  } finally {
    cleanup(dir);
  }
});
