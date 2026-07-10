import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckResult } from './types.ts';

/* Effectiveness telemetry: one append-only JSONL line per verify run, home-dir sunk
   and fail-open (see docs/effectiveness-plan.md §1/§2). Deliberately simpler than
   report.ts's confined atomic write — the sink is a single trusted home-dir file, so
   there is no repo-controlled path to confine, only a directory to provision. */

export interface RunEvent {
  v: 1;
  startedAt: string;
  finishedAt: string;
  repo: string;
  scope: string;
  branch: string | null;
  head_sha: string | null;
  exit: number | null;
  aborted: boolean;
  results: CheckResult[];
}

// env-provided free text (DS_BYPASS_REASON, spawn errno) is length-capped in the event copy.
const REASON_MAX = 200;
const GIT_TIMEOUT_MS = 2000;

/* DS_TELEMETRY_PATH: unset (or empty) → default home-dir sink; the literal "off" →
   disabled (null); anything else → that exact path. */
export function resolveSinkPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.DS_TELEMETRY_PATH;
  if (configured === 'off') return null;
  if (configured === undefined || configured === '') {
    return path.join(os.homedir(), '.local', 'share', 'dev-standards', 'events.jsonl');
  }
  return configured;
}

/* Build the event, copying each result with an over-length reason truncated. The copy is
   shallow-fresh only for truncated results, so the caller's results array is never mutated
   (report.ts still persists the full reason). */
export function buildRunEvent(fields: Omit<RunEvent, 'v'>): RunEvent {
  const results = fields.results.map((r) =>
    r.reason !== undefined && r.reason.length > REASON_MAX
      ? { ...r, reason: r.reason.slice(0, REASON_MAX) }
      : r,
  );
  return { v: 1, ...fields, results };
}

/* Append one JSON line, provisioning the parent directory first: appendFileSync creates no
   parents, so a fail-open sink without provisioning = permanent silent data loss on a fresh
   machine. Fail-open: any error → one stderr warning, never throws, never affects the run. */
export function appendRunEvent(event: RunEvent, env: NodeJS.ProcessEnv = process.env): void {
  const sinkPath = resolveSinkPath(env);
  if (sinkPath === null) return; // telemetry disabled
  try {
    fs.mkdirSync(path.dirname(sinkPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(sinkPath, JSON.stringify(event) + '\n', { mode: 0o600, flag: 'a' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warning: telemetry write to ${sinkPath} failed: ${detail}\n`);
  }
}

/* Best-effort git identity for the run. Any failure (non-git dir, detached HEAD, missing git,
   timeout) → nulls; never throws, never meaningfully delays the run. ONE spawn with a single
   2s cap (worst case now +2s, typical ~10ms), not two serial probes: `rev-parse` processes
   its args left-to-right, so `HEAD --abbrev-ref HEAD` prints the full sha on line 1 and the
   branch abbrev on line 2. A detached head prints the literal "HEAD" as line 2 → branch null;
   any failure or short (< 2 line) output → both null. */
export function gitContext(cwd: string): { branch: string | null; head_sha: string | null } {
  const out = gitProbe(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], cwd);
  if (out === null) return { branch: null, head_sha: null };
  const lines = out.split('\n');
  const sha = lines[0];
  const branch = lines[1];
  if (!sha || !branch) return { branch: null, head_sha: null };
  return { branch: branch === 'HEAD' ? null : branch, head_sha: sha };
}

function gitProbe(args: string[], cwd: string): string | null {
  try {
    const result = spawnSync('git', args, {
      cwd,
      shell: false,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return null;
    const out = (result.stdout ?? '').trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
