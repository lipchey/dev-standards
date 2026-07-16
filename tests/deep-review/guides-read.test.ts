/* The guides-read gate is the security heart of ADR-016: it must BLOCK a deep-review pass
   that skipped a mandated guide and must never block an unrelated session. These tests
   pin read-proof (a genuine successful Read, not a spoof), the strict/fail-closed required
   set, the root-agnostic tail match, and the activation/skip boundary. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript } from '../../deep-review/src/transcript.ts';
import {
  computeMissing,
  evaluateGuidesRead,
  requiredReadSet,
  GuidesUnavailable,
  DEEP_REVIEW_ATTRIBUTION_SKILL,
} from '../../deep-review/src/guides-read.ts';
import type { RequiredReadSetDeps } from '../../deep-review/src/guides-read.ts';
import { loadReviewGuides, REVIEW_GUIDE_TEMPLATES_DIR } from '../../deep-review/src/guides.ts';
import type { DeepReviewConfig } from '../../deep-review/src/config.ts';
import { runCli } from '../../deep-review/src/cli.ts';
import type { CliDeps } from '../../deep-review/src/cli.ts';

/* TRACEABILITY.md shares the templates dir but is the blinded canary registry the
   loader excludes — never a mandated read (see guides.ts NON_GUIDE_TEMPLATE_NAMES). */
const TEMPLATE_NAMES = fs
  .readdirSync(REVIEW_GUIDE_TEMPLATES_DIR)
  .filter((name) => name.endsWith('.md') && name !== 'TRACEABILITY.md')
  .sort();
const TEMPLATE_ANCHOR = 'agents/review-guide-templates';

/* An absolute consumer path for a template guide, under an arbitrary repo root — the
   model reads it through the submodule, so the root prefix varies (worktree vs main). */
function guideRead(root: string, name: string): string {
  return path.join(root, 'vendor', 'dev-standards', TEMPLATE_ANCHOR.replace('/', path.sep), name);
}

interface ToolUse {
  id: string;
  filePath: string;
}

function assistantLine(toolUses: ToolUse[], attributionSkill?: string): string {
  const content = toolUses.map((use) => ({
    type: 'tool_use',
    name: 'Read',
    id: use.id,
    input: { file_path: use.filePath },
  }));
  const line: Record<string, unknown> = { type: 'assistant', message: { role: 'assistant', content } };
  if (attributionSkill !== undefined) line.attributionSkill = attributionSkill;
  return JSON.stringify(line);
}

interface ResultSpec {
  id: string;
  isError?: boolean | null;
}

function resultLine(results: ResultSpec[], toolDenialKind?: string): string {
  const content = results.map((result) => ({
    type: 'tool_result',
    tool_use_id: result.id,
    is_error: result.isError ?? null,
  }));
  const line: Record<string, unknown> = { type: 'user', message: { role: 'user', content } };
  if (toolDenialKind !== undefined) line.toolDenialKind = toolDenialKind;
  return JSON.stringify(line);
}

/* A transcript that reads every template guide successfully under `root`, attributed to
   the skill. `skip` drops that many trailing guides (leaving them unread). */
function fullReviewTranscript(root: string, skip = 0): string {
  const names = skip === 0 ? TEMPLATE_NAMES : TEMPLATE_NAMES.slice(0, TEMPLATE_NAMES.length - skip);
  const lines: string[] = [];
  names.forEach((name, index) => {
    const id = `read-${index}`;
    lines.push(assistantLine([{ id, filePath: guideRead(root, name) }], DEEP_REVIEW_ATTRIBUTION_SKILL));
    lines.push(resultLine([{ id }]));
  });
  return lines.join('\n');
}

function config(overrides: Partial<DeepReviewConfig> = {}): DeepReviewConfig {
  return {
    enabled: true,
    modes: ['review-only', 'review-and-refactor'],
    budget: { seconds: 900 },
    guidesDir: '.claude/review-guides',
    noTouchGlobsRef: undefined,
    verifyAfterFix: undefined,
    verifyEntry: 'verify',
    reportsDir: 'reports/quality',
    requiredReads: [],
    ...overrides,
  };
}

/* Deps that isolate requiredReadSet from the repo fs: real templates, no overlay, no
   required_reads-on-disk, identity realpath. */
function isolatedDeps(): RequiredReadSetDeps & { realpath: (absolutePath: string) => string } {
  return { listOverlay: () => undefined, exists: () => true, realpath: (value) => value };
}

