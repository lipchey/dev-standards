import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ValidationError } from './types.ts';

// Node realpaths import.meta.url under symlinks; realpath both sides for entrypoint checks.
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

export const EXIT_USAGE = 2;
export const EXIT_MANIFEST = 1;

export interface CliResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

export type ManifestArg =
  | { ok: true; manifestPath: string }
  | { ok: false; message: string };

// Shared validate/migrate parser: exactly one --manifest <path>.
export function parseManifestArg(argv: string[]): ManifestArg {
  let manifestPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--manifest') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: 'usage: --manifest <path> (missing value for --manifest)' };
      }
      if (manifestPath !== undefined) {
        return { ok: false, message: 'usage: --manifest <path> (--manifest may be given only once)' };
      }
      manifestPath = value;
      i += 1;
      continue;
    }

    return { ok: false, message: `usage: --manifest <path> (unexpected argument: ${arg})` };
  }

  if (manifestPath === undefined) {
    return { ok: false, message: 'usage: --manifest <path> (missing required --manifest <path>)' };
  }
  return { ok: true, manifestPath };
}

export function formatErrorLine(error: ValidationError): string {
  const where = error.path === '' ? '(root)' : error.path;
  return `${where}: ${error.message}`;
}
