import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT_FAILURE,
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_WRONG_STATE,
} from '../../workflow/src/types.ts';
import type { FrontMatter, NeedsHumanReason, WorkflowState } from '../../workflow/src/types.ts';
import {
  CorruptStateError,
  parseFrontMatter,
  serializeFrontMatter,
} from '../../workflow/src/front-matter.ts';
import { runGit, readHeadWorkflowPhase, withWorkflowPhaseTrailer } from '../../workflow/src/trailers.ts';
import { splitPlanningFile } from '../../workflow/src/recover.ts';
import { realLockSeams } from '../../workflow/src/lock.ts';
import {
  CHECK_CMUX,
  CHECK_CONFIG,
  CHECK_DIVERGENCE,
  CHECK_GH_AUTH,
  CHECK_NOTIFY_ENV,
  CHECK_REVIEW_GUIDES,
  CHECK_SCHEMA_PARSE,
  CHECK_WORKTREE_PARENT,
  CHECK_WRAPPER,
  realGhAuthProbe,
  runDoctor,
} from '../../workflow/src/doctor.ts';
import type { DoctorCheck, DoctorDeps, DoctorProbes } from '../../workflow/src/doctor.ts';
import { resume } from '../../workflow/src/resume.ts';
import type { ResumeDeps } from '../../workflow/src/resume.ts';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const PLANNING_FILE = 'workflow-session-planning.md';
const BODY = '\n# Plan\n\nthe plan body lives here\n';
const T0 = '2026-06-10T12:00:00Z';
const STUB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../stubs');

function makeFrontMatter(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'dark-mode-toggle',
    branch: 'feature/dark-mode-toggle',
    worktree: '../app-dark-mode-toggle',
    base: 'main',
    base_sha: '9c1f2a',
    cmux_section: 'dark-mode-toggle',
    state: 'plan-ready',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: 'pane-2:claude',
    updated: T0,
    phases: {},
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

function initRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(['init', '-q'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Workflow Test'], dir);
  runGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readFm(planningPath: string): FrontMatter {
  const { frontMatterText } = splitPlanningFile(fs.readFileSync(planningPath, 'utf8'));
  return parseFrontMatter(frontMatterText);
}

function commitCount(dir: string): number {
  try {
    return Number(runGit(['rev-list', '--count', 'HEAD'], dir).trim());
  } catch {
    return 0;
  }
}

// ── doctor fixtures ──────────────────────────────────────────────────────────

// A complete, §2.8-valid workflow block; tests override one field to break it.
function makeWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    enabled: true,
    base_branch: 'main',
    worktree_parent: '..',
    cmux_mode: 'manual',
    loopback_mode: 'manual',
    reviewer_independence: 'different-runtime',
    required_review_guides: ['docs/guide-a.md', 'docs/guide-b.md'],
    commit_exclude: [],
    archive: true,
    timeouts: { default_wait_seconds: 300, default_work_seconds: 1800 },
    budget: { workflow_total_seconds: 7200 },
    agents: { claude: ['claude'], codex: ['codex'] },
    ship: { ci_wait_seconds: 600, notify: true },
    notify: { webhook_env: 'WORKFLOW_WEBHOOK_URL' },
    ...overrides,
  };
}

// All-green injected probes; each test overrides exactly one to break one check.
function makeProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    fileExists: (p) => fs.existsSync(p),
    dirWritable: () => true,
    getEnv: () => 'https://example.test/hook',
    probeCmux: () => ({ ok: true, detail: 'cmux session reachable' }),
    probeWrapper: () => ({ ok: true, detail: 'wrapper present' }),
    probeGhAuth: () => ({ ok: true, detail: 'authenticated as stub-user' }),
    ...overrides,
  };
}

