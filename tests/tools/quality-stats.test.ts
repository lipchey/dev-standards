import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseLines,
  normalizeEvent,
  aggregate,
  formatReport,
  p50,
  countCatches,
  resolveTelemetryPath,
  parseDays,
  inWindow,
} from '../../tools/quality-stats.mjs';

/* The .mjs tool is dep-free and exports no types; these builders mirror the
   emitter contract (docs/effectiveness-plan.md §2) so fixtures stay readable. */
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
  finishedAt: string = startedAt,
): unknown {
  return {
    v: 1,
    startedAt,
    finishedAt,
    repo,
    scope: 'staged',
    branch,
    head_sha: 'deadbeef',
    exit: 0,
    aborted: false,
    results,
  };
}

function jsonl(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

function aggregateOf(objs: unknown[], opts: Record<string, unknown> = {}): any {
  const { events } = parseLines(jsonl(objs));
  return aggregate(events, { now: T, sinceDays: 7, pruneDays: 30, ...opts });
}

/* ---- parseLines: malformed / unsupported / truncated / empty ---- */

test('parseLines: a normal event parses; blank trailing line is not counted', () => {
  const { events, malformed, unsupported } = parseLines(
    jsonl([ev(iso(T), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }])]),
  );
  assert.equal(events.length, 1);
  assert.equal(malformed, 0);
  assert.equal(unsupported, 0);
});

test('parseLines: a truncated final line is skipped and counted malformed, never aborts', () => {
  const good = JSON.stringify(ev(iso(T), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }]));
  const text = good + '\n' + '{"v":1,"startedAt":"2026-07-'; // crash-truncated last line
  const { events, malformed } = parseLines(text);
  assert.equal(events.length, 1);
  assert.equal(malformed, 1);
});

test('parseLines: an invalid-JSON middle line is skipped, the events around it survive', () => {
  const a = JSON.stringify(ev(iso(T), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }]));
  const b = JSON.stringify(ev(iso(T + 1000), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }]));
  const { events, malformed } = parseLines([a, 'not json at all {', b].join('\n'));
  assert.equal(events.length, 2);
  assert.equal(malformed, 1);
});

test('parseLines: an unsupported v:2 line is counted separately from malformed', () => {
  const good = ev(iso(T), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }]);
  const v2 = { ...(good as Record<string, unknown>), v: 2 };
  const { events, malformed, unsupported } = parseLines(jsonl([good, v2]));
  assert.equal(events.length, 1);
  assert.equal(unsupported, 1);
  assert.equal(malformed, 0);
});

test('parseLines: empty file yields zero events and zero counters', () => {
  const { events, malformed, unsupported } = parseLines('');
  assert.equal(events.length, 0);
  assert.equal(malformed, 0);
  assert.equal(unsupported, 0);
});

/* ---- normalizeEvent: required-field validation ---- */

test('normalizeEvent: missing v is malformed (not unsupported)', () => {
  assert.equal(normalizeEvent({ startedAt: iso(T), repo: 'r', results: [] }).kind, 'malformed');
});

test('normalizeEvent: v:2 is unsupported even when other fields are missing', () => {
  assert.equal(normalizeEvent({ v: 2, startedAt: iso(T) }).kind, 'unsupported');
});

test('normalizeEvent: missing repo / bad startedAt / non-array results are malformed', () => {
  assert.equal(normalizeEvent({ v: 1, startedAt: iso(T), results: [] }).kind, 'malformed'); // no repo
  assert.equal(normalizeEvent({ v: 1, startedAt: 'not-a-date', repo: 'r', results: [] }).kind, 'malformed');
  assert.equal(normalizeEvent({ v: 1, startedAt: iso(T), repo: 'r', results: {} }).kind, 'malformed');
});

test('normalizeEvent: a result missing name/tier/status makes the event malformed', () => {
  assert.equal(
    normalizeEvent({ v: 1, startedAt: iso(T), repo: 'r', results: [{ name: 'c', tier: 'fast' }] }).kind,
    'malformed',
  );
  assert.equal(
    normalizeEvent({ v: 1, startedAt: iso(T), repo: 'r', results: [{ name: 'c', tier: 'fast', status: 'nope' }] }).kind,
    'malformed',
  );
});

