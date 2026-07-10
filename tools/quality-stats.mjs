#!/usr/bin/env node
/*
 * quality-stats: read the append-only verify telemetry (one JSONL line per run,
 * schema in docs/effectiveness-plan.md §2) and report what dev-standards actually
 * catches, so a calibration session (docs/CALIBRATION.md) can flip/prune/tune on
 * data instead of by eye.
 *
 * The file is GLOBAL — one per machine, shared by every consumer repo — and the
 * same check name legitimately runs in several tiers, so the aggregation key is
 * the full (repo, tier, check, branch) tuple; a shorter key would silently merge
 * unrelated series.
 *
 * Everything the tool concludes is a CANDIDATE, never a verdict: a catch-candidate
 * (a fail then a pass in the next run of the same key) may be a real catch or just
 * an unstage, and a never-failing gate is not proof it is safe to remove. Human
 * disposition happens in the calibration session; this tool only surfaces signal.
 *
 * Dep-free Node ESM (bare `node tools/quality-stats.mjs`). Pure fns
 * (parseLines / aggregate / formatReport) carry the logic and are unit-tested;
 * arg-parsing + file IO is a thin CLI wrapper. Built against the emitter contract
 * only — no runner import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPPORTED_VERSION = 1;
const DAY_MS = 86_400_000;
const STATUSES = new Set(['pass', 'fail', 'skipped', 'timeout', 'bypassed', 'error']);
/* timeout/error are tool/spawn faults, not verdicts about the change: they are
   "operational noise" that never counts as a catch and disqualifies a flip. */
const NOISE_STATUSES = new Set(['timeout', 'error']);
/* The calibration windows (flip = 7d, prune = 30d) are exported so the visual report
   (quality-report.mjs) badges flip/prune with EXACTLY these defaults — two tools disagreeing
   on what is a flip candidate would poison a calibration session. */
export const DEFAULT_SINCE_DAYS = 7;
export const DEFAULT_PRUNE_DAYS = 30;
/* Short head_sha rendered in the catch-candidate pairs (12 chars: unambiguous in any
   real repo yet short enough to skim); a null sha (non-git run) renders as "-". */
const SHA_SHORT_LEN = 12;

const CANDIDATE_LABEL =
  'candidates — human disposition required per docs/CALIBRATION.md; ' +
  'prune of a test/coverage gate additionally requires mutation evidence';

/* ---- path resolution -------------------------------------------------------
 * --path wins; else DS_TELEMETRY_PATH unless it is unset or the disable sentinel
 * "off"; else the canonical per-machine default. "off" disables the EMITTER, so
 * the reader falls back to the default location rather than a literal "off" file.
 */
export function resolveTelemetryPath(argPath, env = process.env, home = os.homedir()) {
  if (argPath !== undefined) return argPath;
  const configured = env.DS_TELEMETRY_PATH;
  if (configured && configured !== 'off') return configured;
  return path.join(home, '.local', 'share', 'dev-standards', 'events.jsonl');
}

/* ---- parseLines ------------------------------------------------------------
 * One JSONL line per run. A blank line (e.g. the trailing newline) is not data
 * and is not counted. A non-blank line that is bad JSON or a well-formed object
 * missing a required field is malformed AND counted; a well-formed object whose
 * `v` we do not support is unsupported AND counted (two separate counters). A
 * truncated final line is the expected crash-mode: it fails JSON.parse → counted
 * malformed, never aborts the run.
 */
export function parseLines(text) {
  const events = [];
  let malformed = 0;
  let unsupported = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const normalized = normalizeEvent(obj);
    if (normalized.event) events.push(normalized.event);
    else if (normalized.kind === 'unsupported') unsupported += 1;
    else malformed += 1;
  }
  return { events, malformed, unsupported };
}

/* Validate + normalize one parsed object against the v:1 contract. Version is
   checked before the field shape so a v:2 line missing v:1 fields is reported as
   unsupported, not malformed. Returns {event} on success, else {kind}. */