// Builds an all-green repo: a valid committed planning file (trailer matches state
// — no divergence), a §2.8-valid quality.json, the two review guides, and the
// project-facts doc. Returns the planning path. Tests then perturb one thing.
function setupGreenRepo(
  dir: string,
  workflowOverrides: Record<string, unknown> = {},
  fmOverrides: Partial<FrontMatter> = {},
): string {
  const fm = makeFrontMatter(fmOverrides);
  const planningPath = path.join(dir, PLANNING_FILE);
  fs.writeFileSync(planningPath, serializeFrontMatter(fm) + BODY);
  fs.writeFileSync(
    path.join(dir, 'quality.json'),
    JSON.stringify({ workflow: makeWorkflow(workflowOverrides) }, null, 2),
  );
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/guide-a.md'), '# guide a\n');
  fs.writeFileSync(path.join(dir, 'docs/guide-b.md'), '# guide b\n');
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents/project-facts.md'), '# project facts\n');
  for (const rel of [PLANNING_FILE, 'quality.json', 'docs/guide-a.md', 'docs/guide-b.md', '.agents/project-facts.md']) {
    runGit(['add', '--', rel], dir);
  }
  runGit(['commit', '-q', '-m', withWorkflowPhaseTrailer('seed', fm.state)], dir);
  return planningPath;
}

function doctorDeps(
  dir: string,
  planningPath: string,
  opts: { arming?: boolean; probes?: DoctorProbes; manifestPath?: string; projectFactsPath?: string } = {},
): DoctorDeps {
  return {
    planningFile: planningPath,
    worktree: dir,
    manifestPath: opts.manifestPath ?? path.join(dir, 'quality.json'),
    repoRoot: dir,
    projectFactsPath: opts.projectFactsPath ?? path.join(dir, '.agents/project-facts.md'),
    arming: opts.arming ?? false,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    run: runGit,
    probes: opts.probes ?? makeProbes(),
  };
}

function check(checks: DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((c) => c.name === name);
  assert.ok(found !== undefined, `expected a "${name}" check to be present`);
  return found;
}

// ── doctor: one test per check (a green AND a failing fixture each) ───────────

test('doctor schema-parse: green parseable file, failing corrupt file', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);
    const green = runDoctor(doctorDeps(dir, planningPath));
    assert.equal(check(green.checks, CHECK_SCHEMA_PARSE).ok, true);

    // Overwrite the working-tree planning file with structurally corrupt content.
    fs.writeFileSync(planningPath, 'this is not a fenced front matter document\n');
    const red = runDoctor(doctorDeps(dir, planningPath));
    const c = check(red.checks, CHECK_SCHEMA_PARSE);
    assert.equal(c.ok, false);
    assert.match(c.detail, /corrupt/);
    assert.equal(red.ok, false);
    assert.equal(red.exitCode, EXIT_FAILURE);
  } finally {
    cleanup(dir);
  }
});

test('doctor divergence: green when trailer matches, failing when it diverges', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);
    assert.equal(check(runDoctor(doctorDeps(dir, planningPath)).checks, CHECK_DIVERGENCE).ok, true);

    // Land a newer durable trailer that disagrees with the runtime state.
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    runGit(['add', '--', 'note.txt'], dir);
    runGit(['commit', '-q', '-m', withWorkflowPhaseTrailer('advance', 'plan-reviewed')], dir);

    const c = check(runDoctor(doctorDeps(dir, planningPath)).checks, CHECK_DIVERGENCE);
    assert.equal(c.ok, false);
    assert.match(c.detail, /diverges|recover/);
  } finally {
    cleanup(dir);
  }
});

test('doctor config: green valid §2.8 block, failing invalid block', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const greenPath = setupGreenRepo(dir);
    assert.equal(check(runDoctor(doctorDeps(dir, greenPath)).checks, CHECK_CONFIG).ok, true);
  } finally {
    cleanup(dir);
  }

  const dir2 = initRepo('workflow-doctor-');
  try {
    const redPath = setupGreenRepo(dir2, { cmux_mode: 'bogus' });
    const red = runDoctor(doctorDeps(dir2, redPath));
    const c = check(red.checks, CHECK_CONFIG);
    assert.equal(c.ok, false);
    assert.match(c.detail, /§2\.8|cmux_mode/);
    assert.equal(red.ok, false);
  } finally {
    cleanup(dir2);
  }
});

test('doctor config: failing when the workflow block is absent', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);
    fs.writeFileSync(path.join(dir, 'quality.json'), JSON.stringify({ version: 1 }));
    const c = check(runDoctor(doctorDeps(dir, planningPath)).checks, CHECK_CONFIG);
    assert.equal(c.ok, false);
    assert.match(c.detail, /no workflow block/);
  } finally {
    cleanup(dir);
  }
});