test('normalizeEvent: a valid event with null branch normalizes to a null branch key part', () => {
  const res = normalizeEvent(ev(iso(T), 'r', null, [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 5, mode: 'blocking' }]));
  assert.ok(res.event);
  assert.equal(res.event.branch, null);
});

test('normalizeEvent: surfaces the run outcome fields exit/aborted, tolerating absent/bad values', () => {
  const base = ev(iso(T), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 5, mode: 'blocking' }]) as Record<string, unknown>;
  const clean: any = normalizeEvent(base); // the ev builder sets exit:0, aborted:false
  assert.equal(clean.event.exit, 0);
  assert.equal(clean.event.aborted, false);

  const abortedRun: any = normalizeEvent({ ...base, exit: null, aborted: true });
  assert.equal(abortedRun.event.exit, null, 'a null exit rides through as null');
  assert.equal(abortedRun.event.aborted, true);

  const junk: any = normalizeEvent({ ...base, exit: 'nope', aborted: 'yes' });
  assert.equal(junk.event.exit, null, 'a non-number exit → null, not malformed');
  assert.equal(junk.event.aborted, false, 'aborted is true ONLY on a strict boolean true');

  const { exit: _e, aborted: _a, ...noOutcome } = base;
  const legacy: any = normalizeEvent(noOutcome);
  assert.ok(legacy.event, 'an older writer that omits exit/aborted is still valid, not malformed');
  assert.equal(legacy.event.exit, null);
  assert.equal(legacy.event.aborted, false);
});

/* ---- aggregate: catch-candidates, key separation, windows ---- */

test('aggregate: a fail then a pass in the next run of the same key is one catch-candidate', () => {
  const agg = aggregateOf([
    ev(iso(T - 2 * DAY), 'ai-prompter', 'main', [{ name: 'eslint', tier: 'fast', status: 'fail', durationMs: 300, mode: 'report-only' }]),
    ev(iso(T - 1 * DAY), 'ai-prompter', 'main', [{ name: 'eslint', tier: 'fast', status: 'pass', durationMs: 280, mode: 'report-only' }]),
  ]);
  const k = agg.keys[0];
  assert.equal(k.runs, 2);
  assert.equal(k.catches, 1);
  assert.equal(agg.flip.length, 1);
  assert.equal(agg.flip[0].label, 'ai-prompter/fast/eslint@main');
});

test('aggregate: same check name in two tiers and two repos stays separate — no cross-contamination', () => {
  const agg = aggregateOf([
    // repoA/fast: a real fail→pass episode
    ev(iso(T - 2 * DAY), 'repoA', 'main', [{ name: 'eslint', tier: 'fast', status: 'fail', durationMs: 100, mode: 'report-only' }]),
    ev(iso(T - 1 * DAY), 'repoA', 'main', [{ name: 'eslint', tier: 'fast', status: 'pass', durationMs: 100, mode: 'report-only' }]),
    // repoA/full: same name, different tier — only ever passed
    ev(iso(T - 2 * DAY), 'repoA', 'main', [{ name: 'eslint', tier: 'full', status: 'pass', durationMs: 100, mode: 'report-only' }]),
    // repoB/fast: same name+tier, different repo — only ever passed
    ev(iso(T - 2 * DAY), 'repoB', 'main', [{ name: 'eslint', tier: 'fast', status: 'pass', durationMs: 100, mode: 'report-only' }]),
  ]);
  assert.equal(agg.keys.length, 3);
  const byLabel: Record<string, any> = {};
  for (const k of agg.keys) byLabel[k.label] = k;
  assert.equal(byLabel['repoA/fast/eslint@main'].catches, 1);
  assert.equal(byLabel['repoA/full/eslint@main'].catches, 0);
  assert.equal(byLabel['repoB/fast/eslint@main'].catches, 0);
  // only the one real episode is a flip candidate
  assert.deepEqual(agg.flip.map((f: any) => f.label), ['repoA/fast/eslint@main']);
});

