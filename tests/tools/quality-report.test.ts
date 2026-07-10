import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLines, resolveTelemetryPath } from '../../tools/quality-stats.mjs';
import { buildReportModel, renderHtml, runOutcome, writeAtomic } from '../../tools/quality-report.mjs';

/* The .mjs tools are dep-free and export no types; these builders mirror the RunEvent
   emitter contract (docs/effectiveness-plan.md §2 + runner telemetry) so fixtures stay
   readable. exit/aborted are explicit here because the report's run outcome is derived from
   them, never from a re-computed isBlockingResult. */
type Result = {
  name: string;
  tier: string;
  status: string;
  durationMs?: number | null;
  mode?: string | null;
  reason?: string;
};

const DAY = 86_400_000;
const T = Date.parse('2026-07-10T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function ev(
  startedAt: string,
  repo: string,
  branch: string | null,
  results: Result[],
  opts: { exit?: number | null; aborted?: boolean; finishedAt?: string; head_sha?: string | null } = {},
): unknown {
  return {
    v: 1,
    startedAt,
    finishedAt: opts.finishedAt ?? startedAt,
    repo,
    scope: 'staged',
    branch,
    head_sha: opts.head_sha === undefined ? 'deadbeef' : opts.head_sha,
    exit: opts.exit === undefined ? 0 : opts.exit,
    aborted: opts.aborted === undefined ? false : opts.aborted,
    results,
  };
}

function jsonl(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

function modelOf(objs: unknown[], opts: Record<string, unknown> = {}): any {
  const { events, malformed, unsupported } = parseLines(jsonl(objs));
  return buildReportModel({
    events,
    malformed,
    unsupported,
    sourcePath: '/x/events.jsonl',
    now: T,
    sinceDays: 90,
    pruneDays: 30,
    ...opts,
  });
}

/* ---- run outcome: exit/aborted only, never a re-derived block rule ---- */

test('runOutcome: exit 0 → pass; positive exit → blocked; aborted or null-exit → aborted', () => {
  assert.equal(runOutcome({ exit: 0, aborted: false }), 'pass');
  assert.equal(runOutcome({ exit: 1, aborted: false }), 'blocked');
  assert.equal(runOutcome({ exit: 137, aborted: false }), 'blocked');
  assert.equal(runOutcome({ exit: null, aborted: true }), 'aborted');
  assert.equal(runOutcome({ exit: 0, aborted: true }), 'aborted', 'abort wins over a stale exit');
  assert.equal(runOutcome({ exit: null, aborted: false }), 'aborted', 'null exit without a flag is unknown → aborted bucket');
});

test('buildReportModel: a report-only fail on a clean (exit 0) run is a PASS run, not blocked', () => {
  // Decoupling proof: the run outcome comes from exit, the check row from the result status.
  const model = modelOf([
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'eslint', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
  ]);
  assert.equal(model.runs[0].outcome, 'pass');
  assert.equal(model.kpis.blocked, 0);
  assert.equal(model.checks[0].fail, 1, 'the check still records its report-only fail');
});

test('buildReportModel: a blocking timeout with a nonzero exit is a BLOCKED run', () => {
  const model = modelOf([
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'tsc', tier: 'fast', status: 'timeout', durationMs: 5000, mode: 'blocking' }], { exit: 1 }),
  ]);
  assert.equal(model.runs[0].outcome, 'blocked');
  assert.equal(model.kpis.blocked, 1);
  assert.equal(model.kpis.timeouts, 1, 'the timeout is counted as noise, not an error');
  assert.equal(model.kpis.errors, 0, 'a timeout is never labelled an error');
});

test('buildReportModel: an aborted event (exit null, aborted true) is ABORTED, never a green pass', () => {
  const model = modelOf([
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'tsc', tier: 'fast', status: 'error', durationMs: 0, mode: 'blocking', reason: 'ENOENT' }], { exit: null, aborted: true }),
  ]);
  assert.equal(model.runs[0].outcome, 'aborted');
  assert.equal(model.kpis.blocked, 0);
  assert.equal(model.kpis.aborted, 1);
});

/* ---- KPIs, catches, latestMode through aggregate ---- */