test('doctor review-guides + project-facts: green when present, failing when one is missing', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);
    assert.equal(check(runDoctor(doctorDeps(dir, planningPath)).checks, CHECK_REVIEW_GUIDES).ok, true);

    fs.rmSync(path.join(dir, 'docs/guide-b.md'));
    const c = check(runDoctor(doctorDeps(dir, planningPath)).checks, CHECK_REVIEW_GUIDES);
    assert.equal(c.ok, false);
    assert.match(c.detail, /guide-b\.md/);

    // project-facts missing also fails the same check.
    fs.writeFileSync(path.join(dir, 'docs/guide-b.md'), '# back\n');
    fs.rmSync(path.join(dir, '.agents/project-facts.md'));
    const c2 = check(runDoctor(doctorDeps(dir, planningPath)).checks, CHECK_REVIEW_GUIDES);
    assert.equal(c2.ok, false);
    assert.match(c2.detail, /project-facts\.md/);
  } finally {
    cleanup(dir);
  }
});

test('doctor worktree-parent-writable: green when writable, failing when not', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);
    const green = runDoctor(doctorDeps(dir, planningPath, { probes: makeProbes({ dirWritable: () => true }) }));
    assert.equal(check(green.checks, CHECK_WORKTREE_PARENT).ok, true);

    const red = runDoctor(doctorDeps(dir, planningPath, { probes: makeProbes({ dirWritable: () => false }) }));
    const c = check(red.checks, CHECK_WORKTREE_PARENT);
    assert.equal(c.ok, false);
    assert.match(c.detail, /not writable/);
    assert.equal(red.ok, false);
  } finally {
    cleanup(dir);
  }
});

test('doctor cmux probe: arming-only; green ok probe, failing probe', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);

    // Not arming: the cmux check is omitted entirely.
    const noArm = runDoctor(doctorDeps(dir, planningPath, { arming: false }));
    assert.equal(noArm.checks.find((c) => c.name === CHECK_CMUX), undefined);

    const green = runDoctor(doctorDeps(dir, planningPath, { arming: true, probes: makeProbes() }));
    assert.equal(check(green.checks, CHECK_CMUX).ok, true);

    const red = runDoctor(
      doctorDeps(dir, planningPath, {
        arming: true,
        probes: makeProbes({ probeCmux: () => ({ ok: false, detail: 'no cmux session' }) }),
      }),
    );
    const c = check(red.checks, CHECK_CMUX);
    assert.equal(c.ok, false);
    assert.match(c.detail, /no cmux session/);
    assert.equal(red.ok, false);
  } finally {
    cleanup(dir);
  }
});

test('doctor wrapper presence: arming-only; green both runtimes, failing one runtime', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);
    const noArm = runDoctor(doctorDeps(dir, planningPath, { arming: false }));
    assert.equal(noArm.checks.find((c) => c.name === CHECK_WRAPPER), undefined);

    const green = runDoctor(doctorDeps(dir, planningPath, { arming: true, probes: makeProbes() }));
    assert.equal(check(green.checks, CHECK_WRAPPER).ok, true);

    const red = runDoctor(
      doctorDeps(dir, planningPath, {
        arming: true,
        probes: makeProbes({
          probeWrapper: (runtime) =>
            runtime === 'codex' ? { ok: false, detail: 'codex wrapper not generated' } : { ok: true, detail: 'present' },
        }),
      }),
    );
    const c = check(red.checks, CHECK_WRAPPER);
    assert.equal(c.ok, false);
    assert.match(c.detail, /codex/);
    assert.equal(red.ok, false);
  } finally {
    cleanup(dir);
  }
});