test('aggregate: window boundary is inclusive — a fail exactly at the since-cutoff still catches', () => {
  const cutoff = T - 7 * DAY; // sinceDays 7
  const inWindow = aggregateOf([
    ev(iso(cutoff), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }]),
    ev(iso(cutoff + 3_600_000), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }]),
  ]);
  assert.equal(inWindow.flip.length, 1, 'fail at exactly the cutoff is inside the window');
});

test('aggregate: a fail 1ms before the cutoff is outside the window and does not manufacture a catch', () => {
  const cutoff = T - 7 * DAY;
  const outWindow = aggregateOf([
    ev(iso(cutoff - 1), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }]),
    ev(iso(cutoff + 3_600_000), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }]),
  ]);
  assert.equal(outWindow.flip.length, 0);
});

test('aggregate: skipped is excluded from runs, duration and denominators, but not from catch adjacency', () => {
  const agg = aggregateOf([
    ev(iso(T - 3 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 100, mode: 'report-only' }]),
    ev(iso(T - 2 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'skipped', durationMs: 0, mode: 'report-only' }]),
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 200, mode: 'report-only' }]),
  ]);
  const k = agg.keys[0];
  assert.equal(k.runs, 2, 'skipped is not a run');
  assert.equal(k.counts.skipped, 1);
  assert.equal(k.catches, 1, 'fail → (skipped dropped) → pass is still a catch');
  assert.equal(k.p50, 150, 'p50 over [100,200] — the skipped 0ms is excluded');
});

test('aggregate: timeout in the window is operational noise that kills flip candidacy', () => {
  const agg = aggregateOf([
    ev(iso(T - 3 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 100, mode: 'report-only' }]),
    ev(iso(T - 2 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 100, mode: 'report-only' }]),
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'timeout', durationMs: 5000, mode: 'report-only' }]),
  ]);
  const k = agg.keys[0];
  assert.equal(k.catches, 1, 'the fail→pass is still a catch-candidate in the table');
  assert.equal(k.counts.timeout, 1);
  assert.equal(agg.flip.length, 0, 'operational noise in the window disqualifies the flip');
});

test('aggregate: error is operational noise too, and bypass reasons are collected', () => {
  const agg = aggregateOf([
    ev(iso(T - 2 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'bypassed', durationMs: 100, mode: 'report-only', reason: 'flaky infra' }]),
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'error', durationMs: 0, mode: 'report-only', reason: 'ENOENT' }]),
  ]);
  const k = agg.keys[0];
  assert.equal(k.runs, 2, 'bypassed and error are non-skipped runs');
  assert.equal(k.counts.bypassed, 1);
  assert.equal(k.counts.error, 1);
  assert.deepEqual(k.bypassReasons, ['flaky infra']);
  assert.equal(agg.flip.length, 0, 'no catch → no flip');
  assert.equal(agg.prune.length, 0, 'bypassed/error is not a clean pass → not prunable');
});

/* ---- aggregate: prune candidates ---- */

test('aggregate: a check that only ever passes inside the prune window is a prune candidate', () => {
  const agg = aggregateOf([
    ev(iso(T - 5 * DAY), 'r', 'main', [{ name: 'knip', tier: 'full', status: 'pass', durationMs: 50, mode: 'blocking' }]),
    ev(iso(T - 4 * DAY), 'r', 'main', [{ name: 'knip', tier: 'full', status: 'pass', durationMs: 60, mode: 'blocking' }]),
  ]);
  assert.equal(agg.prune.length, 1);
  assert.equal(agg.prune[0].label, 'r/full/knip@main');
});

test('aggregate: a single fail inside the prune window removes the prune candidacy', () => {
  const agg = aggregateOf([
    ev(iso(T - 5 * DAY), 'r', 'main', [{ name: 'knip', tier: 'full', status: 'pass', durationMs: 50, mode: 'blocking' }]),
    ev(iso(T - 3 * DAY), 'r', 'main', [{ name: 'knip', tier: 'full', status: 'fail', durationMs: 60, mode: 'blocking' }]),
  ]);
  assert.equal(agg.prune.length, 0);
});