export function normalizeEvent(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { kind: 'malformed' };
  if (obj.v === undefined) return { kind: 'malformed' };
  if (obj.v !== SUPPORTED_VERSION) return { kind: 'unsupported' };

  const startedAtMs = typeof obj.startedAt === 'string' ? Date.parse(obj.startedAt) : NaN;
  if (!Number.isFinite(startedAtMs)) return { kind: 'malformed' };
  /* finishedAt is optional in practice (older/crash-truncated writers): parse it when
     present so totals can use the event span, else leave it null for the durationMs
     fallback. head_sha + the raw startedAt string ride along for the catch-candidate
     pairs; a non-string head_sha is tolerated as null (no new malformed reasons). */
  const finishedAtMs = typeof obj.finishedAt === 'string' ? Date.parse(obj.finishedAt) : NaN;
  if (typeof obj.repo !== 'string' || obj.repo === '') return { kind: 'malformed' };
  if (!Array.isArray(obj.results)) return { kind: 'malformed' };
  /* branch is nullable in the contract; undefined is coerced to null so it keys
     consistently. A non-string, non-null branch is a malformed event. */
  const branch = obj.branch === undefined ? null : obj.branch;
  if (branch !== null && typeof branch !== 'string') return { kind: 'malformed' };

  const results = [];
  for (const r of obj.results) {
    if (r === null || typeof r !== 'object') return { kind: 'malformed' };
    if (typeof r.name !== 'string' || typeof r.tier !== 'string') return { kind: 'malformed' };
    if (!STATUSES.has(r.status)) return { kind: 'malformed' };
    results.push({
      name: r.name,
      tier: r.tier,
      status: r.status,
      durationMs: Number.isFinite(r.durationMs) ? r.durationMs : null,
      mode: r.mode === 'blocking' || r.mode === 'report-only' ? r.mode : null,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
    });
  }
  return {
    event: {
      startedAt: obj.startedAt,
      startedAtMs,
      finishedAtMs: Number.isFinite(finishedAtMs) ? finishedAtMs : null,
      head_sha: typeof obj.head_sha === 'string' ? obj.head_sha : null,
      /* exit/aborted describe the whole RUN's outcome (RunEvent, runner telemetry): exit is
         the process exit code (null on abort/crash), aborted the abort flag. Tolerated
         loosely — absent/non-number exit → null, non-true aborted → false — so an older
         writer that omits them is never re-classified as malformed. */
      exit: typeof obj.exit === 'number' ? obj.exit : null,
      aborted: obj.aborted === true,
      repo: obj.repo,
      branch,
      results,
    },
  };
}

function keyOf(repo, tier, name, branch) {
  return JSON.stringify([repo, tier, name, branch]);
}

function labelOf(repo, tier, name, branch) {
  return `${repo}/${tier}/${name}@${branch === null ? '(none)' : branch}`;
}

/* p50 = median of ascending durations (integer ms). Even n averages the two
   middle samples so a 2-sample series is not silently reported as its lower one. */
export function p50(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAsc[mid] : Math.round((sortedAsc[mid - 1] + sortedAsc[mid]) / 2);
}

/* A catch-candidate is a `fail` immediately followed by a `pass` in the same
   key's next run. `occs` must be the key's NON-SKIPPED occurrences in
   chronological order: skipped runs are not runs, and an operational noise run
   (timeout/error) sits between a fail and a later pass, breaking the adjacency —
   which is exactly why noise "never catches". */
export function countCatches(occs) {
  return collectCatches(occs).length;
}

/* The fail→pass PAIRS behind countCatches, for the Catch candidates section. Same
   contract as countCatches (`occs` = non-skipped, chronological). Each pair carries the
   two occurrences so the report can print their startedAt + head_sha for disposition.
   Adjacency is transitively covered by the countCatches tests, so it stays module-local. */
function collectCatches(occs) {
  const pairs = [];
  for (let i = 1; i < occs.length; i += 1) {
    if (occs[i - 1].status === 'fail' && occs[i].status === 'pass') {
      pairs.push({ fail: occs[i - 1], pass: occs[i] });
    }
  }
  return pairs;
}

/* A startedAt is inside a window: on/after the cutoff and not in the future relative to
   `now`. Both ends inclusive — an event exactly on either edge is inside, and a
   future-dated event (clock skew/tamper) is excluded. Shared by aggregate's flip/prune
   windows and the visual report's pre-filter so the rule lives in exactly one place. */