test('doctor gh-auth: enabled-only; green authenticated, failing unauthenticated', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);

    const green = runDoctor(doctorDeps(dir, planningPath, { probes: makeProbes() }));
    assert.equal(check(green.checks, CHECK_GH_AUTH).ok, true);

    const red = runDoctor(
      doctorDeps(dir, planningPath, {
        probes: makeProbes({ probeGhAuth: () => ({ ok: false, detail: 'not logged in' }) }),
      }),
    );
    const c = check(red.checks, CHECK_GH_AUTH);
    assert.equal(c.ok, false);
    assert.match(c.detail, /not logged in/);
    assert.equal(red.ok, false);
  } finally {
    cleanup(dir);
  }

  // Disabled workflow: the gh check is omitted entirely.
  const dir2 = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir2, { enabled: false });
    const result = runDoctor(doctorDeps(dir2, planningPath));
    assert.equal(result.checks.find((c) => c.name === CHECK_GH_AUTH), undefined);
  } finally {
    cleanup(dir2);
  }
});

test('doctor gh-auth real probe: green via the tests/stubs/gh PATH stub, failing when gh is absent', () => {
  const originalPath = process.env.PATH ?? '';
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-nogh-'));
  try {
    process.env.PATH = `${STUB_DIR}${path.delimiter}${originalPath}`;
    const green = realGhAuthProbe();
    assert.equal(green.ok, true, `stub gh should authenticate: ${green.detail}`);

    process.env.PATH = emptyDir; // no `gh` resolvable
    const red = realGhAuthProbe();
    assert.equal(red.ok, false);
    assert.match(red.detail, /not found/);
  } finally {
    process.env.PATH = originalPath;
    cleanup(emptyDir);
  }
});

test('doctor notify-env is warn-only: a missing env fails the check but never blocks', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);
    const green = runDoctor(doctorDeps(dir, planningPath, { probes: makeProbes() }));
    const gc = check(green.checks, CHECK_NOTIFY_ENV);
    assert.equal(gc.ok, true);
    assert.equal(gc.blocking, false);

    const red = runDoctor(
      doctorDeps(dir, planningPath, { probes: makeProbes({ getEnv: () => undefined }) }),
    );
    const rc = check(red.checks, CHECK_NOTIFY_ENV);
    assert.equal(rc.ok, false);
    assert.equal(rc.blocking, false);
    // Warn-only: the overall diagnosis still passes and exits 0.
    assert.equal(red.ok, true);
    assert.equal(red.exitCode, EXIT_OK);
  } finally {
    cleanup(dir);
  }
});

test('doctor prints the transition table', () => {
  const dir = initRepo('workflow-doctor-');
  try {
    const planningPath = setupGreenRepo(dir);
    const result = runDoctor(doctorDeps(dir, planningPath));
    assert.match(result.transitionTable, /transition table/);
    assert.match(result.transitionTable, /new-feature/);
    assert.match(result.transitionTable, /ship-feature/);
    assert.match(result.transitionTable, /plan-changes-requested/);
  } finally {
    cleanup(dir);
  }
});

// ── front-matter return-state field round-trip ───────────────────────────────

test('needs_human_from round-trips and rejects a non-WorkflowState value', () => {
  const fm = makeFrontMatter({
    state: 'needs-human',
    needs_human_reason: 'guide-missing',
    needs_human_from: 'plan-reviewed',
  });
  const reparsed = parseFrontMatter(serializeFrontMatter(fm));
  assert.equal(reparsed.needs_human_from, 'plan-reviewed');
  assert.equal(reparsed.needs_human_reason, 'guide-missing');

  const bad = serializeFrontMatter(fm).replace('needs_human_from: "plan-reviewed"', 'needs_human_from: "not-a-state"');
  assert.throws(() => parseFrontMatter(bad), CorruptStateError);
});

// ── resume fixtures ──────────────────────────────────────────────────────────

const RESUMER = 'pane-9:human+helper';

// Hand-constructs a needs-human record: state needs-human, the reason, and (when
// given) the needs_human_from return state, committed with a `needs-human` trailer
// (so the durable record agrees — no divergence at resume entry).
function seedNeedsHuman(
  dir: string,
  opts: { reason: NeedsHumanReason; from?: WorkflowState; fm?: Partial<FrontMatter> },
): string {
  const base: Partial<FrontMatter> = {
    state: 'needs-human',
    needs_human_reason: opts.reason,
    ...opts.fm,
  };
  if (opts.from !== undefined) base.needs_human_from = opts.from;
  const fm = makeFrontMatter(base);
  const planningPath = path.join(dir, PLANNING_FILE);
  fs.writeFileSync(planningPath, serializeFrontMatter(fm) + BODY);
  runGit(['add', '--', PLANNING_FILE], dir);
  runGit(['commit', '-q', '-m', withWorkflowPhaseTrailer('needs-human seed', 'needs-human')], dir);
  return planningPath;
}

