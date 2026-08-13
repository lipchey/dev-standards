#!/usr/bin/env node
/*
 * quality-report: a human-friendly VISUAL layer over the SAME verify telemetry sink that
 * tools/quality-stats.mjs analyses
 * (docs/plans/archive/2026-07-10-effectiveness-plan.md §8.6). The text report stays
 * the calibration-session workhorse; this renders a single self-contained HTML dashboard —
 * "how is dev-standards doing at a glance" — that opens offline, survives a re-clone, and is
 * one artifact to share. No server, no npm deps, no CDN.
 *
 * All aggregation (windows, catch adjacency, flip/prune, run outcome, latestMode) is done
 * HERE in Node by reusing quality-stats' exported pure fns; the embedded client JS only
 * filters slim per-run rows and sums counts. Nothing is re-derived in the browser, so the
 * numbers can never drift from the text report.
 *
 * Dep-free Node ESM (bare `node tools/quality-report.mjs`). buildReportModel + renderHtml are
 * pure and unit-tested; arg-parsing + file IO is a thin CLI wrapper.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  resolveTelemetryPath,
  parseLines,
  aggregate,
  inWindow,
  parseDays,
  DEFAULT_SINCE_DAYS,
  DEFAULT_PRUNE_DAYS,
} from './quality-stats.mjs';

const DAY_MS = 86_400_000;
/* The embed window (what the dashboard SHOWS, --days) is deliberately wider than the
   calibration windows (what BADGES a flip/prune candidate): a dashboard wants a few months of
   context, but candidacy must mean exactly what quality-stats' text report means, so the flip
   (7d) and prune (30d) windows are imported from there and never follow --days. */
const DEFAULT_WINDOW_DAYS = 90;

/* ---- run outcome -----------------------------------------------------------
 * The whole run's verdict, straight from the persisted RunEvent exit/aborted (never a
 * re-derived isBlockingResult): aborted → 'aborted'; clean exit → 'pass'; a positive exit is
 * a real gate block → 'blocked'; a null exit with no abort flag is an unknown crash → the
 * aborted/unknown bucket (never a green pass).
 */
export function runOutcome(event) {
  if (event.aborted) return 'aborted';
  if (event.exit === 0) return 'pass';
  if (typeof event.exit === 'number' && event.exit > 0) return 'blocked';
  return 'aborted';
}

function dayOf(startedAtMs) {
  return new Date(startedAtMs).toISOString().slice(0, 10);
}

function countStatus(results, status) {
  let n = 0;
  for (const r of results) if (r.status === status) n += 1;
  return n;
}

/* ---- buildReportModel ------------------------------------------------------
 * Pure: everything the view needs, precomputed. Windows the events to
 * `cutoff <= startedAtMs <= now` (cutoff = now - sinceDays*DAY) BEFORE aggregate — aggregate
 * itself only windows flip/prune internally, so an out-of-window or future-dated event would
 * otherwise leak into the KPIs/byDay/checks/catches. futureDated counts events dropped for
 * being ahead of `now` (clock skew/tamper); older-than-window events are the expected slice
 * boundary and are silently excluded.
 */