test('buildReportModel: KPIs are exact sums over the in-window runs', () => {
  const model = modelOf([
    ev(iso(T - 3 * DAY), 'ai', 'main', [{ name: 'eslint', tier: 'fast', status: 'fail', durationMs: 100, mode: 'report-only' }], { exit: 0 }),
    ev(iso(T - 2 * DAY), 'ai', 'main', [{ name: 'eslint', tier: 'fast', status: 'pass', durationMs: 90, mode: 'report-only' }], { exit: 0 }),
    ev(iso(T - 1 * DAY), 'ai', 'main', [{ name: 'gitleaks', tier: 'fast', status: 'fail', durationMs: 50, mode: 'blocking' }], { exit: 1 }),
  ]);
  assert.equal(model.kpis.runs, 3);
  assert.equal(model.kpis.blocked, 1);
  assert.equal(model.kpis.aborted, 0);
  assert.equal(model.kpis.catches, 1, 'the eslint fail→pass is one catch candidate');
  assert.equal(model.kpis.bypasses, 0);
  // latestMode + flip come straight through aggregate
  const eslint = model.checks.find((c: any) => c.check === 'eslint');
  assert.equal(eslint.latestMode, 'report-only');
  assert.equal(eslint.flip, true, 'report-only + in-window catch + 0 noise → flip candidate');
  assert.equal(eslint.catches, 1);
});

test('buildReportModel: a future occurrence does not steal latestMode (via aggregate)', () => {
  const model = modelOf([
    ev(iso(T - 2 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
    // a future-dated event is dropped by the pre-filter before aggregate ever sees it
    ev(iso(T + 3_600_000), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }),
  ]);
  const c = model.checks.find((x: any) => x.check === 'c');
  assert.equal(c.latestMode, 'report-only');
  assert.equal(c.flip, true);
  assert.equal(model.meta.counters.futureDated, 1);
});

/* ---- window: an old and a future event appear in NO displayed metric (brief §6) ---- */

test('buildReportModel: out-of-window and future-dated events are excluded everywhere', () => {
  const model = modelOf(
    [
      ev(iso(T - 100 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }), // too old
      ev(iso(T + 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }), // future
      ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }), // the only in-window run
    ],
    { sinceDays: 7 },
  );
  assert.equal(model.meta.counters.valid, 1, 'only the in-window event is valid');
  assert.equal(model.meta.counters.futureDated, 1, 'the future event is counted, not silently swallowed');
  assert.equal(model.runs.length, 1);
  assert.equal(model.checks.length, 1);
  assert.equal(model.catches.length, 0);
  assert.equal(model.kpis.runs, 1);
});

test('buildReportModel: window edges are inclusive at the cutoff and at now', () => {
  const model = modelOf(
    [
      ev(iso(T - 7 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }), // exactly at cutoff
      ev(iso(T), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }), // exactly at now
      ev(iso(T - 7 * DAY - 1), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }), // 1ms before cutoff → out
    ],
    { sinceDays: 7 },
  );
  assert.equal(model.meta.counters.valid, 2, 'both edge events are inside; only the pre-cutoff one is dropped');
});

/* ---- bypass KPI ---- */

test('buildReportModel: bypasses KPI counts every bypassed result in the window', () => {
  const model = modelOf([
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'secrets', tier: 'fast', status: 'bypassed', durationMs: 5, mode: 'blocking', reason: 'flaky infra' }], { exit: 0 }),
  ]);
  assert.equal(model.kpis.bypasses, 1);
  assert.equal(model.checks[0].bypassed, 1);
});

/* ---- escaping: untrusted branch/repo/check names cannot break out of the DATA script ---- */

test('renderHtml: a hostile branch name is neutralised — no raw </script> in the payload', () => {
  const model = modelOf([
    ev(iso(T - 1 * DAY), 'r', '</script><script>alert(1)</script>', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }),
  ]);
  const html = renderHtml(model);
  /* GUARDED LINE: embedData()'s `JSON.stringify(model).replace(/</g, '\\u003c')` in
     tools/quality-report.mjs. The document has exactly two <script> blocks → exactly two
     </script> closers; the hostile branch adds two more the moment that .replace is
     reverted, so this count is the red-check. */
  assert.equal((html.match(/<\/script>/g) || []).length, 2, 'no injected </script> from the branch name');
  assert.ok(html.includes('\\u003c/script>'), 'the < was serialized as the JS escape \\u003c');
  assert.ok(!html.includes('<script>alert(1)'), 'the payload never renders an executable inline script');
});