function resumeDeps(dir: string, planningPath: string, claimedBy = RESUMER): ResumeDeps {
  return {
    planningFile: planningPath,
    worktree: dir,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    run: runGit,
    lockSeams: realLockSeams(),
    now: () => Date.parse(T0),
    claimedBy,
  };
}

// ── resume: the five pinned tests ────────────────────────────────────────────

test('loopback-cap-requires-extend-cap-waiver', () => {
  const dir = initRepo('workflow-resume-');
  try {
    const planningPath = seedNeedsHuman(dir, {
      reason: 'loopback-cap',
      from: 'plan-changes-requested',
      fm: { loopback_count: 2, loopback_cap: 2 },
    });

    const result = resume(resumeDeps(dir, planningPath));
    assert.equal(result.exitCode, EXIT_OK);
    assert.equal(result.outcome, 'resumed');
    assert.equal(result.toState, 'plan-changes-requested');

    const fm = readFm(planningPath);
    assert.equal(fm.state, 'plan-changes-requested', 'returned to the loop');
    assert.equal(fm.loopback_cap, 3, 'the extend-cap waiver raised loopback_cap');
    assert.equal(fm.loopback_count, 2, 'loopback_count is untouched');
    assert.equal(fm.needs_human_reason, undefined, 'needs-human fields cleared');
    assert.equal(fm.needs_human_from, undefined);
    assert.equal(fm.forced_actions?.length, 1);
    assert.match(fm.forced_actions?.[0]?.reason ?? '', /loopback-cap/);
    assert.equal(
      readHeadWorkflowPhase(dir, runGit),
      'plan-changes-requested',
      'the durable trailer matches the return state',
    );
  } finally {
    cleanup(dir);
  }
});

test('budget-exhausted-grants-fresh-recorded-budget', () => {
  const dir = initRepo('workflow-resume-');
  try {
    const planningPath = seedNeedsHuman(dir, {
      reason: 'budget-exhausted',
      from: 'implement-inprogress',
      fm: { budget_spent: { total_seconds: 9999 } },
    });

    const result = resume(resumeDeps(dir, planningPath));
    assert.equal(result.exitCode, EXIT_OK);
    assert.equal(result.toState, 'implement-inprogress');

    const fm = readFm(planningPath);
    assert.equal(fm.state, 'implement-inprogress');
    assert.equal(fm.budget_spent.total_seconds, 0, 'a fresh budget was granted');
    assert.equal(fm.forced_actions?.length, 1, 'the grant is recorded');
    assert.match(fm.forced_actions?.[0]?.reason ?? '', /budget-exhausted/);
    assert.equal(readHeadWorkflowPhase(dir, runGit), 'implement-inprogress');
  } finally {
    cleanup(dir);
  }
});

test('guide-missing-waiver-no-counter-change', () => {
  const dir = initRepo('workflow-resume-');
  try {
    const planningPath = seedNeedsHuman(dir, {
      reason: 'guide-missing',
      from: 'review-plan-inprogress',
      fm: { loopback_count: 1, loopback_cap: 2, budget_spent: { total_seconds: 120 } },
    });

    const result = resume(resumeDeps(dir, planningPath));
    assert.equal(result.exitCode, EXIT_OK);
    assert.equal(result.toState, 'review-plan-inprogress');

    const fm = readFm(planningPath);
    assert.equal(fm.state, 'review-plan-inprogress');
    // No counter changed — a pure waiver.
    assert.equal(fm.loopback_count, 1);
    assert.equal(fm.loopback_cap, 2);
    assert.equal(fm.budget_spent.total_seconds, 120);
    assert.equal(fm.forced_actions?.length, 1);
    assert.match(fm.forced_actions?.[0]?.reason ?? '', /guide-missing/);
    assert.equal(readHeadWorkflowPhase(dir, runGit), 'review-plan-inprogress');
  } finally {
    cleanup(dir);
  }
});