export function buildReportModel({
  events,
  malformed = 0,
  unsupported = 0,
  sourcePath = '',
  now = Date.now(),
  sinceDays = DEFAULT_WINDOW_DAYS,
  flipDays = DEFAULT_SINCE_DAYS,
  pruneDays = DEFAULT_PRUNE_DAYS,
}) {
  const cutoff = now - sinceDays * DAY_MS;
  const windowed = [];
  const present = [];
  let futureDated = 0;
  for (const e of events) {
    if (e.startedAtMs > now) {
      futureDated += 1;
      continue;
    }
    present.push(e);
    if (inWindow(e.startedAtMs, cutoff, now)) windowed.push(e);
  }

  /* Two aggregations, two jobs. Displayed stats come from the EMBED window (`windowed`).
     Flip/prune candidacy comes from ALL non-future events over the CALIBRATION windows —
     candidacy computed from an embed subset would diverge from quality-stats' text report
     the moment --days is shorter than a calibration window (e.g. --days 1 hides a 5-day-old
     timeout from the 7d flip window → false flip; --days 7 hides a 20-day-old fail from the
     30d prune window → false prune). Joined to table rows by the collision-free tuple `key`,
     never the human label. */
  const agg = aggregate(windowed, { now, sinceDays: flipDays, pruneDays });
  const candidates = aggregate(present, { now, sinceDays: flipDays, pruneDays });

  /* Slim per-run rows: one per verify run, carrying only what the client sums/filters. The
     errors/timeouts split is kept separate (not folded into one "noise") so the KPI can show
     both sub-counts under filtering without labelling a timeout an error. */
  const runs = windowed.map((e) => ({
    date: dayOf(e.startedAtMs),
    repo: e.repo,
    branch: e.branch,
    tiers: [...new Set(e.results.map((r) => r.tier))],
    outcome: runOutcome(e),
    bypassed: countStatus(e.results, 'bypassed'),
    errors: countStatus(e.results, 'error'),
    timeouts: countStatus(e.results, 'timeout'),
  }));

  const flipKeys = new Set(candidates.flip.map((f) => f.key));
  const pruneKeys = new Set(candidates.prune.map((p) => p.key));
  const checks = agg.keys.map((k) => ({
    repo: k.repo,
    tier: k.tier,
    check: k.name,
    branch: k.branch,
    timingSource: k.timingSource,
    latestMode: k.latestMode,
    runs: k.runs,
    fail: k.counts.fail,
    failRate: k.runs ? k.counts.fail / k.runs : 0,
    catches: k.catches,
    errors: k.counts.error,
    timeouts: k.counts.timeout,
    bypassed: k.counts.bypassed,
    p50Ms: k.p50,
    flip: flipKeys.has(k.key),
    prune: pruneKeys.has(k.key),
  }));

  /* Catch pairs carry no reason (fail results have none — runner types); the view shows
     timestamps + short SHAs for human disposition. */
  const catches = agg.catches.map((c) => ({
    repo: c.repo,
    tier: c.tier,
    check: c.name,
    branch: c.branch,
    timingSource: c.timingSource,
    failStartedAt: c.failStartedAt,
    failSha: c.failSha,
    passStartedAt: c.passStartedAt,
    passSha: c.passSha,
  }));

  const repos = [...new Set(windowed.map((e) => e.repo))].sort();
  const tiers = [...new Set(windowed.flatMap((e) => e.results.map((r) => r.tier)))].sort();
  const branchKeys = new Map();
  for (const e of windowed) branchKeys.set(JSON.stringify(e.branch), e.branch);
  const branches = [...branchKeys.values()].sort((a, b) =>
    String(a).localeCompare(String(b)),
  );

  return {
    meta: {
      generatedAt: new Date(now).toISOString(),
      sourcePath,
      windowDays: sinceDays,
      flipDays,
      pruneDays,
      counters: { valid: windowed.length, malformed, unsupported, futureDated },
    },
    kpis: {
      runs: runs.length,
      blocked: runs.filter((r) => r.outcome === 'blocked').length,
      aborted: runs.filter((r) => r.outcome === 'aborted').length,
      catches: catches.length,
      bypasses: runs.reduce((s, r) => s + r.bypassed, 0),
      errors: runs.reduce((s, r) => s + r.errors, 0),
      timeouts: runs.reduce((s, r) => s + r.timeouts, 0),
    },
    checks,
    catches,
    runs,
    filters: { repos, tiers, branches },
  };
}

/* ---- HTML ------------------------------------------------------------------
 * One self-contained file: inline CSS, the embedded DATA, and the client app. No external
 * host is referenced (no http(s):// anywhere, no CDN, no SVG xmlns — inline SVG needs none),
 * so a strict-offline open renders identically.
 */