test('aggregate: a fail OLDER than the prune window does not disqualify prune candidacy', () => {
  const agg = aggregateOf([
    ev(iso(T - 40 * DAY), 'r', 'main', [{ name: 'knip', tier: 'full', status: 'fail', durationMs: 60, mode: 'blocking' }]),
    ev(iso(T - 2 * DAY), 'r', 'main', [{ name: 'knip', tier: 'full', status: 'pass', durationMs: 50, mode: 'blocking' }]),
  ]);
  assert.equal(agg.prune.length, 1, 'the fail sits outside the 30d prune window');
});

/* ---- totals ---- */

test('aggregate: totals use per-event wall-clock span, not summed check durations', () => {
  // durationMs is deliberately tiny (1ms): the 2000ms total can only come from the spans.
  const agg = aggregateOf([
    ev(iso(T - 2 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 1, mode: 'report-only' }], iso(T - 2 * DAY + 1000)),
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 1, mode: 'report-only' }], iso(T - 1 * DAY + 1000)),
  ]);
  assert.equal(agg.totals.totalCatches, 1);
  assert.equal(agg.totals.totalSpanMs, 2000, 'span = Σ(finishedAt - startedAt), not Σ durationMs');
  assert.equal(agg.totals.spanlessEvents, 0);
  assert.equal(agg.totals.dayCount, 2);
  assert.equal(agg.totals.perDayMs, 1000);
  assert.equal(agg.totals.costPerCatchSec, 2);
});

test('aggregate: an event with an unparseable finishedAt falls back to Σ durationMs and is counted', () => {
  const agg = aggregateOf([
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 500, mode: 'blocking' }], 'not-a-date'),
  ]);
  assert.equal(agg.totals.totalSpanMs, 500, 'no usable span → summed check time');
  assert.equal(agg.totals.spanlessEvents, 1);
});

test('aggregate: empty event list produces empty lists and a null cost-per-catch', () => {
  const agg = aggregate([], { now: T });
  assert.deepEqual(agg.keys, []);
  assert.deepEqual(agg.flip, []);
  assert.deepEqual(agg.prune, []);
  assert.deepEqual(agg.catches, []);
  assert.equal(agg.totals.totalCatches, 0);
  assert.equal(agg.totals.costPerCatchSec, null);
});

/* ---- F6: catch-candidate pair listing ---- */

test('formatReport: Catch candidates lists each fail→pass pair with startedAt + short sha; null sha renders "-"', () => {
  const failAt = iso(T - 2 * DAY);
  const passAt = iso(T - 1 * DAY);
  const { events } = parseLines(
    jsonl([
      { ...(ev(failAt, 'repoX', 'main', [{ name: 'eslint', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }]) as Record<string, unknown>), head_sha: 'abc1234567890def' },
      { ...(ev(passAt, 'repoX', 'main', [{ name: 'eslint', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }]) as Record<string, unknown>), head_sha: null },
    ]),
  );
  const agg = aggregate(events, { now: T, sinceDays: 7, pruneDays: 30 });
  // The section count is derived from the same list (single source).
  assert.equal(agg.catches.length, 1);
  assert.equal(agg.totals.totalCatches, 1);

  const report = formatReport(agg);
  assert.ok(report.includes('## Catch candidates'), 'section present');
  const line = report.split('\n').find((l) => l.startsWith('- repoX fast eslint main:'));
  assert.equal(
    line,
    `- repoX fast eslint main: fail ${failAt} (abc123456789) -> pass ${passAt} (-)`,
    `catch-candidate pair mis-rendered; got:\n${report}`,
  );
});

/* ---- F7: windows reject future-dated events ---- */