// ── transcript.ts ────────────────────────────────────────────────────────────────

test('parseTranscript records a successful Read as ok and surfaces the attribution skill', () => {
  const text = [
    assistantLine([{ id: 'a', filePath: '/repo/guide.md' }], DEEP_REVIEW_ATTRIBUTION_SKILL),
    resultLine([{ id: 'a', isError: false }]),
  ].join('\n');
  const parsed = parseTranscript(text);
  assert.deepEqual(parsed.reads, [{ path: '/repo/guide.md', ok: true }]);
  assert.equal(parsed.attributionSkills.has(DEEP_REVIEW_ATTRIBUTION_SKILL), true);
});

test('parseTranscript marks an errored Read result as NOT ok', () => {
  const text = [
    assistantLine([{ id: 'a', filePath: '/repo/guide.md' }]),
    resultLine([{ id: 'a', isError: true }]),
  ].join('\n');
  assert.deepEqual(parseTranscript(text).reads, [{ path: '/repo/guide.md', ok: false }]);
});

test('parseTranscript marks a user-rejected (denied) Read as NOT ok even if is_error is false', () => {
  const text = [
    assistantLine([{ id: 'a', filePath: '/repo/guide.md' }]),
    resultLine([{ id: 'a', isError: false }], 'user-rejected'),
  ].join('\n');
  assert.deepEqual(parseTranscript(text).reads, [{ path: '/repo/guide.md', ok: false }]);
});

test('parseTranscript marks a Read with no matching result as NOT ok', () => {
  const text = assistantLine([{ id: 'a', filePath: '/repo/guide.md' }]);
  assert.deepEqual(parseTranscript(text).reads, [{ path: '/repo/guide.md', ok: false }]);
});

test('parseTranscript ignores non-Read tool_uses (a Bash echo is not read-proof)', () => {
  const bashLine = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 'b', input: { command: 'echo guide.md' } }] },
  });
  const parsed = parseTranscript([bashLine, resultLine([{ id: 'b' }])].join('\n'));
  assert.deepEqual(parsed.reads, []);
});

test('parseTranscript skips malformed lines and never throws', () => {
  const text = ['not json', '', '{"partial', assistantLine([{ id: 'a', filePath: '/g.md' }]), resultLine([{ id: 'a' }])].join('\n');
  assert.deepEqual(parseTranscript(text).reads, [{ path: '/g.md', ok: true }]);
});

test('parseTranscript on empty input yields no reads and no attribution', () => {
  const parsed = parseTranscript('');
  assert.deepEqual(parsed.reads, []);
  assert.equal(parsed.attributionSkills.size, 0);
});

// ── requiredReadSet (strict, fail-closed) ─────────────────────────────────────────

test('requiredReadSet requires ONLY the review-contract anchor template, not the profile bodies (ADR-016 2026-07-16 rescope)', () => {
  const tails = requiredReadSet('/repo', config(), isolatedDeps());
  assert.equal(tails.includes(`${TEMPLATE_ANCHOR}/review-contract.md`), true, 'anchor must be main-required');
  for (const name of TEMPLATE_NAMES) {
    if (name === 'review-contract.md') continue;
    assert.equal(
      tails.includes(`${TEMPLATE_ANCHOR}/${name}`),
      false,
      `${name} is a profile-route read, must NOT be main-required`,
    );
  }
});

test('requiredReadSet excludes TRACEABILITY.md — the canary registry is not corpus', () => {
  const tails = requiredReadSet('/repo', config(), isolatedDeps());
  assert.equal(tails.includes(`${TEMPLATE_ANCHOR}/TRACEABILITY.md`), false);
});

test('requiredReadSet fails closed (GuidesUnavailable) when the templates are unavailable', () => {
  assert.throws(
    () => requiredReadSet('/repo', config(), { loadGuides: () => ({ ok: false, templatesDir: '/broken' }), listOverlay: () => undefined, exists: () => true }),
    GuidesUnavailable,
  );
});

