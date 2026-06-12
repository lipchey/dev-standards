import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
} from '../../workflow/src/types.ts';
import type { FrontMatter, WorkflowState } from '../../workflow/src/types.ts';
import { serializeFrontMatter, parseFrontMatter } from '../../workflow/src/front-matter.ts';
import { gate } from '../../workflow/src/gate.ts';
import type { GateDeps, GateOptions } from '../../workflow/src/gate.ts';
import { runCli } from '../../workflow/src/cli.ts';
import type { CliIO } from '../../workflow/src/cli.ts';
import { realLockSeams } from '../../workflow/src/lock.ts';
import {
  diverges,
  lastWorkflowPhaseTrailer,
  readHeadWorkflowPhase,
  runGit,
  withWorkflowPhaseTrailer,
  WORKFLOW_PHASE_TRAILER_KEY,
} from '../../workflow/src/trailers.ts';
import { computeDivergence, recover } from '../../workflow/src/recover.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLANNING_FILE = 'workflow-session-planning.md';
const BODY = '\n# Plan\n\nthe plan body lives here\n';

// A complete, schema-valid FrontMatter; tests override only what the case is
// about. Serialized through the real serializer so the on-disk fixture is, by
// construction, a parseable planning file (no hand-rolled YAML to drift).
function makeFrontMatter(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'dark-mode-toggle',
    branch: 'feature/dark-mode-toggle',
    worktree: '../app-dark-mode-toggle',
    base: 'main',
    base_sha: '9c1f2a',
    cmux_section: 'dark-mode-toggle',
    state: 'plan-inprogress',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: 'pane-2:claude',
    updated: '2026-06-10T12:00:00Z',
    phases: {},
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

// A throwaway worktree dir that is ALSO a real git repo. The planning file,
// the lockfile, and any code commits live inside it; the whole tree is removed
// on cleanup. Real git is exercised (real trailer parsing, real commit graph).
function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-recover-'));
  runGit(['init', '-q'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Workflow Test'], dir);
  // Isolate from any host gpg-signing / commit template config.
  runGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Writes the planning file (front matter + markdown body) into the repo.
function writePlanning(dir: string, fm: FrontMatter): string {
  const planningPath = path.join(dir, PLANNING_FILE);
  fs.writeFileSync(planningPath, serializeFrontMatter(fm) + BODY);
  return planningPath;
}

// Commits ONLY the named paths (never `git add -A`) with the given message; the
// trailer, when provided, is folded in through the real formatter so the commit
// graph carries the durable Workflow-Phase authority exactly as `complete` will.
function commit(
  dir: string,
  paths: string[],
  subject: string,
  trailer?: WorkflowState,
): void {
  for (const p of paths) runGit(['add', '--', p], dir);
  const message = trailer === undefined ? subject : withWorkflowPhaseTrailer(subject, trailer);
  runGit(['commit', '-q', '-m', message], dir);
}

function readState(planningPath: string): WorkflowState {
  return parseFrontMatter(extractFrontMatter(fs.readFileSync(planningPath, 'utf8'))).state;
}

// Slice out the leading fenced block (the parser rejects content after the
// closing fence), mirroring how `status` reads a real markdown planning file.
function extractFrontMatter(text: string): string {
  const lines = text.split('\n');
  if (lines[0] !== '---') return text;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') return `${lines.slice(0, i + 1).join('\n')}\n`;
  }
  return text;
}

function commitCount(dir: string): number {
  return runGit(['rev-list', '--count', 'HEAD'], dir).trim() === ''
    ? 0
    : Number(runGit(['rev-list', '--count', 'HEAD'], dir).trim());
}

function recoverDeps(dir: string, planningPath: string) {
  return {
    planningFile: planningPath,
    worktree: dir,
    readFile: (p: string) => fs.readFileSync(p, 'utf8'),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
    run: runGit,
    lockSeams: realLockSeams(),
  };
}

// ── Pure trailer-format/parse unit tests + the day-one fixture ───────────────

test('trailer-written-from-day-one', () => {
  // (pure) The formatter appends a normalized `Workflow-Phase: <state>` trailer.
  const first = withWorkflowPhaseTrailer('feat(x): create the feature', 'created');
  assert.match(first, /\nWorkflow-Phase: created$/, 'trailer is appended as the last line');
  assert.equal(WORKFLOW_PHASE_TRAILER_KEY, 'Workflow-Phase');

  // (pure) The reader extracts the most-recent trailer; bodies are newest-first.
  assert.equal(lastWorkflowPhaseTrailer([first]), 'created');
  assert.equal(
    lastWorkflowPhaseTrailer([
      'chore: untrailed code commit on top',
      withWorkflowPhaseTrailer('feat: prior', 'plan-ready'),
    ]),
    'plan-ready',
    'the newest trailer wins; an untrailed top commit is skipped',
  );

  // (pure) Re-applying normalizes: one trailer, the latest value, never doubled.
  const renormalized = withWorkflowPhaseTrailer(first, 'plan-ready');
  const occurrences = renormalized.split('\n').filter((l) => l.startsWith('Workflow-Phase:'));
  assert.equal(occurrences.length, 1, 'the trailer is replaced, not duplicated');
  assert.equal(lastWorkflowPhaseTrailer([renormalized]), 'plan-ready');

  // The durable recovery authority exists from the VERY FIRST commit: a fresh
  // repo whose first transition commit carries the trailer is readable at HEAD.
  const dir = initRepo();
  try {
    const planningPath = writePlanning(dir, makeFrontMatter({ state: 'created' }));
    commit(dir, [planningPath], 'feat(workflow): new feature', 'created');
    assert.equal(
      readHeadWorkflowPhase(dir, runGit),
      'created',
      'HEAD trailer is the durable authority from commit #1',
    );
  } finally {
    cleanup(dir);
  }
});

test('trailer-read-only-from-the-final-trailer-block', () => {
  // REGRESSION (P2): the reader scanned the WHOLE body bottom-up and returned ANY
  // `Workflow-Phase:` line — even ordinary body PROSE followed by more non-trailer
  // lines. A user code commit whose body mentions `Workflow-Phase: shipped` in
  // prose was misread as the durable authority -> false divergence / wrong recover.
  // The reader must take the trailer ONLY from the FINAL trailer block (the last
  // paragraph that is entirely git-trailer-shaped), mirroring the writer.

  // (a) `Workflow-Phase: shipped` as body prose, FOLLOWED by a non-trailer line:
  // the last paragraph is NOT a pure trailer block -> NO trailer (skipped).
  const prose =
    'feat: unrelated user commit\n\n' +
    'Discussing the Workflow-Phase: shipped milestone in prose here.\n' +
    'and then more narrative follows on the next line.\n';
  assert.equal(
    lastWorkflowPhaseTrailer([prose]),
    null,
    'a Workflow-Phase line in non-final-block prose is NOT read as a trailer',
  );

  // (b) A real final-block trailer is read (the writer's own output).
  const real = withWorkflowPhaseTrailer('feat: ship it', 'shipped');
  assert.equal(lastWorkflowPhaseTrailer([real]), 'shipped', 'a real final-block trailer is read');

  // (c) A multi-trailer final block (e.g. a future Co-Authored-By alongside the
  // phase trailer) still parses the Workflow-Phase trailer correctly.
  const multi =
    'fix: something\n\nCo-Authored-By: Someone <s@example.com>\nWorkflow-Phase: implemented';
  assert.equal(lastWorkflowPhaseTrailer([multi]), 'implemented', 'multi-trailer final block parses');

  // (d) The request-changes body shape (subject + reason paragraph + final trailer)
  // reads the trailer correctly — the helper writes exactly this shape.
  const requestChangesBody = withWorkflowPhaseTrailer(
    'workflow(plan): changes requested -> plan-changes-requested\n\ntighten the error handling',
    'plan-changes-requested',
  );
  assert.equal(
    lastWorkflowPhaseTrailer([requestChangesBody]),
    'plan-changes-requested',
    'the request-changes body (subject + reason + final trailer) reads the trailer',
  );

  // (e) End-to-end: a non-helper code commit whose body MENTIONS the trailer in
  // prose on top of a real trailered commit does NOT shadow the durable authority.
  const dir = initRepo();
  try {
    const planningPath = writePlanning(dir, makeFrontMatter({ state: 'plan-ready' }));
    commit(dir, [planningPath], 'feat(workflow): plan ready', 'plan-ready');
    // A user code commit on top mentioning the trailer in prose (not a trailer).
    const codeFile = path.join(dir, 'note.txt');
    fs.writeFileSync(codeFile, 'x\n');
    runGit(['add', '--', 'note.txt'], dir);
    runGit(
      [
        'commit',
        '-q',
        '-m',
        'chore: notes\n\nWorkflow-Phase: shipped was discussed here.\nmore prose after it.',
      ],
      dir,
    );
    assert.equal(
      readHeadWorkflowPhase(dir, runGit),
      'plan-ready',
      'the prose mention is skipped; the real trailer below remains the authority',
    );
  } finally {
    cleanup(dir);
  }
});

// ── Divergence at gate entry ─────────────────────────────────────────────────

test('entry-divergence-refuses-and-points-to-recover', () => {
  const dir = initRepo();
  try {
    // Durable trailer says `plan-reviewed`; the runtime front matter still says
    // `plan-ready` (the record write that advances it was lost). They diverge.
    const planningPath = writePlanning(dir, makeFrontMatter({ state: 'plan-ready' }));
    commit(dir, [planningPath], 'feat: plan', 'plan-ready');
    commit(dir, [writeCode(dir, 'review.txt', 'reviewed')], 'review: done', 'plan-reviewed');

    const deps = { planningFile: planningPath, worktree: dir, readFile: (p: string) => fs.readFileSync(p, 'utf8'), run: runGit };
    assert.equal(computeDivergence(deps), true, 'front matter diverges from the HEAD trailer');

    // Wire the REAL divergence function into the gate's injected seam: entry
    // refuses with NEEDS_HUMAN and a message pointing at `workflow recover`.
    const gateDeps: GateDeps = {
      readState: () => makeFrontMatter({ state: 'plan-ready' }),
      checkDivergence: () => computeDivergence(deps),
      now: () => 0,
      sleep: () => {},
      recordForcedAction: () => {},
    };
    const opts: GateOptions = { wait: true, waitSeconds: 60 };
    const result = gate('review-plan', opts, gateDeps);
    assert.equal(result.exitCode, EXIT_NEEDS_HUMAN);
    assert.equal(result.outcome, 'divergence');
    assert.match(result.message ?? '', /recover/, 'points to workflow recover');
  } finally {
    cleanup(dir);
  }
});

// ── One-directional reconcile (trailer wins) ─────────────────────────────────

test('recover-reconciles-front-matter-to-head-trailer', () => {
  const dir = initRepo();
  try {
    const planningPath = writePlanning(dir, makeFrontMatter({ state: 'plan-ready' }));
    commit(dir, [planningPath], 'feat: plan', 'plan-ready');
    // The durable transition lands a `plan-reviewed` trailer; the runtime file
    // still says `plan-ready`.
    commit(dir, [writeCode(dir, 'review.txt', 'reviewed')], 'review: done', 'plan-reviewed');
    assert.equal(readState(planningPath), 'plan-ready', 'precondition: runtime is behind');

    const result = recover(recoverDeps(dir, planningPath));

    assert.equal(result.changed, true);
    assert.equal(result.fromState, 'plan-ready');
    assert.equal(result.toState, 'plan-reviewed');
    assert.equal(readState(planningPath), 'plan-reviewed', 'the trailer wins, one-directionally');
    // The markdown body survives the rewrite (recover only touches the front matter).
    assert.match(fs.readFileSync(planningPath, 'utf8'), /# Plan/);
  } finally {
    cleanup(dir);
  }
});

// ── Untrailed implementation commit is durable, never rolled back ────────────

test('untrailed-implementation-commit-counts-durable-never-rolled-back', () => {
  const dir = initRepo();
  try {
    const planningPath = writePlanning(dir, makeFrontMatter({ state: 'implemented' }));
    commit(dir, [planningPath], 'feat: record implemented', 'implemented');
    // The two-commit implement shape can leave an untrailed CODE commit on top.
    const codePath = writeCode(dir, 'src.txt', 'the implementation');
    commit(dir, [codePath], 'feat: implementation work'); // NO trailer
    const before = commitCount(dir);

    // The last reachable trailer is still `implemented` (search back past the
    // untrailed top commit), so the runtime state matches: NOT divergence.
    const deps = { planningFile: planningPath, worktree: dir, readFile: (p: string) => fs.readFileSync(p, 'utf8'), run: runGit };
    assert.equal(readHeadWorkflowPhase(dir, runGit), 'implemented', 'trailer found below the code commit');
    assert.equal(computeDivergence(deps), false, 'an untrailed code commit is not divergence');

    const result = recover(recoverDeps(dir, planningPath));

    assert.equal(result.changed, false, 'nothing to reconcile');
    assert.equal(readState(planningPath), 'implemented', 'state unchanged');
    // recover NEVER rewrites history: the untrailed code commit is still durable.
    assert.equal(commitCount(dir), before, 'no commits added or removed');
    assert.ok(fs.existsSync(codePath), 'the implementation file is never rolled back');
    assert.equal(
      runGit(['cat-file', '-p', 'HEAD:src.txt'], dir),
      'the implementation',
      'the durable code commit is intact at HEAD',
    );
  } finally {
    cleanup(dir);
  }
});

// ── Interrupted `complete`: trailer landed, record write lost ────────────────

test('interrupted-complete-recovers', () => {
  const dir = initRepo();
  try {
    // Prior durable record: state == plan-consolidated, trailer == plan-consolidated.
    const planningPath = writePlanning(dir, makeFrontMatter({ state: 'plan-consolidated' }));
    commit(dir, [planningPath], 'feat: consolidate', 'plan-consolidated');

    // `complete` of implement-plan: the trailer commit LANDS (durable authority
    // advances to `implemented`) but the process is killed BEFORE the front-matter
    // record write — the runtime planning file is left in the pre-record shape.
    commit(dir, [writeCode(dir, 'impl.txt', 'code')], 'feat(workflow): complete implement-plan', 'implemented');
    assert.equal(readState(planningPath), 'plan-consolidated', 'pre-record: runtime is stale');

    const result = recover(recoverDeps(dir, planningPath));

    // recover repairs the front matter from the durable HEAD trailer.
    assert.equal(result.changed, true);
    assert.equal(result.fromState, 'plan-consolidated');
    assert.equal(result.toState, 'implemented');
    assert.equal(readState(planningPath), 'implemented', 'front matter repaired from HEAD trailer');
    assert.match(fs.readFileSync(planningPath, 'utf8'), /# Plan/, 'body preserved');
  } finally {
    cleanup(dir);
  }
});

// ── CLI `recover` command wiring (end to end through runCli) ─────────────────

test('cli-recover-command-reconciles-and-reports', () => {
  const dir = initRepo();
  try {
    const planningPath = writePlanning(dir, makeFrontMatter({ state: 'plan-ready' }));
    commit(dir, [planningPath], 'feat: plan', 'plan-ready');
    commit(dir, [writeCode(dir, 'review.txt', 'reviewed')], 'review: done', 'plan-reviewed');

    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = {
      cwd: () => dir,
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      writeFile: (p, c) => fs.writeFileSync(p, c),
      runGit,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    };

    // Default planning-file path resolves under cwd; reconcile happens in-place.
    const code = runCli(['recover'], io, realLockSeams());
    assert.equal(code, EXIT_OK);
    assert.match(out.join(''), /reconciled state plan-ready -> plan-reviewed/);
    assert.equal(readState(planningPath), 'plan-reviewed');

    // A second run is a no-op: front matter already matches the durable trailer.
    out.length = 0;
    const again = runCli(['recover', '--file', planningPath], io, realLockSeams());
    assert.equal(again, EXIT_OK);
    assert.match(out.join(''), /already matches/);
  } finally {
    cleanup(dir);
  }
});

// ── Pure divergence predicate (trailers.ts) ──────────────────────────────────

test('diverges-predicate-trailer-vs-state', () => {
  // No durable trailer yet (pre-first-transition) -> never divergence.
  assert.equal(diverges('created', null), false);
  // Trailer matches the runtime state -> not divergence.
  assert.equal(diverges('plan-ready', 'plan-ready'), false);
  // Trailer names a state the runtime does not reflect -> divergence.
  assert.equal(diverges('plan-ready', 'plan-reviewed'), true);
});

// ── A code-file fixture helper (declared after use is fine: function decl) ────

function writeCode(dir: string, name: string, contents: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}
