// The real secret-scan adapter behind the frozen `scanPrBody: (body) => string | null`
// seam (null = clean, non-null = a hit description). deep-review's report path
// (report.ts) uses it to scan a PR body before that body is emitted.
//
// OWNER DECISION (S15): the scanner is wired by CONVENTION on the adopting repo's
// pinned gitleaks wrapper at `<root>/tools/run-gitleaks` — resolved at CALL time, so
// each invocation resolves its own repo/worktree root. Where no wrapper exists
// (dev-standards itself, every fixture repo) the scanner resolves to a NO-OP —
// treated as clean. There is no doctor probe in deep-review; a missing wrapper is
// simply a silent no-op-clean.
//
// Spawn convention: a default real spawnSync wrapper with shell:false and a FIXED
// argv, injectable for tests, with a bounded timeout.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

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

// Builds the frozen seam closure `(body) => string | null`. Resolution happens at
// CALL time; deps are injectable for tests.
export function createSecretScanner(deps: SecretScannerDeps = {}): (body: string) => string | null {
  const spawn = deps.spawn ?? realSecretScanSpawn;
  const cwd = deps.cwd ?? (() => process.cwd());
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Hold the fs probes as one resolved deps object instead of unpacking then
  // re-packing them at each call site (behavior-preserving tidy, FIX 4).
  const fsDeps = {
    fileExists: deps.fileExists ?? ((p: string) => existsSync(p)),
    statMode: deps.statMode ?? defaultStatMode,
  };

  return (body: string): string | null => {
    const root = cwd();
    const resolution = resolveScanner(root, fsDeps);
    // No wrapper wired (dev-standards / every fixture repo), or a present-but-non-
    // executable file: resolve to a NO-OP (treated as clean).
    if (!resolution.present || !resolution.executable) return null;

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
