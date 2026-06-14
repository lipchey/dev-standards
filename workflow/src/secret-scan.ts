// The real secret-scan adapter behind the frozen `scanPrBody: (body) => string | null`
// seam (null = clean, non-null = a hit description). ship aborts on a hit; cleanup
// SKIPS the archive on a hit but proceeds.
//
// OWNER DECISION (S15): the scanner is wired by CONVENTION on the adopting repo's
// pinned gitleaks wrapper at `<root>/tools/run-gitleaks` — NOT via the §2.8 workflow
// config (frozen) and NOT via an env var. The wrapper is resolved at CALL time, so a
// `ship` running in a feature worktree and a `cleanup` running at the main repo root
// each resolve their own root. Where no wrapper exists (dev-standards itself, every
// fixture repo) the scanner is a NO-OP — this is NOT a silent gap: `workflow doctor`
// FAILS loudly (CHECK_SECRET_SCANNER) when the workflow is ENABLED but no wrapper
// resolves.
//
// Spawn convention mirrors gh.ts / cmux-adapter.ts: a default real spawnSync wrapper
// with shell:false and a FIXED argv, injectable for tests, with a bounded timeout.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// Bounded wrapper timeout (mirror gh.ts DEFAULT_TIMEOUT_MS). The scanned content is
// small (a PR body / an archive entry), so 30s is generous headroom.
const DEFAULT_TIMEOUT_MS = 30_000;

// Bound the redacted output tail folded into a hit description (mirror gh.ts
// STDERR_TAIL_MAX). gitleaks runs with --redact, so secret VALUES are masked by the
// wrapper before any of its output reaches this tail.
const OUTPUT_TAIL_MAX = 2000;

// CONVENTION path of the adopting repo's pinned gitleaks wrapper, under the repo /
// worktree root. This is the SOLE wiring channel for the scanner (owner decision).
export const SCANNER_REL = 'tools/run-gitleaks';

// The FIXED argv handed to the wrapper. `stdin` makes gitleaks read the candidate
// content from stdin; `--no-banner` keeps its stderr to findings only; `--redact`
// masks any matched secret value in the wrapper's own output. Fixed argv + shell:false
// + content-on-stdin means no operand ever reaches a shell or an option slot (no
// injection surface), exactly like gh.ts / cmux-adapter.ts.
export const GITLEAKS_ARGS: readonly string[] = ['stdin', '--no-banner', '--redact'];

export interface SecretScanSpawnOptions {
  shell: false;
  encoding: 'utf8';
  timeout: number;
  input: string; // the candidate content, handed to the wrapper on stdin
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
}

export interface ScannerResolution {
  path: string; // <root>/tools/run-gitleaks
  present: boolean; // the wrapper file exists
  executable: boolean; // its stat mode has any execute bit set (mode & 0o111)
}

// Resolves the convention wrapper under `root` and reports presence + executability.
// Shared by the runtime scanner (decides no-op vs. run) AND the doctor probe (decides
// PASS vs. loud FAIL) so the two can never drift.
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

// The real-edge resolution (fs.existsSync + fs.statSync). doctor's real probe reuses
// this so "doctor says the scanner resolves" === "the scanner will actually run".
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

// Builds the frozen seam closure `(body) => string | null`. Resolution happens at
// CALL time; deps are injectable for tests.
export function createSecretScanner(deps: SecretScannerDeps = {}): (body: string) => string | null {
  const spawn = deps.spawn ?? realSecretScanSpawn;
  const cwd = deps.cwd ?? (() => process.cwd());
  const fileExists = deps.fileExists ?? ((p) => existsSync(p));
  const statMode = deps.statMode ?? defaultStatMode;
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (body: string): string | null => {
    const resolution = resolveScanner(cwd(), { fileExists, statMode });
    // No wrapper wired (dev-standards / every fixture repo), or a present-but-non-
    // executable file: resolve to a NO-OP. The doctor CHECK_SECRET_SCANNER probe makes
    // this state LOUD whenever the workflow is ENABLED, so it is never a silent gap.
    if (!resolution.present || !resolution.executable) return null;

    const result = spawn(resolution.path, [...GITLEAKS_ARGS], {
      shell: false,
      encoding: 'utf8',
      timeout,
      input: body,
    });

    // FAIL-CLOSED interpretation: only a clean exit 0 is a "pass" (null). A spawn
    // error (ENOENT / timeout) OR any non-zero status is treated as a HIT. The pinned
    // wrapper itself exits non-zero on version-mismatch / missing-binary as well as on
    // a real finding, so "every non-zero == hit" is deliberate — blocking a ship (and
    // skipping an archive) is the safe default; only an affirmative clean signal lets
    // content through.
    if (result.error !== undefined) {
      return `secret scan could not run (fail-closed): ${result.error.message}`;
    }
    if (result.status !== 0) {
      const detail = tail(result.stderr) || tail(result.stdout);
      return `gitleaks flagged the PR content (exit ${result.status})${detail === '' ? '' : `: ${detail}`}`;
    }
    return null;
  };
}
