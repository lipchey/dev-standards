// The real secret-scan adapter behind the `scanPrBody: (body) => SecretScanResult` seam.
// deep-review's report path (report.ts) uses it to scan a PR body before that body is emitted.
//
// OWNER DECISION (S15): the scanner is wired by CONVENTION on the adopting repo's
// pinned gitleaks wrapper at `<root>/tools/run-gitleaks` — resolved at CALL time, so
// each invocation resolves its own repo/worktree root.
//
// Exit-code classification (Phase 5 §0, DR-12) — three honest states, no fail-open/collapse:
//   - wrapper absent or non-executable         -> `unavailable` (WAS fail-OPEN null = clean);
//   - wrapper exit 0                            -> `clean`;
//   - wrapper exit 1 (gitleaks "leaks found")  -> `hit`;
//   - anything else (spawn ENOENT / 126 / 127 / kill / timeout / any other exit code)
//                                              -> `unavailable` with a reason (WAS collapsed into
//                                                 `hit` for every non-zero status).
// `unavailable` is fail-CLOSED upstream: report.ts refuses to emit a report it could not scan.
// Only an affirmative `clean` lets content through; only `hit` names an actual leak.
//
// Spawn convention: a default real spawnSync wrapper with shell:false and a FIXED
// argv, injectable for tests, with a bounded timeout (the 30s cap, tightened to the run
// deadline's remaining budget when one is threaded in).

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Deadline } from './deadline.ts';
// SecretScanResult (§0) is declared as a serialization boundary in types.ts (the producer here and
// the consumers in report.ts/W4 agree on ONE shape); re-exported so callers can keep importing it
// from the producer module.
import type { SecretScanResult } from './types.ts';
export type { SecretScanResult };

// Bounded wrapper timeout. The scanned content is small (a PR body / an archive
// entry), so 30s is generous headroom.
const DEFAULT_TIMEOUT_MS = 30_000;

// Bound the redacted output tail folded into a hit description. gitleaks runs with
// --redact, so secret VALUES are masked by the wrapper before any of its output
// reaches this tail.
const OUTPUT_TAIL_MAX = 2000;

// CONVENTION path of the adopting repo's pinned gitleaks wrapper, under the repo /
// worktree root. This is the SOLE wiring channel for the scanner (owner decision).
export const SCANNER_REL = 'tools/run-gitleaks';

// CONVENTION path of an adopting repo's custom gitleaks config, at the repo /
// worktree root. gitleaks' `stdin` subcommand does NOT auto-discover a cwd
// `.gitleaks.toml`, so we must pass it explicitly (see GITLEAKS_ARGS below).
export const GITLEAKS_CONFIG_REL = '.gitleaks.toml';

// The base argv handed to the wrapper when NO repo config is present. `stdin`
// makes gitleaks read the candidate content from stdin; `--no-banner` keeps its
// stderr to findings only; `--redact` masks any matched secret value in the
// wrapper's own output. Fixed, non-body argv + shell:false + content-on-stdin
// means no operand ever reaches a shell or an option slot (no injection surface).
export const GITLEAKS_ARGS: readonly string[] = ['stdin', '--no-banner', '--redact'];

// Build the argv for a scan, optionally threading an absolute config path.
// gitleaks `stdin` does NOT load a cwd `.gitleaks.toml` on its own, so an adopting
// repo's custom rules (e.g. the pilot's anthropic/openai/deepseek/openclaw token
// rules) would be MISSED without an explicit `-c`. `-c` is a standard gitleaks
// GLOBAL flag, valid for the stdin subcommand. The config path is still an
// absolute, NON-body operand resolved from fs presence — never from scanned
// content — so the no-injection property is preserved. NOTE: the exact
// real-gitleaks end-to-end behaviour (custom rules actually applied to stdin) is
// validated by the pilot smoke at S15b; here we pin the argv shape + cwd.
export function gitleaksArgs(configPath: string | null): string[] {
  return configPath === null
    ? [...GITLEAKS_ARGS]
    : ['stdin', '-c', configPath, '--no-banner', '--redact'];
}

export interface SecretScanSpawnOptions {
  shell: false;
  encoding: 'utf8';
  timeout: number;
  input: string; // the candidate content, handed to the wrapper on stdin
  cwd: string; // the resolved root, for deterministic gitleaks config resolution
}

export interface SecretScanSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type SecretScanSpawn = (
  file: string,
  args: string[],
  options: SecretScanSpawnOptions,
) => SecretScanSpawnResult;

export interface SecretScannerDeps {
  // The wrapper spawner (default a real spawnSync wrapper, shell:false).
  spawn?: SecretScanSpawn;
  // The root resolver, read at CALL time so the wrapper is resolved relative to
  // wherever the command runs. Defaults to process.cwd (the edge convention).
  cwd?: () => string;
  // Presence + mode probes for the wrapper file (default fs.existsSync / fs.statSync).
  fileExists?: (filePath: string) => boolean;
  statMode?: (filePath: string) => number | null;
  timeoutMs?: number;
  // The run deadline (§0), when threaded in: the spawn timeout is tightened to
  // `min(timeoutMs cap, deadline.remainingMs())`, and an already-spent budget short-circuits to
  // `unavailable` with no spawn. Omitted -> the fixed cap applies (the review-only path).
  deadline?: Deadline;
}