const CSS = `
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --line: #e5e7eb; --card: #f7f7f8;
  --pass: #16a34a; --blocked: #dc2626; --aborted: #9ca3af;
  --flip: #d97706; --prune: #7c3aed;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --fg: #e6e6e6; --muted: #9aa0a6; --line: #2a2d34; --card: #171a20;
    --pass: #22c55e; --blocked: #ef4444; --aborted: #6b7280;
    --flip: #f59e0b; --prune: #a78bfa;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 1.75rem 0 .5rem; }
.sub { color: var(--muted); margin: 0 0 1rem; }
.filters { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
.filters select {
  padding: .35rem .5rem; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); font: inherit;
}
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .75rem; }
.kpi { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: .75rem 1rem; }
.kpi .n { font-size: 1.6rem; font-weight: 650; }
.kpi .l { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
svg#chart { width: 100%; height: 200px; display: block; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
.seg-pass { fill: var(--pass); }
.seg-blocked { fill: var(--blocked); }
.seg-aborted { fill: var(--aborted); }
.chart-meta { display: flex; justify-content: space-between; color: var(--muted); font-size: .8rem; margin-top: .35rem; }
.legend span { margin-left: .9rem; }
.legend i { display: inline-block; width: .7rem; height: .7rem; border-radius: 2px; margin-right: .3rem; vertical-align: middle; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; }
th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; }
tr.muted td { color: var(--muted); }
.badge { display: inline-block; padding: .05rem .4rem; border-radius: 999px; font-size: .72rem; margin-right: .3rem; }
.badge.flip { background: color-mix(in srgb, var(--flip) 22%, transparent); color: var(--flip); }
.badge.prune { background: color-mix(in srgb, var(--prune) 22%, transparent); color: var(--prune); }
.scroll { overflow-x: auto; }
ul.catches { list-style: none; padding: 0; margin: 0; }
ul.catches li { padding: .35rem 0; border-bottom: 1px solid var(--line); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
footer { margin-top: 2rem; color: var(--muted); font-size: .8rem; border-top: 1px solid var(--line); padding-top: .75rem; }
footer code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.empty { padding: 2rem; text-align: center; color: var(--muted); background: var(--card); border: 1px dashed var(--line); border-radius: 10px; }
[hidden] { display: none !important; }
`;

/* Client app. Deliberately backtick/${}-free so it survives embedding inside this module's own
   template literal. Every string that could carry untrusted data (repo/branch/check names,
   timestamps) reaches the DOM via textContent; the only innerHTML writes are the chart's
   numeric-geometry rects and empty-string clears — no data strings. */