export function inWindow(startedAtMs, cutoff, now) {
  return startedAtMs >= cutoff && startedAtMs <= now;
}

/* ---- aggregate -------------------------------------------------------------
 * Fold events into per-key stats, the windowed flip/prune candidate lists, and the flat
 * catch-candidate pair list. `now` anchors both windows (injected so tests are
 * deterministic; the CLI passes Date.now()). Window rule:
 * now - days*DAY_MS <= startedAt <= now — inclusive at both ends, so an event exactly on
 * either edge is inside and a future-dated event (clock skew/tamper) is excluded.
 */
export function aggregate(events, options = {}) {
  const now = options.now ?? Date.now();
  const sinceDays = options.sinceDays ?? DEFAULT_SINCE_DAYS;
  const pruneDays = options.pruneDays ?? DEFAULT_PRUNE_DAYS;
  const sinceCutoff = now - sinceDays * DAY_MS;
  const pruneCutoff = now - pruneDays * DAY_MS;

  const groups = new Map();
  const days = new Set();
  /* Total verify time = Σ per-event wall-clock span (finishedAt - startedAt), which also
     captures fileset expansion / runner overhead / aborted-before-check time that summing
     per-check durationMs omits. */
  let totalSpanMs = 0;
  let spanlessEvents = 0;

  for (const event of events) {
    days.add(new Date(event.startedAtMs).toISOString().slice(0, 10));
    let eventDurationMs = 0; // per-event Σ durationMs — the fallback when this event has no span
    for (const r of event.results) {
      if (r.status !== 'skipped' && r.durationMs !== null) eventDurationMs += r.durationMs;
      const key = keyOf(event.repo, r.tier, r.name, event.branch);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          repo: event.repo,
          tier: r.tier,
          name: r.name,
          branch: event.branch,
          occurrences: [],
        };
        groups.set(key, group);
      }
      group.occurrences.push({
        startedAtMs: event.startedAtMs,
        startedAt: event.startedAt,
        head_sha: event.head_sha,
        status: r.status,
        durationMs: r.durationMs,
        mode: r.mode,
        reason: r.reason,
      });
    }
    /* Fall back to Σ durationMs ONLY when finishedAt is missing/unparseable or precedes
       startedAt; count those events so the total's basis stays honest (they are NOT
       malformed — the event is otherwise valid). */
    const span =
      event.finishedAtMs !== null && event.finishedAtMs >= event.startedAtMs
        ? event.finishedAtMs - event.startedAtMs
        : null;
    if (span !== null) totalSpanMs += span;
    else {
      totalSpanMs += eventDurationMs;
      spanlessEvents += 1;
    }
  }

  const keys = [];
  /* Every fail→pass pair, flat across keys. The single source for both the Catch candidates
     section and the aggregate count (totalCatches = catches.length). */
  const catches = [];
  const flip = [];
  const prune = [];

  for (const group of groups.values()) {
    /* Stable sort by time; equal timestamps keep file order for deterministic
       adjacency. */
    const ordered = group.occurrences
      .map((o, i) => ({ o, i }))
      .sort((a, b) => a.o.startedAtMs - b.o.startedAtMs || a.i - b.i)
      .map((x) => x.o);

    const counts = { pass: 0, fail: 0, bypassed: 0, timeout: 0, error: 0, skipped: 0 };
    const durations = [];
    const bypassReasons = new Set();
    for (const o of ordered) {
      counts[o.status] += 1;
      if (o.status !== 'skipped' && o.durationMs !== null) durations.push(o.durationMs);
      if (o.status === 'bypassed' && o.reason) bypassReasons.add(o.reason);
    }
    durations.sort((a, b) => a - b);

    const nonSkipped = ordered.filter((o) => o.status !== 'skipped');
    const runs = nonSkipped.length;
    const keyCatches = collectCatches(nonSkipped);
    for (const pair of keyCatches) {
      catches.push({
        repo: group.repo,
        tier: group.tier,
        name: group.name,
        branch: group.branch,
        failStartedAt: pair.fail.startedAt,
        failSha: pair.fail.head_sha,
        passStartedAt: pair.pass.startedAt,
        passSha: pair.pass.head_sha,
      });
    }
    /* Current mode = the most recent NON-FUTURE occurrence's mode (this is what a flip
       would change). Future-dated events are excluded from the windows, so they must not
       define the current mode either. null if no occurrence declared one. */
    const present = ordered.filter((o) => o.startedAtMs <= now);
    const latestMode = present.length ? present[present.length - 1].mode : null;

    const record = {
      repo: group.repo,
      tier: group.tier,
      name: group.name,
      branch: group.branch,
      label: labelOf(group.repo, group.tier, group.name, group.branch),
      runs,
      counts,
      catches: keyCatches.length,
      p50: p50(durations),
      bypassReasons: [...bypassReasons],
      latestMode,
    };
    keys.push(record);

    /* Flip: a report-only check whose window shows a real catch and zero
       operational noise. Catch adjacency is computed WITHIN the window so a fail
       from before the window does not manufacture an in-window catch. */
    const sinceOccs = nonSkipped.filter((o) => inWindow(o.startedAtMs, sinceCutoff, now));
    const windowCatches = countCatches(sinceOccs);
    const windowNoise = sinceOccs.filter((o) => NOISE_STATUSES.has(o.status)).length;
    if (latestMode === 'report-only' && windowCatches >= 1 && windowNoise === 0) {
      flip.push({ label: record.label, catches: windowCatches });
    }

    /* Prune: a check that fired cleanly (>=1 pass) and never flagged anything
       (0 fail, 0 bypassed) inside the prune window. A bypassed run DID flag
       something a human waved through, and a timeout-only check never actually
       evaluated — neither is prunable, so both are excluded by construction. */
    const pruneOccs = nonSkipped.filter((o) => inWindow(o.startedAtMs, pruneCutoff, now));
    let pPass = 0;
    let pFail = 0;
    let pBypass = 0;
    for (const o of pruneOccs) {
      if (o.status === 'pass') pPass += 1;
      else if (o.status === 'fail') pFail += 1;
      else if (o.status === 'bypassed') pBypass += 1;
    }
    if (pPass >= 1 && pFail === 0 && pBypass === 0) {
      prune.push({ label: record.label, runs: pruneOccs.length, pass: pPass });
    }
  }

  keys.sort((a, b) => a.label.localeCompare(b.label));
  flip.sort((a, b) => a.label.localeCompare(b.label));
  prune.sort((a, b) => a.label.localeCompare(b.label));
  catches.sort(
    (a, b) =>
      labelOf(a.repo, a.tier, a.name, a.branch).localeCompare(labelOf(b.repo, b.tier, b.name, b.branch)) ||
      a.failStartedAt.localeCompare(b.failStartedAt),
  );

  const dayCount = days.size;
  const totalCatches = catches.length;
  return {
    keys,
    flip,
    prune,
    catches,
    totals: {
      events: events.length,
      dayCount,
      totalSpanMs,
      spanlessEvents,
      perDayMs: dayCount ? Math.round(totalSpanMs / dayCount) : 0,
      totalCatches,
      costPerCatchSec: totalCatches ? Math.round((totalSpanMs / totalCatches) / 100) / 10 : null,
    },
    sinceDays,
    pruneDays,
  };
}