test('aggregate: a future-dated event (clock skew/tamper) is outside both windows', () => {
  const future = iso(T + 3_600_000); // 1h ahead of now=T
  // flip: an in-window fail + a FUTURE pass must not manufacture an in-window catch.
  const flipAgg = aggregateOf([
    ev(iso(T - 2 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }]),
    ev(future, 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }]),
  ]);
  assert.equal(flipAgg.flip.length, 0, 'a future pass cannot manufacture an in-window catch');
  // prune: a lone FUTURE pass is not an in-window clean pass.
  const pruneAgg = aggregateOf([
    ev(future, 'r', 'main', [{ name: 'c', tier: 'full', status: 'pass', durationMs: 10, mode: 'blocking' }]),
  ]);
  assert.equal(pruneAgg.prune.length, 0, 'a future pass is not an in-window clean pass');
});

test('aggregate: a future-dated event does not define latestMode / flip eligibility', () => {
  // In-window fail(report-only) -> pass(report-only) = a flip candidate; a FUTURE
  // occurrence with mode 'blocking' must not steal latestMode and suppress it.
  const agg = aggregateOf([
    ev(iso(T - 2 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'fail', durationMs: 10, mode: 'report-only' }]),
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'report-only' }]),
    ev(iso(T + 3_600_000), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'pass', durationMs: 10, mode: 'blocking' }]),
  ]);
  assert.equal(agg.keys[0]!.latestMode, 'report-only', 'latestMode ignores future occurrences');
  assert.equal(agg.flip.length, 1, 'the in-window catch still yields a flip candidate');
});

/* ---- F8: bypass reasons cannot inject report lines / terminal controls ---- */

test('formatReport: a bypass reason with a newline and ANSI is JSON-escaped onto one line', () => {
  const reason = 'boom\n[31mred';
  const agg = aggregateOf([
    ev(iso(T - 1 * DAY), 'r', 'main', [{ name: 'c', tier: 'fast', status: 'bypassed', durationMs: 10, mode: 'blocking', reason }]),
  ]);
  const report = formatReport(agg);
  const line = report.split('\n').find((l) => l.startsWith('- r/fast/c@main:'));
  assert.ok(line, `bypass reason line present; got:\n${report}`);
  assert.ok(line.includes(JSON.stringify(reason)), 'reason is JSON-quoted');
  assert.ok(!line.includes(''), 'the raw ESC byte is escaped away');
  assert.equal(report.split('\n').filter((l) => l.includes('boom')).length, 1, 'the reason stays on one line');
});

/* ---- small pure helpers ---- */

test('inWindow: inclusive at both ends; rejects pre-cutoff and future-dated', () => {
  const now = T;
  const cutoff = T - 7 * DAY;
  assert.equal(inWindow(cutoff, cutoff, now), true, 'exactly at the cutoff is inside');
  assert.equal(inWindow(now, cutoff, now), true, 'exactly at now is inside');
  assert.equal(inWindow(cutoff - 1, cutoff, now), false, '1ms before the cutoff is out');
  assert.equal(inWindow(now + 1, cutoff, now), false, '1ms in the future is out');
});

test('p50: median with even-length averaging', () => {
  assert.equal(p50([]), null);
  assert.equal(p50([5]), 5);
  assert.equal(p50([10, 20, 30]), 20);
  assert.equal(p50([10, 20]), 15);
});

test('countCatches: fail→pass counts; noise or a regression between them does not', () => {
  assert.equal(countCatches([]), 0);
  assert.equal(countCatches([{ status: 'fail' }, { status: 'pass' }]), 1);
  assert.equal(countCatches([{ status: 'fail' }, { status: 'timeout' }, { status: 'pass' }]), 0);
  assert.equal(countCatches([{ status: 'pass' }, { status: 'fail' }]), 0);
  assert.equal(countCatches([{ status: 'fail' }, { status: 'pass' }, { status: 'fail' }, { status: 'pass' }]), 2);
});

