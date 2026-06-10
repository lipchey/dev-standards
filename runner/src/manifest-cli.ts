import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ValidationError } from './types.ts';

/**
 * Reports whether the module identified by `metaUrl` (pass `import.meta.url`) is
 * the process entrypoint, so a CLI runs only when executed directly and stays
 * inert when a test imports it.
 *
 * The naive guard `metaUrl === pathToFileURL(process.argv[1]).href` is unsafe
 * under symlinks: Node realpath-resolves `import.meta.url` but not
 * `process.argv[1]`, so on macOS temp dirs (`/var` -> `/private/var`) or any
 * symlinked checkout the two never match and the CLI silently exports-only,
 * exiting 0 without doing its work. We therefore realpath BOTH sides before
 * comparing. `realpathSync` can throw (e.g. argv path vanished between launch
 * and import); we fall back to the literal comparison so this can never throw at
 * import time. Returns false when there is no `process.argv[1]` at all.
 */
export function isMainModule(metaUrl: string): boolean {
  const argvPath = process.argv[1];
  if (argvPath === undefined) return false;

  const metaPath = fileURLToPath(metaUrl);
  try {
    return realpathSync(argvPath) === realpathSync(metaPath);
  } catch {
    return argvPath === metaPath;
  }
}

/** Exit code for CLI/usage faults (bad args). */
export const EXIT_USAGE = 2;
/** Exit code for a manifest that cannot be read or fails validation. */
export const EXIT_MANIFEST = 1;

/**
 * The captured outcome of one CLI invocation: the process exit code plus the
 * lines each stream would have received. Returning lines instead of writing to
 * `process` directly keeps the `run` functions pure and unit-testable; the real
 * entrypoint flushes them and exits at a single call site.
 */
export interface CliResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

/** A parsed `--manifest <path>`-only invocation for the validate/migrate CLIs. */
export type ManifestArg =
  | { ok: true; manifestPath: string }
  | { ok: false; message: string };

/**
 * Parses the argument vector shared by the validate and migrate CLIs.
 *
 * The only accepted shape is exactly one `--manifest <path>`. A missing flag, a
 * `--manifest` without a value, a duplicate `--manifest`, and any other token
 * (unknown flag or stray positional) are all usage faults. This never exits the
 * process; the caller maps the message to `EXIT_USAGE`.
 */
export function parseManifestArg(argv: string[]): ManifestArg {
  let manifestPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue; // satisfies noUncheckedIndexedAccess; not reachable in practice

    if (arg === '--manifest') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: 'usage: --manifest <path> (missing value for --manifest)' };
      }
      if (manifestPath !== undefined) {
        return { ok: false, message: 'usage: --manifest <path> (--manifest may be given only once)' };
      }
      manifestPath = value;
      i += 1; // consume the path token
      continue;
    }

    return { ok: false, message: `usage: --manifest <path> (unexpected argument: ${arg})` };
  }

  if (manifestPath === undefined) {
    return { ok: false, message: 'usage: --manifest <path> (missing required --manifest <path>)' };
  }
  return { ok: true, manifestPath };
}

/**
 * One stderr line for a validation error, shared by every manifest CLI so their
 * error output is identical. A root-level error (empty `path`) is labelled
 * `(root)`; otherwise the dotted path leads the line.
 */
export function formatErrorLine(error: ValidationError): string {
  const where = error.path === '' ? '(root)' : error.path;
  return `${where}: ${error.message}`;
}