test('loadReviewGuides fails closed (ok:false + reason) when a LISTED overlay is unreadable', () => {
  /* The single fail-closed point for overlay AVAILABILITY (P1, 2026-07-16): after the
     anchor rescope a non-anchor overlay is no longer a main-required read, so an
     unreadable one must still be caught HERE or it vanishes silently from the corpus. */
  const overlayDir = '/repo/.claude/review-guides';
  const outcome = loadReviewGuides(overlayDir, {
    templatesDir: REVIEW_GUIDE_TEMPLATES_DIR,
    listMarkdownFiles: (dir) =>
      dir === overlayDir
        ? ['profile-security.md']
        : fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
            .map((entry) => entry.name)
            .sort(),
    readFile: (filePath) => {
      if (filePath.startsWith(overlayDir)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return fs.readFileSync(filePath, 'utf8');
    },
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason ?? '', /listed but unreadable/);
});

test('requiredReadSet surfaces the overlay-unreadable reason, not the generic templates message', () => {
  assert.throws(
    () =>
      requiredReadSet('/repo', config(), {
        loadGuides: () => ({
          ok: false,
          templatesDir: '/x',
          reason: 'repo overlay "profile-security.md" is listed but unreadable: EACCES',
        }),
        listOverlay: () => undefined,
        exists: () => true,
      }),
    /overlay .* unreadable/,
  );
});

test('requiredReadSet fails closed when the overlay directory is unreadable for a non-ENOENT reason', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-overlay-'));
  try {
    // guides_dir points at a FILE, so a real readdir raises ENOTDIR — must fail closed, not skip.
    fs.writeFileSync(path.join(tmp, 'not-a-dir'), 'x');
    assert.throws(() => requiredReadSet(tmp, config({ guidesDir: 'not-a-dir' })), GuidesUnavailable);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('requiredReadSet treats a missing overlay directory as no overlay (ENOENT is optional)', () => {
  const tails = requiredReadSet('/repo', config({ guidesDir: '.claude/review-guides' }), {
    exists: () => true,
  });
  // No overlay tails contributed; only templates.
  assert.equal(tails.some((tail) => tail.startsWith('.claude/review-guides/')), false);
});

test('requiredReadSet requires the review-contract overlay + configured required_read, NOT a profile/extra overlay', () => {
  const tails = requiredReadSet('/repo', config({ requiredReads: ['.claude/CHECKLIST.md'] }), {
    listOverlay: () => ['review-contract.md', 'profile-security.md', 'repo-extra.md'],
    exists: () => true,
  });
  /* Only the anchor overlay is a main-session read; profile/legacy overlays are
     profile-route material (their availability is fail-closed in loadReviewGuides). */
  assert.equal(tails.includes('.claude/review-guides/review-contract.md'), true);
  assert.equal(tails.includes('.claude/CHECKLIST.md'), true);
  assert.equal(tails.includes('.claude/review-guides/profile-security.md'), false);
  assert.equal(tails.includes('.claude/review-guides/repo-extra.md'), false);
});

test('requiredReadSet never requires a reserved-name overlay (TRACEABILITY.md)', () => {
  const tails = requiredReadSet('/repo', config(), {
    listOverlay: () => ['TRACEABILITY.md', 'review-contract.md'],
    exists: () => true,
  });
  assert.equal(tails.includes('.claude/review-guides/review-contract.md'), true);
  assert.equal(tails.includes('.claude/review-guides/TRACEABILITY.md'), false);
});

test('requiredReadSet fails closed when a configured required_read does not exist', () => {
  assert.throws(
    () => requiredReadSet('/repo', config({ requiredReads: ['.claude/GONE.md'] }), { listOverlay: () => undefined, exists: () => false }),
    /required_read .* does not exist/,
  );
});

test('requiredReadSet fails closed when guides_dir escapes the repo root, even if empty (P1-2)', () => {
  // An escaping overlay with NO files would otherwise fall through to allow; confine up front.
  assert.throws(
    () => requiredReadSet('/repo', config({ guidesDir: '../evil' }), { listOverlay: () => [], exists: () => true }),
    /resolves outside the repo root/,
  );
});

test('requiredReadSet fails closed when guides_dir is an in-repo SYMLINK escaping the repo (R2-3)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-repo-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-outside-'));
  try {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    // A lexically-in-repo overlay path whose symlink target is outside must fail closed — the
    // lexical check passes, so only the realpath confinement catches it.
    fs.symlinkSync(outside, path.join(repo, '.claude', 'review-guides'));
    assert.throws(
      () => requiredReadSet(fs.realpathSync(repo), config({ guidesDir: '.claude/review-guides' }), { exists: () => true }),
      /via a symlink/,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ── computeMissing (tail match, root-agnostic, realpath) ──────────────────────────

test('computeMissing matches a template read under ANY approved repo root (worktree vs main)', () => {
  const tail = `${TEMPLATE_ANCHOR}/profile-security.md`;
  const worktreeRoot = '/Users/x/worktrees/w';
  const mainRoot = '/Users/x/proj';
  const worktreeRead = { path: guideRead(worktreeRoot, 'profile-security.md'), ok: true };
  const mainRead = { path: guideRead(mainRoot, 'profile-security.md'), ok: true };
  // Both roots approved (the review's worktree + the main checkout), as cli.ts resolves them.
  const approvedRoots = [worktreeRoot, mainRoot];
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [worktreeRead], approvedRoots, realpath: (value) => value }), []);
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [mainRead], approvedRoots, realpath: (value) => value }), []);
});