test('resolveTelemetryPath: --path wins; DS_TELEMETRY_PATH used unless unset or "off"', () => {
  const dflt = path.join('/home', '.local', 'share', 'dev-standards', 'events.jsonl');
  assert.equal(resolveTelemetryPath('/x/y.jsonl', {}, '/home'), '/x/y.jsonl');
  assert.equal(resolveTelemetryPath(undefined, { DS_TELEMETRY_PATH: '/custom.jsonl' }, '/home'), '/custom.jsonl');
  assert.equal(resolveTelemetryPath(undefined, { DS_TELEMETRY_PATH: 'off' }, '/home'), dflt);
  assert.equal(resolveTelemetryPath(undefined, {}, '/home'), dflt);
});

test('parseDays: only a positive integer is accepted', () => {
  assert.equal(parseDays('7', '--since'), 7);
  assert.throws(() => parseDays('0', '--since'), /positive integer/);
  assert.throws(() => parseDays('', '--since'), /positive integer/);
  assert.throws(() => parseDays('3.5', '--since'), /positive integer/);
  assert.throws(() => parseDays('-1', '--since'), /positive integer/);
});

/* ---- CLI: missing file, and the documented sections end-to-end ---- */

const TOOL = fileURLToPath(new URL('../../tools/quality-stats.mjs', import.meta.url));

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('CLI: a missing telemetry file prints a friendly message and exits 0', () => {
  const missing = path.join(os.tmpdir(), 'ds-stats-nope', `events-${process.pid}.jsonl`);
  const res = runCli(['--path', missing]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /no telemetry file/);
  assert.match(res.stdout, /nothing to analyze/);
});

test('CLI: a real fixture prints every documented section, both candidate lists, and the counters', () => {
  // Live clock is deliberate: events stay a fixed N days old, so they never age out of the
  // subprocess CLI's 7/30-day flip/prune windows. The CLI reads its own clock (t+init), but with
  // days of margin the read-skew is harmless — not a t@t+init flake to harden (verified 2026-07-25).
  const now = Date.now();
  const at = (deltaDays: number): string => new Date(now - deltaDays * DAY).toISOString();
  const fixture = [
    // flip candidate: report-only eslint fail→pass within the flip window
    JSON.stringify(ev(at(2), 'repoX', 'main', [{ name: 'eslint', tier: 'fast', status: 'fail', durationMs: 300, mode: 'report-only' }])),
    JSON.stringify(ev(at(1), 'repoX', 'main', [{ name: 'eslint', tier: 'fast', status: 'pass', durationMs: 280, mode: 'report-only' }])),
    // prune candidate: knip only ever passes
    JSON.stringify(ev(at(5), 'repoX', 'main', [{ name: 'knip', tier: 'full', status: 'pass', durationMs: 50, mode: 'blocking' }])),
    JSON.stringify(ev(at(4), 'repoX', 'main', [{ name: 'knip', tier: 'full', status: 'pass', durationMs: 60, mode: 'blocking' }])),
    'garbage not json', // malformed
    JSON.stringify({ ...(ev(at(3), 'repoX', 'main', []) as Record<string, unknown>), v: 2 }), // unsupported
  ].join('\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-stats-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, fixture + '\n');
  try {
    const res = runCli(['--path', file]);
    assert.equal(res.status, 0, res.stderr);
    for (const section of ['## Per-key', '## Catch candidates', '## Flip candidates', '## Prune candidates', '## Totals']) {
      assert.ok(res.stdout.includes(section), `missing section: ${section}`);
    }
    assert.ok(res.stdout.includes('repoX/fast/eslint@main'), 'flip candidate listed');
    assert.ok(res.stdout.includes('repoX/full/knip@main'), 'prune candidate listed');
    // The eslint fail→pass is a catch-candidate pair (head_sha "deadbeef" from the ev builder).
    assert.match(
      res.stdout,
      /- repoX fast eslint main: fail .* \(deadbeef\) -> pass .* \(deadbeef\)/,
      'catch-candidate pair listed',
    );
    assert.ok(res.stdout.includes('malformed=1'), 'malformed counter');
    assert.ok(res.stdout.includes('unsupported-version=1'), 'unsupported counter');
    assert.ok(res.stdout.includes('human disposition required per docs/CALIBRATION.md'), 'candidate label');
    assert.ok(res.stdout.includes('requires mutation evidence'), 'mutation-evidence label');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