const APP_JS = `
(function () {
  var byId = function (id) { return document.getElementById(id); };
  var meta = DATA.meta, filters = DATA.filters;

  byId('c-valid').textContent = String(meta.counters.valid);
  byId('c-malformed').textContent = String(meta.counters.malformed);
  byId('c-unsupported').textContent = String(meta.counters.unsupported);
  byId('c-future').textContent = String(meta.counters.futureDated);
  byId('c-source').textContent = meta.sourcePath || '(default sink)';
  byId('c-generated').textContent = meta.generatedAt;
  byId('c-window').textContent = String(meta.windowDays);
  byId('c-flipd').textContent = String(meta.flipDays);
  byId('c-pruned').textContent = String(meta.pruneDays);

  var repoSel = byId('f-repo'), tierSel = byId('f-tier'), branchSel = byId('f-branch');
  var addOpt = function (sel, value, label) {
    var o = document.createElement('option');
    o.value = value; o.textContent = label; sel.appendChild(o);
  };
  addOpt(repoSel, '', 'all repos');
  filters.repos.forEach(function (r) { addOpt(repoSel, r, r); });
  addOpt(tierSel, '', 'all tiers');
  filters.tiers.forEach(function (t) { addOpt(tierSel, t, t); });
  addOpt(branchSel, '', 'all branches');
  filters.branches.forEach(function (b) { addOpt(branchSel, JSON.stringify(b), b === null ? '(none)' : b); });
  [repoSel, tierSel, branchSel].forEach(function (s) { s.addEventListener('change', render); });

  function curFilter() { return { repo: repoSel.value, tier: tierSel.value, branch: branchSel.value }; }
  function runMatch(r, f) {
    if (f.repo && r.repo !== f.repo) return false;
    if (f.tier && r.tiers.indexOf(f.tier) === -1) return false;
    if (f.branch && JSON.stringify(r.branch) !== f.branch) return false;
    return true;
  }
  function rowMatch(row, f) {
    if (f.repo && row.repo !== f.repo) return false;
    if (f.tier && row.tier !== f.tier) return false;
    if (f.branch && JSON.stringify(row.branch) !== f.branch) return false;
    return true;
  }
  function shortSha(s) { return (typeof s === 'string' && s) ? s.slice(0, 12) : '-'; }
  function setText(id, v) { byId(id).textContent = String(v); }

  function render() {
    var f = curFilter();
    var runs = DATA.runs.filter(function (r) { return runMatch(r, f); });
    var blocked = 0, byp = 0, errs = 0, tos = 0, days = {};
    runs.forEach(function (r) {
      if (r.outcome === 'blocked') blocked += 1;
      byp += r.bypassed; errs += r.errors; tos += r.timeouts;
      var d = days[r.date] || (days[r.date] = { pass: 0, blocked: 0, aborted: 0 });
      d[r.outcome] += 1;
    });
    var catches = DATA.catches.filter(function (c) { return rowMatch(c, f); });

    setText('k-runs', runs.length);
    setText('k-blocked', blocked);
    setText('k-catches', catches.length);
    setText('k-bypasses', byp);
    setText('k-noise', errs + tos);
    byId('kpi-noise').title = 'errors: ' + errs + '  timeouts: ' + tos;

    renderChart(days);
    renderChecks(f);
    renderCatches(catches);
    byId('empty-state').hidden = DATA.runs.length !== 0;
    byId('dashboard').hidden = DATA.runs.length === 0;
  }

  function renderChart(days) {
    var svg = byId('chart');
    var dates = Object.keys(days).sort();
    if (dates.length === 0) { svg.innerHTML = ''; byId('chart-range').textContent = ''; return; }
    var max = 1;
    dates.forEach(function (d) { var t = days[d].pass + days[d].blocked + days[d].aborted; if (t > max) max = t; });
    var W = 960, H = 200, padX = 10, padTop = 10, padBot = 16, chartH = H - padTop - padBot;
    var step = (W - 2 * padX) / dates.length;
    var bw = Math.max(3, Math.min(46, step - 6));
    var parts = [];
    dates.forEach(function (d, i) {
      var v = days[d], cx = padX + i * step + step / 2, y = H - padBot;
      [['pass', v.pass], ['blocked', v.blocked], ['aborted', v.aborted]].forEach(function (seg) {
        var h = seg[1] / max * chartH;
        if (h <= 0) return;
        y -= h;
        parts.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + y.toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" class="seg-' + seg[0] + '"></rect>');
      });
    });
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = parts.join('');
    byId('chart-range').textContent = dates[0] + '  →  ' + dates[dates.length - 1] + '  (' + dates.length + ' day(s))';
  }

  function renderChecks(f) {
    var tbody = byId('checks-body');
    tbody.innerHTML = '';
    var rows = DATA.checks.filter(function (c) { return rowMatch(c, f); });
    byId('checks-empty').hidden = rows.length !== 0;
    rows.forEach(function (c) {
      var tr = document.createElement('tr');
      if (c.latestMode === 'report-only') tr.className = 'muted';
      var cells = [
        c.repo, c.tier, c.check, c.branch === null ? '(none)' : c.branch,
        c.timingSource, c.latestMode || '-', String(c.runs), String(c.fail),
        c.runs ? Math.round(c.failRate * 100) + '%' : '-',
        String(c.catches), String(c.errors + c.timeouts),
        c.p50Ms === null ? '-' : String(c.p50Ms),
      ];
      cells.forEach(function (val) { var td = document.createElement('td'); td.textContent = val; tr.appendChild(td); });
      var td = document.createElement('td');
      if (c.flip) { var b = document.createElement('span'); b.className = 'badge flip'; b.textContent = '⚑ flip'; td.appendChild(b); }
      if (c.prune) { var b2 = document.createElement('span'); b2.className = 'badge prune'; b2.textContent = '✂ prune'; td.appendChild(b2); }
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }

  function renderCatches(catches) {
    var ul = byId('catches-list');
    ul.innerHTML = '';
    byId('catches-empty').hidden = catches.length !== 0;
    catches.forEach(function (c) {
      var li = document.createElement('li');
      var branch = c.branch === null ? '(none)' : c.branch;
      li.textContent = c.repo + ' · ' + c.tier + ' · ' + c.check + ' @ ' + branch +
        ' [' + c.timingSource + ']' +
        ':  fail ' + c.failStartedAt + ' (' + shortSha(c.failSha) + ')  →  pass ' +
        c.passStartedAt + ' (' + shortSha(c.passSha) + ')';
      ul.appendChild(li);
    });
  }

  render();
})();
`;