test('computeMissing ignores a NOT-ok read (failed/denied does not satisfy the requirement)', () => {
  const tail = `${TEMPLATE_ANCHOR}/profile-security.md`;
  const failed = { path: guideRead('/repo', 'profile-security.md'), ok: false };
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [failed], approvedRoots: ['/repo'], realpath: (value) => value }), [tail]);
});

test('computeMissing does not match a bare-basename lookalike outside the anchored tail', () => {
  const tail = `${TEMPLATE_ANCHOR}/profile-security.md`;
  const lookalike = { path: '/tmp/profile-security.md', ok: true };
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [lookalike], approvedRoots: ['/repo'], realpath: (value) => value }), [tail]);
});

test('computeMissing rejects an exact-tail read under an UNAPPROVED root (P1-1)', () => {
  const tail = `${TEMPLATE_ANCHOR}/profile-security.md`;
  // A same-anchored guide read from OUTSIDE the repo (e.g. a decoy tree) must not satisfy it.
  const decoy = { path: guideRead('/tmp/evil', 'profile-security.md'), ok: true };
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [decoy], approvedRoots: ['/repo'], realpath: (value) => value }), [tail]);
});

test('computeMissing rejects an IN-repo decoy at the wrong depth — exact-anchor match, not suffix (R2-2)', () => {
  const tail = `${TEMPLATE_ANCHOR}/profile-security.md`;
  // `<root>/decoy/agents/review-guide-templates/profile-security.md` shares the tail but is
  // neither `<root>/<tail>` nor `<root>/vendor/dev-standards/<tail>` — a suffix match would
  // wrongly accept it.
  const decoy = { path: path.join('/repo', 'decoy', ...tail.split('/')), ok: true };
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [decoy], approvedRoots: ['/repo'], realpath: (value) => value }), [tail]);
});

test('computeMissing matches a dev-standards-SELF read (no vendor prefix) at the checkout root (R2-2)', () => {
  const tail = `${TEMPLATE_ANCHOR}/profile-security.md`;
  const selfRead = { path: path.join('/repo', ...tail.split('/')), ok: true };
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [selfRead], approvedRoots: ['/repo'], realpath: (value) => value }), []);
});

test('computeMissing DROPS a read whose realpath fails — non-proof, not a raw fallback (R2-2)', () => {
  const tail = `${TEMPLATE_ANCHOR}/profile-security.md`;
  const read = { path: guideRead('/repo', 'profile-security.md'), ok: true };
  // A raw-path fallback would let this lexical in-root path satisfy the tail; a realpath failure
  // means the file is gone → cannot prove it was read → still missing.
  const realpath = (value: string): string => {
    if (value === read.path) throw new Error('ENOENT');
    return value;
  };
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [read], approvedRoots: ['/repo'], realpath }), [tail]);
});

test('computeMissing realpaths reads AND roots so a /tmp symlink prefix still matches', () => {
  const tail = `${TEMPLATE_ANCHOR}/profile-module-depth.md`;
  const read = { path: guideRead('/tmp/root', 'profile-module-depth.md'), ok: true };
  const realpath = (value: string): string => value.replace('/tmp/', '/private/tmp/');
  assert.deepEqual(computeMissing({ requiredTails: [tail], reads: [read], approvedRoots: ['/tmp/root'], realpath }), []);
});

// ── evaluateGuidesRead (activation + fail-closed) ─────────────────────────────────

test('a non-review session (no marker, no attribution) SKIPs', () => {
  const decision = evaluateGuidesRead({
    transcriptText: assistantLine([{ id: 'a', filePath: '/x.ts' }]),
    markerPresent: false,
    cwd: '/repo',
    loadConfig: () => config(),
    deps: isolatedDeps(),
  });
  assert.equal(decision.kind, 'skip');
});