test('corrupt-state-requires-prior-recover', () => {
  // (A) Parseable record still at needs-human with reason corrupt-state: refuse,
  // pointing at `workflow recover` (recover has not yet restored the state).
  const dirA = initRepo('workflow-resume-');
  try {
    const planningPath = seedNeedsHuman(dirA, { reason: 'corrupt-state' });
    const before = commitCount(dirA);
    const result = resume(resumeDeps(dirA, planningPath));
    assert.equal(result.exitCode, EXIT_NEEDS_HUMAN);
    assert.equal(result.outcome, 'corrupt-needs-recover');
    assert.match(result.message ?? '', /recover/);
    assert.equal(readFm(planningPath).state, 'needs-human', 'state unchanged');
    assert.equal(commitCount(dirA), before, 'no commit was made');
  } finally {
    cleanup(dirA);
  }

  // (B) A structurally corrupt planning file: resume refuses (it never repairs YAML).
  const dirB = initRepo('workflow-resume-');
  try {
    const planningPath = path.join(dirB, PLANNING_FILE);
    fs.writeFileSync(planningPath, 'this file does not parse as front matter\n');
    runGit(['add', '--', PLANNING_FILE], dirB);
    runGit(['commit', '-q', '-m', 'corrupt seed'], dirB);
    const before = commitCount(dirB);
    const result = resume(resumeDeps(dirB, planningPath));
    assert.equal(result.exitCode, EXIT_NEEDS_HUMAN);
    assert.equal(result.outcome, 'corrupt-needs-recover');
    assert.match(result.message ?? '', /recover/);
    assert.equal(commitCount(dirB), before, 'no commit was made');
  } finally {
    cleanup(dirB);
  }

  // (C) After a prior `workflow recover`, the state is no longer needs-human, so
  // resume recognizes the requirement was satisfied and does not demand recover.
  const dirC = initRepo('workflow-resume-');
  try {
    const fm = makeFrontMatter({ state: 'plan-reviewed' });
    const planningPath = path.join(dirC, PLANNING_FILE);
    fs.writeFileSync(planningPath, serializeFrontMatter(fm) + BODY);
    runGit(['add', '--', PLANNING_FILE], dirC);
    runGit(['commit', '-q', '-m', withWorkflowPhaseTrailer('recovered', 'plan-reviewed')], dirC);
    const before = commitCount(dirC);
    const result = resume(resumeDeps(dirC, planningPath));
    assert.equal(result.exitCode, EXIT_WRONG_STATE);
    assert.equal(result.outcome, 'wrong-state');
    assert.doesNotMatch(result.message ?? '', /corrupt/);
    assert.equal(commitCount(dirC), before, 'no mutation after recover already ran');
  } finally {
    cleanup(dirC);
  }
});

test('resume-records-by-reason-at-prior-state', () => {
  const dir = initRepo('workflow-resume-');
  try {
    const planningPath = seedNeedsHuman(dir, {
      reason: 'guide-missing',
      from: 'plan-reviewed',
      fm: { loopback_count: 0 },
    });

    const result = resume(resumeDeps(dir, planningPath, RESUMER));
    assert.equal(result.exitCode, EXIT_OK);
    assert.equal(result.toState, 'plan-reviewed', 'returns to the prior state');

    const fm = readFm(planningPath);
    assert.equal(fm.state, 'plan-reviewed');
    const action = fm.forced_actions?.[0];
    assert.ok(action !== undefined, 'a forced_actions entry was recorded');
    assert.equal(action.from_state, 'plan-reviewed', 'recorded AT the prior state');
    assert.equal(action.loop, 0);
    assert.equal(action.claimed_by, RESUMER);
    assert.equal(action.phase, 'consolidate-plan', 'phase derived from the return state');
    assert.match(action.reason, /guide-missing/, 'recorded BY reason');
    assert.equal(action.at, T0);
    assert.equal(readHeadWorkflowPhase(dir, runGit), 'plan-reviewed');
  } finally {
    cleanup(dir);
  }
});