/* Serialize the model as a JS literal, neutralising every `<` so an untrusted string value
   (a repo/branch/check name containing `</script>` or `<!--`) cannot close the script or open
   a comment. GUARDED LINE — reverting this .replace makes the escaping test go red. */
function embedData(model) {
  return JSON.stringify(model).replace(/</g, '\\u003c');
}

export function renderHtml(model) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dev-standards telemetry</title>
<style>${CSS}</style>
</head>
<body>
<h1>dev-standards — telemetry report</h1>
<p class="sub">generated <span id="c-generated"></span> · window <span id="c-window"></span> day(s) · source <code id="c-source"></code></p>

<p id="empty-state" class="empty" hidden>No telemetry data recorded in this window yet — run <code>./verify</code> a few times, then regenerate.</p>

<div id="dashboard" hidden>
  <div class="filters">
    <select id="f-repo" aria-label="repo filter"></select>
    <select id="f-tier" aria-label="tier filter"></select>
    <select id="f-branch" aria-label="branch filter"></select>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="n" id="k-runs">0</div><div class="l">runs</div></div>
    <div class="kpi"><div class="n" id="k-blocked">0</div><div class="l">blocked</div></div>
    <div class="kpi"><div class="n" id="k-catches">0</div><div class="l">catch candidates</div></div>
    <div class="kpi"><div class="n" id="k-bypasses">0</div><div class="l">bypasses</div></div>
    <div class="kpi" id="kpi-noise"><div class="n" id="k-noise">0</div><div class="l">noise (err+timeout)</div></div>
  </div>

  <h2>Daily activity</h2>
  <svg id="chart" preserveAspectRatio="none"></svg>
  <div class="chart-meta">
    <span id="chart-range"></span>
    <span class="legend"><span><i class="seg-pass" style="background:var(--pass)"></i>pass</span><span><i style="background:var(--blocked)"></i>blocked</span><span><i style="background:var(--aborted)"></i>aborted</span></span>
  </div>

  <h2>Checks <span class="sub" style="font-weight:400">— flip/prune badges use the calibration windows (<span id="c-flipd"></span>d flip / <span id="c-pruned"></span>d prune), independent of the embed window and current filter</span></h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>repo</th><th>tier</th><th>check</th><th>branch</th><th>timing</th><th>mode</th>
        <th>runs</th><th>fail</th><th>fail%</th><th>catch</th><th>noise</th><th>p50ms</th><th>candidate</th>
      </tr></thead>
      <tbody id="checks-body"></tbody>
    </table>
  </div>
  <p id="checks-empty" class="sub" hidden>(no checks match the current filter)</p>

  <h2>Catch candidates <span class="sub" style="font-weight:400">— fail → pass in the next run of the same key; human disposition required (docs/CALIBRATION.md)</span></h2>
  <ul id="catches-list" class="catches"></ul>
  <p id="catches-empty" class="sub" hidden>(no catch candidates match the current filter)</p>
</div>

<footer>
  valid=<span id="c-valid"></span> · malformed=<span id="c-malformed"></span> ·
  unsupported=<span id="c-unsupported"></span> · future-dated=<span id="c-future"></span>
</footer>