test('an active pass that read every guide is ALLOWED', () => {
  const decision = evaluateGuidesRead({
    transcriptText: fullReviewTranscript('/repo'),
    markerPresent: false,
    cwd: '/repo',
    loadConfig: () => config(),
    deps: isolatedDeps(),
  });
  assert.equal(decision.kind, 'allow');
});

test('an active pass that read the anchor but NOT the profile bodies is ALLOWED (anchor rescope)', () => {
  /* The core 2026-07-16 behavior change: reading review-contract.md (the anchor) satisfies
     the main gate; the eight profile bodies are profile-route reads, not main-required. */
  const id = 'anchor';
  const text = [
    assistantLine([{ id, filePath: guideRead('/repo', 'review-contract.md') }], DEEP_REVIEW_ATTRIBUTION_SKILL),
    resultLine([{ id }]),
  ].join('\n');
  const decision = evaluateGuidesRead({
    transcriptText: text,
    markerPresent: false,
    cwd: '/repo',
    loadConfig: () => config(),
    deps: isolatedDeps(),
  });
  assert.equal(decision.kind, 'allow');
});

test('an active pass that read the profile bodies but SKIPPED the review-contract anchor is BLOCKED', () => {
  const lines: string[] = [];
  TEMPLATE_NAMES.filter((name) => name !== 'review-contract.md').forEach((name, index) => {
    const id = `p-${index}`;
    lines.push(assistantLine([{ id, filePath: guideRead('/repo', name) }], DEEP_REVIEW_ATTRIBUTION_SKILL));
    lines.push(resultLine([{ id }]));
  });
  const decision = evaluateGuidesRead({
    transcriptText: lines.join('\n'),
    markerPresent: false,
    cwd: '/repo',
    loadConfig: () => config(),
    deps: isolatedDeps(),
  });
  assert.equal(decision.kind, 'block');
  if (decision.kind === 'block') assert.match(decision.reason, /review-contract\.md/);
});

test('an active pass that skipped a guide is BLOCKED, naming the unread guide', () => {
  const decision = evaluateGuidesRead({
    transcriptText: fullReviewTranscript('/repo', 1),
    markerPresent: false,
    cwd: '/repo',
    loadConfig: () => config(),
    deps: isolatedDeps(),
  });
  assert.equal(decision.kind, 'block');
  if (decision.kind !== 'block') return;
  assert.match(decision.reason, new RegExp(TEMPLATE_NAMES[TEMPLATE_NAMES.length - 1] ?? 'profile-security.md'));
});

test('the marker activates the gate even when the transcript is unreadable (fail-closed)', () => {
  const decision = evaluateGuidesRead({
    transcriptText: undefined,
    markerPresent: true,
    cwd: '/repo',
    loadConfig: () => config(),
    deps: isolatedDeps(),
  });
  assert.equal(decision.kind, 'block');
});

test('no marker + unreadable transcript is treated as NOT a review (skip)', () => {
  const decision = evaluateGuidesRead({
    transcriptText: undefined,
    markerPresent: false,
    cwd: '/repo',
    loadConfig: () => config(),
    deps: isolatedDeps(),
  });
  assert.equal(decision.kind, 'skip');
});

test('an active pass whose config fails to load is BLOCKED (never silent-allow)', () => {
  const decision = evaluateGuidesRead({
    transcriptText: fullReviewTranscript('/repo'),
    markerPresent: false,
    cwd: '/repo',
    loadConfig: () => {
      throw new Error('quality.json missing');
    },
    deps: isolatedDeps(),
  });
  assert.equal(decision.kind, 'block');
});

test('an active pass with an unread configured required_read is BLOCKED via GuidesUnavailable', () => {
  const decision = evaluateGuidesRead({
    transcriptText: fullReviewTranscript('/repo'),
    markerPresent: false,
    cwd: '/repo',
    loadConfig: () => config({ requiredReads: ['.claude/GONE.md'] }),
    deps: { listOverlay: () => undefined, exists: () => false, realpath: (value) => value },
  });
  assert.equal(decision.kind, 'block');
});

// ── cli guides-read verb (the hook edge) ──────────────────────────────────────────

/* The CLI verb loads the REAL quality.json + package templates, so these run against a
   temp repo on disk (the pure gate logic is already isolated above via injected deps). */