/* ---- empty / missing input → valid HTML with an empty-state marker ---- */

test('buildReportModel + renderHtml: no events → valid HTML with the empty-state marker', () => {
  const model = buildReportModel({ events: [], sourcePath: '/x/events.jsonl', now: T });
  assert.equal(model.meta.counters.valid, 0);
  assert.equal(model.runs.length, 0);
  const html = renderHtml(model);
  assert.ok(html.includes('const DATA ='), 'data still embedded');
  assert.ok(html.includes('id="empty-state"'), 'empty-state element present');
  assert.ok(html.includes('No telemetry data'), 'empty-state marker text present');
  assert.ok(!/https?:\/\//.test(html), 'self-contained: no external references');
});

/* ---- resolveTelemetryPath: off falls back to the default sink for readers (brief §1) ---- */

test('resolveTelemetryPath: DS_TELEMETRY_PATH=off falls back to the default sink (no error path)', () => {
  const dflt = path.join('/home', '.local', 'share', 'dev-standards', 'events.jsonl');
  assert.equal(resolveTelemetryPath(undefined, { DS_TELEMETRY_PATH: 'off' }, '/home'), dflt);
});

/* ---- flip badge uses the calibration window, never the embed window ---- */

test('buildReportModel: a catch inside the embed window but outside the 7d flip window does NOT badge flip', () => {
  // fail→pass at ~40d ago: well inside the 90d embed window, far outside the 7d flip window.
  const catchPair = (at: number): unknown[] => [
    ev(iso(T - at * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
    ev(iso(T - at * DAY + 3_600_000), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
  ];
  const stale = modelOf(catchPair(40));
  assert.equal(stale.checks[0].catches, 1, 'the catch itself IS shown (embed window)');
  assert.equal(stale.checks[0].flip, false, 'but candidacy expired with the 7d calibration window');
  assert.equal(stale.meta.flipDays, 7, 'the calibration window is surfaced to the view');
  assert.equal(stale.meta.pruneDays, 30);
  // the same pair 2d ago is inside the calibration window → badge on.
  const fresh = modelOf(catchPair(2));
  assert.equal(fresh.checks[0].flip, true);
});

test('buildReportModel: a short embed window cannot hide calibration-window evidence from the badges', () => {
  // A fresh catch + a 5d-old timeout on the same key. The 7d flip window sees the noise and
  // must refuse candidacy even when --days 1 excludes the timeout from the DISPLAYED window.
  const noisy = modelOf(
    [
      ev(iso(T - 5 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'timeout', durationMs: 999, mode: 'report-only' }], { exit: 0 }),
      ev(iso(T - 7_200_000), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
      ev(iso(T - 3_600_000), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
    ],
    { sinceDays: 1 },
  );
  assert.equal(noisy.runs.length, 2, 'the timeout run is outside the displayed window');
  assert.equal(noisy.checks[0].flip, false, 'quality-stats sees the 7d noise → so must the badge');
  // Same trap for prune: a 20d-old fail is inside the 30d prune window even when --days 7 hides it.
  const dirty = modelOf(
    [
      ev(iso(T - 20 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'blocking' }], { exit: 1 }),
      ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }], { exit: 0 }),
    ],
    { sinceDays: 7 },
  );
  assert.equal(dirty.checks[0].prune, false, 'the 30d prune window still sees the fail');
});

test('buildReportModel: badges join by tuple key — a real branch named "(none)" never inherits a null-branch candidacy', () => {
  const model = modelOf([
    // null branch: fresh fail→pass on a report-only check → flip candidate.
    ev(iso(T - 7_200_000), 'r', null, [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
    ev(iso(T - 3_600_000), 'r', null, [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
    // the literal branch "(none)" shares the human label but must NOT share the badge.
    ev(iso(T - 1_800_000), 'r', '(none)', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }], { exit: 0 }),
  ]);
  const nullRow = model.checks.find((c: any) => c.branch === null);
  const namedRow = model.checks.find((c: any) => c.branch === '(none)');
  assert.equal(nullRow.flip, true);
  assert.equal(namedRow.flip, false, 'label collision must not leak candidacy across keys');
});

/* ---- CLI: sink-clobber guard, days validation, missing sink, end-to-end ---- */

const TOOL = fileURLToPath(new URL('../../tools/quality-report.mjs', import.meta.url));

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function withFixture(fn: (file: string, dir: string) => void): void {
  const now = Date.now();
  const at = (d: number): string => new Date(now - d * DAY).toISOString();
  const fixture = jsonl([
    ev(at(2), 'repoX', 'main', [{ name: 'eslint', tier: 'fast', status: 'fail', durationMs: 300, mode: 'report-only' }], { exit: 0 }),
    ev(at(1), 'repoX', 'main', [{ name: 'eslint', tier: 'fast', status: 'pass', durationMs: 280, mode: 'report-only' }], { exit: 0 }),
    ev(at(3), 'repoX', 'main', [{ name: 'knip', tier: 'full', status: 'pass', durationMs: 50, mode: 'blocking' }], { exit: 0 }),
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-report-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, fixture);
  try {
    fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI: --out that aliases the input sink exits 2 and leaves the sink byte-identical', () => {
  withFixture((file) => {
    const before = fs.readFileSync(file);
    const res = runCli(['--path', file, '--out', file]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /refusing to overwrite/);
    assert.deepEqual(fs.readFileSync(file), before, 'the sink was not touched');
  });
});

test('CLI: a DANGLING-symlink sink aliasing --out is refused before anything is written', () => {
  // The sink does not exist yet (freshest possible machine) but is a symlink pointing at the
  // exact file the report would create: fail-open here would let the next telemetry append
  // write JSONL into the report HTML.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-report-'));
  try {
    const target = path.join(dir, 'future-sink.jsonl');
    const link = path.join(dir, 'events.jsonl');
    fs.symlinkSync(target, link); // dangling: target does not exist
    const res = runCli(['--path', link, '--out', target]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /refusing to overwrite/);
    assert.equal(fs.existsSync(target), false, 'nothing was written at the future sink target');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomic: a race-planted symlink at the tmp path cannot redirect the write onto another file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-report-'));
  try {
    const victim = path.join(dir, 'victim.jsonl');
    fs.writeFileSync(victim, 'precious telemetry\n');
    const out = path.join(dir, 'r.html');
    // Attacker guesses the tmp name (suffix injected to make the guess deterministic) and
    // plants a symlink to the victim: 'wx' must refuse to follow it instead of truncating.
    fs.symlinkSync(victim, path.join(dir, '.r.html.tmp-guessed'));
    assert.throws(() => writeAtomic(out, '<html></html>', 'guessed'), /EEXIST/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'precious telemetry\n', 'victim untouched');
    assert.equal(fs.existsSync(out), false, 'no report written through the planted tmp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --days rejects a non-positive-integer window', () => {
  withFixture((file, dir) => {
    const out = path.join(dir, 'r.html');
    const res = runCli(['--path', file, '--out', out, '--days', '0']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /positive integer/);
    assert.equal(fs.existsSync(out), false, 'nothing written on a bad window');
  });
});

test('CLI: a missing sink still writes a valid empty-state report and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-report-'));
  const missing = path.join(dir, 'nope', 'events.jsonl');
  const out = path.join(dir, 'r.html');
  try {
    const res = runCli(['--path', missing, '--out', out]);
    assert.equal(res.status, 0, res.stderr);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('const DATA ='));
    assert.ok(html.includes('No telemetry data'), 'empty-state marker present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: end-to-end writes a self-contained report with the data embedded and check names', () => {
  withFixture((file, dir) => {
    const out = path.join(dir, 'r.html');
    const res = runCli(['--path', file, '--out', out, '--days', '30']);
    assert.equal(res.status, 0, res.stderr);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('const DATA ='), 'embedded DATA present');
    assert.ok(html.includes('eslint'), 'a fixture check name is embedded');
    assert.ok(html.includes('knip'), 'the other fixture check name is embedded');
    assert.ok(!/https?:\/\//.test(html), 'self-contained: no external references');
  });
});