export interface ScannerResolution {
  path: string; // <root>/tools/run-gitleaks
  present: boolean; // the wrapper file exists
  executable: boolean; // its stat mode has any execute bit set (mode & 0o111)
}

// Resolves the convention wrapper under `root` and reports presence + executability.
// Used by the runtime scanner to decide no-op vs. run.
export function resolveScanner(
  root: string,
  deps: { fileExists: (p: string) => boolean; statMode: (p: string) => number | null },
): ScannerResolution {
  const scannerPath = path.join(root, SCANNER_REL);
  const present = deps.fileExists(scannerPath);
  const mode = present ? deps.statMode(scannerPath) : null;
  return { path: scannerPath, present, executable: mode !== null && (mode & 0o111) !== 0 };
}

function defaultStatMode(filePath: string): number | null {
  try {
    return statSync(filePath).mode;
  } catch {
    return null;
  }
}

// The real-edge resolution (fs.existsSync + fs.statSync): whether the scanner will
// actually run against a given root.
export function realScannerResolution(root: string): ScannerResolution {
  return resolveScanner(root, { fileExists: (p) => existsSync(p), statMode: defaultStatMode });
}

function realSecretScanSpawn(
  file: string,
  args: string[],
  options: SecretScanSpawnOptions,
): SecretScanSpawnResult {
  const result = spawnSync(file, args, options);
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_MAX ? trimmed.slice(-OUTPUT_TAIL_MAX) : trimmed;
}

// Builds the seam closure `(body) => SecretScanResult`. Resolution happens at CALL time; deps are
// injectable for tests.
export function createSecretScanner(deps: SecretScannerDeps = {}): (body: string) => SecretScanResult {
  const spawn = deps.spawn ?? realSecretScanSpawn;
  const cwd = deps.cwd ?? (() => process.cwd());
  const cap = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = deps.deadline;
  // Hold the fs probes as one resolved deps object instead of unpacking then
  // re-packing them at each call site (behavior-preserving tidy, FIX 4).
  const fsDeps = {
    fileExists: deps.fileExists ?? ((p: string) => existsSync(p)),
    statMode: deps.statMode ?? defaultStatMode,
  };

  return (body: string): SecretScanResult => {
    const root = cwd();
    const resolution = resolveScanner(root, fsDeps);
    // No wrapper wired, or a present-but-non-executable file: the scan cannot run, so the
    // verdict is `unavailable` (fail-CLOSED) — NOT the old fail-open "clean".
    if (!resolution.present || !resolution.executable) {
      return {
        status: 'unavailable',
        reason: `gitleaks wrapper ${resolution.present ? 'is not executable' : 'not found'} at ${resolution.path}`,
      };
    }

    // Tighten the spawn timeout to the run deadline when one is threaded in; a spent budget
    // short-circuits to `unavailable` with no spawn (a positive timeout is required — spawnSync
    // treats 0 as "no timeout").
    if (deadline !== undefined && deadline.remainingMs() <= 0) {
      return { status: 'unavailable', reason: 'deadline exceeded before secret scan' };
    }
    const timeout = deadline === undefined ? cap : Math.min(cap, deadline.remainingMs());

    // FIX 3: spawn at `cwd: root` and, if the adopting repo ships a custom
    // `<root>/.gitleaks.toml`, pass it explicitly via `-c` so its rules apply to
    // stdin scanning (gitleaks stdin does not auto-discover a cwd config).
    const configPath = path.join(root, GITLEAKS_CONFIG_REL);
    const configArg = fsDeps.fileExists(configPath) ? configPath : null;

    const result = spawn(resolution.path, gitleaksArgs(configArg), {
      shell: false,
      encoding: 'utf8',
      timeout,
      input: body,
      cwd: root,
    });

    // A spawn fault (ENOENT / timeout / EACCES) means the scan never produced a verdict:
    // `unavailable`, never a hit.
    if (result.error !== undefined) {
      return { status: 'unavailable', reason: `secret scan could not run: ${result.error.message}` };
    }
    // exit 0 = clean; exit 1 = the ONLY hit signal (gitleaks "leaks found"). A null status (signal
    // kill) or ANY other exit code (2 / 126 / 127 / version-mismatch / missing binary) is
    // operational -> `unavailable`, no longer silently treated as a hit.
    if (result.status === 0) return { status: 'clean' };
    if (result.status === 1) {
      const detail = tail(result.stderr) || tail(result.stdout);
      return { status: 'hit', findings: detail === '' ? 'gitleaks reported a leak (exit 1)' : detail };
    }
    const detail = tail(result.stderr) || tail(result.stdout);
    const code = result.status === null ? 'killed (no exit code)' : `exit ${result.status}`;
    return {
      status: 'unavailable',
      reason: `secret scan did not produce a verdict (${code})${detail === '' ? '' : `: ${detail}`}`,
    };
  };
}