/* ---- formatReport ---------------------------------------------------------- */
function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length), 0),
  );
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

/* head_sha short form for the catch-candidate pairs; a null sha (non-git run) prints "-". */
function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, SHA_SHORT_LEN) : '-';
}

export function formatReport(agg, meta = {}) {
  const out = [];
  out.push(`# quality-stats${meta.path ? ` — ${meta.path}` : ''}`);
  out.push(
    `# events=${agg.totals.events} malformed=${meta.malformed ?? 0} ` +
      `unsupported-version=${meta.unsupported ?? 0} ` +
      `flip-window=${agg.sinceDays}d prune-window=${agg.pruneDays}d`,
  );
  out.push('');

  out.push('## Per-key');
  if (agg.keys.length === 0) {
    out.push('(no runs recorded)');
  } else {
    const rows = agg.keys.map((k) => [
      k.repo,
      k.tier,
      k.name,
      k.branch === null ? '(none)' : k.branch,
      k.runs,
      k.counts.pass,
      k.counts.fail,
      k.counts.bypassed,
      k.counts.timeout,
      k.counts.error,
      k.catches,
      k.p50 === null ? '-' : k.p50,
    ]);
    out.push(
      table(
        ['repo', 'tier', 'check', 'branch', 'runs', 'pass', 'fail', 'byp', 'to', 'err', 'catch', 'p50ms'],
        rows,
      ),
    );
  }
  out.push('');

  const bypassed = agg.keys.filter((k) => k.bypassReasons.length > 0);
  if (bypassed.length > 0) {
    out.push('## Bypass reasons');
    /* Reasons are env-provided free text (DS_BYPASS_REASON). JSON-quote each so an embedded
       newline or ANSI/terminal control sequence is escaped and can't inject report lines. */
    for (const k of bypassed) {
      out.push(`- ${k.label}: ${k.bypassReasons.map((r) => JSON.stringify(r)).join('; ')}`);
    }
    out.push('');
  }

  out.push('## Catch candidates');
  out.push(CANDIDATE_LABEL);
  if (agg.catches.length === 0) out.push('(none)');
  else
    for (const c of agg.catches) {
      const branch = c.branch === null ? '(none)' : c.branch;
      out.push(
        `- ${c.repo} ${c.tier} ${c.name} ${branch}: ` +
          `fail ${c.failStartedAt} (${shortSha(c.failSha)}) -> pass ${c.passStartedAt} (${shortSha(c.passSha)})`,
      );
    }
  out.push('');

  out.push(`## Flip candidates (report-only, ≥1 catch, 0 operational noise, last ${agg.sinceDays}d)`);
  out.push(CANDIDATE_LABEL);
  if (agg.flip.length === 0) out.push('(none)');
  else for (const f of agg.flip) out.push(`- ${f.label} — catches=${f.catches}`);
  out.push('');

  out.push(`## Prune candidates (0 fails, last ${agg.pruneDays}d)`);
  out.push(CANDIDATE_LABEL);
  if (agg.prune.length === 0) out.push('(none)');
  else for (const p of agg.prune) out.push(`- ${p.label} — runs=${p.runs} pass=${p.pass}`);
  out.push('');

  out.push('## Totals');
  const cpc = agg.totals.costPerCatchSec === null ? 'N/A (no catch-candidates)' : `${agg.totals.costPerCatchSec}s`;
  /* perDayMs and cost-per-catch both derive from the same wall-clock span sum (finishedAt -
     startedAt), not summed check durations. Note events that lacked a usable span. */
  const spanless = agg.totals.spanlessEvents
    ? ` (${agg.totals.spanlessEvents} event(s) without a usable span — summed check time used)`
    : '';
  out.push(
    `verify wall-clock/day: ${agg.totals.perDayMs}ms over ${agg.totals.dayCount} day(s)${spanless}; ` +
      `total catch-candidates: ${agg.totals.totalCatches}; cost per catch: ${cpc}`,
  );

  return out.join('\n');
}

/* ---- CLI wrapper ----------------------------------------------------------- */
function parseCliArgs(argv) {
  const opts = { path: undefined, sinceDays: DEFAULT_SINCE_DAYS, pruneDays: DEFAULT_PRUNE_DAYS };
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
      case '--since': opts.sinceDays = parseDays(need(), '--since'); break;
      case '--prune-window': opts.pruneDays = parseDays(need(), '--prune-window'); break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/* A window must be a positive integer number of days; a blank/NaN/zero/negative
   value would silently widen or empty the window, so reject it loudly. */
export function parseDays(raw, flag) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const n = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer number of days`);
  }
  return n;
}

function main(argv) {
  const opts = parseCliArgs(argv);
  const filePath = resolveTelemetryPath(opts.path);
  if (!fs.existsSync(filePath)) {
    console.log(`quality-stats: no telemetry file at ${filePath} yet — nothing to analyze.`);
    return 0;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const { events, malformed, unsupported } = parseLines(text);
  const agg = aggregate(events, { sinceDays: opts.sinceDays, pruneDays: opts.pruneDays });
  console.log(formatReport(agg, { path: filePath, malformed, unsupported }));
  return 0;
}

function isMain() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`quality-stats: ${error.message}`);
    process.exit(2);
  }
}