<script>const DATA = ${embedData(model)};</script>
<script>${APP_JS}</script>
</body>
</html>
`;
}

/* ---- CLI wrapper ----------------------------------------------------------- */
function parseCliArgs(argv) {
  const opts = { path: undefined, out: './quality-report.html', days: DEFAULT_WINDOW_DAYS, open: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--path': opts.path = need(); break;
      case '--out': opts.out = need(); break;
      case '--days': opts.days = parseDays(need(), '--days'); break;
      case '--open': opts.open = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/* Resolve a path to its on-disk identity even when it does not (fully) exist yet: follow a
   (possibly dangling) symlink chain at the leaf, realpath the deepest existing ancestor, and
   rejoin the not-yet-existing remainder. A sink that is a dangling symlink must compare equal
   to its future target, or the alias guard fails open exactly when the sink is newest.
   Returns null for an INDETERMINATE identity (symlink loop or >40 hops, the kernel's own
   ceiling) — the caller must fail CLOSED on null, never treat it as "different file". Only
   symlink hops are capped; the ancestor walk needs none (dirname shortens monotonically). */
function canonicalize(p, hops = { count: 0, seen: new Set() }) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    /* not fully existing — fall through */
  }
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      if (hops.count >= 40 || hops.seen.has(abs)) return null;
      hops.seen.add(abs);
      hops.count += 1;
      return canonicalize(path.resolve(path.dirname(abs), fs.readlinkSync(abs)), hops);
    }
  } catch {
    /* entry absent entirely */
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  const cparent = canonicalize(parent, hops);
  return cparent === null ? null : path.join(cparent, path.basename(abs));
}

/* Refuse to write the report ONTO its own input sink. Canonical-path equality (symlinks
   followed, case-folded where the platform's default filesystem is case-insensitive) catches
   aliases even while one side does not exist yet; the stat dev+ino compare additionally
   catches hardlinks between existing files. Either way we exit before touching the sink. */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function isSameFile(a, b) {
  let ca = canonicalize(a);
  let cb = canonicalize(b);
  /* indeterminate identity (loop / hop-cap) → refuse: a guard that cannot establish the
     paths are different must not let the write proceed. */
  if (ca === null || cb === null) return true;
  if (CASE_INSENSITIVE_FS) {
    ca = ca.toLowerCase();
    cb = cb.toLowerCase();
  }
  if (ca === cb) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false; // one side does not exist and the canonical paths differ
  }
}

/* tmp sibling + rename = atomic replace: a reader never sees a half-written report, and a
   crash mid-write leaves the previous report intact (only the tmp is orphaned). The tmp is
   opened with 'wx' (O_CREAT|O_EXCL — refuses to follow ANYTHING pre-existing, symlinks
   included) and a random suffix, so a race-planted symlink at a guessed tmp name cannot
   redirect the truncating write onto another file. `suffix` is injectable for the test that
   proves exactly that. */
export function writeAtomic(outPath, contents, suffix = crypto.randomBytes(8).toString('hex')) {
  const dir = path.dirname(outPath);
  const tmp = path.join(dir, `.${path.basename(outPath)}.tmp-${suffix}`);
  /* cleanup only what THIS call created: on EEXIST the entry at tmp is someone else's
     (possibly the planted symlink itself) and must survive untouched. */
  let created = false;
  try {
    fs.writeFileSync(tmp, contents, { flag: 'wx', mode: 0o600 });
    created = true;
    fs.renameSync(tmp, outPath);
  } catch (error) {
    if (created) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already renamed */
      }
    }
    throw error;
  }
}

function main(argv) {
  const opts = parseCliArgs(argv);
  const filePath = resolveTelemetryPath(opts.path);

  if (isSameFile(filePath, opts.out)) {
    console.error(`quality-report: refusing to overwrite the telemetry sink at ${opts.out} with the report`);
    return 2;
  }

  let events = [];
  let malformed = 0;
  let unsupported = 0;
  if (fs.existsSync(filePath)) {
    const parsed = parseLines(fs.readFileSync(filePath, 'utf8'));
    ({ events, malformed, unsupported } = parsed);
  }

  const model = buildReportModel({
    events,
    malformed,
    unsupported,
    sourcePath: filePath,
    now: Date.now(),
    sinceDays: opts.days,
  });
  writeAtomic(opts.out, renderHtml(model));
  console.log(`quality-report: wrote ${opts.out} (${model.meta.counters.valid} run(s), window ${opts.days}d).`);

  if (opts.open) {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const res = spawnSync(cmd, [opts.out], { stdio: 'ignore' });
    if (res.error || (typeof res.status === 'number' && res.status !== 0)) {
      console.error(`quality-report: could not open ${opts.out} (${cmd} unavailable) — open it manually.`);
    }
  }
  return 0;
}

function isMain() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`quality-report: ${error.message}`);
    process.exit(2);
  }
}