const MANIFEST = {
  version: 1,
  repo: 'fixture',
  stack: 'node-service',
  scheduler_class: 'local-only',
  budgets: { staged_seconds: 15, fast_seconds: 90, full_seconds: 300, audit_seconds: 300 },
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
  deep_review: { enabled: true, modes: ['review-only', 'review-and-refactor'] },
};

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function withRepo(callback: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-cli-'));
  try {
    fs.writeFileSync(path.join(root, 'quality.json'), JSON.stringify(MANIFEST));
    callback(fs.realpathSync(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runGuidesRead(args: string[], overrides: Partial<CliDeps>): CliRun {
  let stdout = '';
  let stderr = '';
  const deps: CliDeps = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    realpath: (value) => value,
    // Temp repos are not git checkouts; stub the worktree probe so approved roots = [cwd].
    worktreeRoots: () => [],
    ...overrides,
  };
  const code = runCli(['guides-read', ...args], deps);
  return { code, stdout, stderr };
}

function stopEnvelope(root: string, transcriptPath: string): string {
  return JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: root, transcript_path: transcriptPath });
}

test('--hook-stdin blocks (stdout decision JSON) when a guide was skipped', () => {
  withRepo((root) => {
    const run = runGuidesRead(['--hook-stdin'], {
      readStdin: () => stopEnvelope(root, '/tmp/transcript.jsonl'),
      readFile: () => fullReviewTranscript(root, 1),
      fileExists: () => false,
      getEnv: () => undefined,
    });
    assert.equal(run.code, 0);
    const decision = JSON.parse(run.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /mandated guide/);
  });
});

test('--hook-stdin allows (no stdout) when every guide was read', () => {
  withRepo((root) => {
    const run = runGuidesRead(['--hook-stdin'], {
      readStdin: () => stopEnvelope(root, '/tmp/t.jsonl'),
      readFile: () => fullReviewTranscript(root),
      fileExists: () => false,
      getEnv: () => undefined,
    });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, '');
  });
});

test('--hook-stdin skips (no block) a non-review session', () => {
  withRepo((root) => {
    const run = runGuidesRead(['--hook-stdin'], {
      readStdin: () => stopEnvelope(root, '/tmp/t.jsonl'),
      readFile: () => assistantLine([{ id: 'a', filePath: '/x.ts' }]),
      fileExists: () => false,
      getEnv: () => undefined,
    });
    assert.equal(run.stdout, '');
  });
});

test('DEEP_REVIEW_GUARD_OFF=1 disables the gate even with guides skipped', () => {
  withRepo((root) => {
    const run = runGuidesRead(['--hook-stdin'], {
      readStdin: () => stopEnvelope(root, '/tmp/t.jsonl'),
      readFile: () => fullReviewTranscript(root, 3),
      fileExists: () => false,
      getEnv: (name) => (name === 'DEEP_REVIEW_GUARD_OFF' ? '1' : undefined),
    });
    assert.equal(run.stdout, '');
    assert.equal(run.code, 0);
  });
});

test('--hook-stdin never blocks on an unparseable (harness-provided) envelope', () => {
  const run = runGuidesRead(['--hook-stdin'], {
    readStdin: () => 'not json at all',
    getEnv: () => undefined,
  });
  assert.equal(run.stdout, '');
  assert.equal(run.code, 0);
});

test('a SubagentStop envelope reads the subagent transcript field', () => {
  withRepo((root) => {
    let readPath = '';
    const run = runGuidesRead(['--hook-stdin'], {
      readStdin: () =>
        JSON.stringify({
          hook_event_name: 'SubagentStop',
          session_id: 's1',
          cwd: root,
          agent_transcript_path: '/tmp/agent.jsonl',
          transcript_path: '/tmp/parent.jsonl',
        }),
      readFile: (filePath) => {
        readPath = filePath;
        return fullReviewTranscript(root, 1);
      },
      fileExists: () => false,
      getEnv: () => undefined,
    });
    assert.equal(readPath, '/tmp/agent.jsonl');
    assert.equal(JSON.parse(run.stdout).decision, 'block');
  });
});

test('--transcript direct mode reports ok/skipped/reason as JSON', () => {
  withRepo((root) => {
    const run = runGuidesRead(['--transcript', '/tmp/t.jsonl', '--cwd', root], {
      readFile: () => fullReviewTranscript(root, 1),
      getEnv: () => undefined,
    });
    const report = JSON.parse(run.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.skipped, false);
    assert.match(report.reason, /mandated guide/);
  });
});

test('guides-read without a mode flag is a usage error', () => {
  const run = runGuidesRead([], { cwd: () => '/repo', getEnv: () => undefined });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--hook-stdin or --transcript/);
});
