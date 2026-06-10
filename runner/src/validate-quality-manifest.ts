import { pathToFileURL } from 'node:url';
import { loadManifest } from './manifest.ts';
import type { ManifestLoadResult } from './manifest.ts';
import {
  EXIT_MANIFEST,
  EXIT_USAGE,
  formatErrorLine,
  parseManifestArg,
  type CliResult,
} from './manifest-cli.ts';

/**
 * Validates one quality manifest and returns the captured CLI outcome.
 *
 * Contract (frozen): malformed argv → usage on stderr, exit 2; an unreadable or
 * invalid manifest → every validation error on stderr, exit 1; a valid manifest
 * → the `valid quality manifest` success line on stdout, exit 0. The success
 * phrase is asserted by a later `standards-sync --check`, so keep it verbatim.
 *
 * Returning a `CliResult` (rather than writing to `process`) keeps this pure and
 * unit-testable; the entrypoint guard below flushes the streams and exits.
 */
export function run(argv: string[]): CliResult {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const parsed = parseManifestArg(argv);
  if (!parsed.ok) {
    stderr.push(parsed.message);
    return { code: EXIT_USAGE, stdout, stderr };
  }

  // `loadManifest` lets filesystem faults (e.g. a missing manifest) throw; wrap
  // it so a missing/unreadable manifest is a clean exit-1, not a stack trace.
  let load: ManifestLoadResult;
  try {
    load = loadManifest(parsed.manifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    stderr.push(`could not read manifest at "${parsed.manifestPath}": ${detail}`);
    return { code: EXIT_MANIFEST, stdout, stderr };
  }

  if (!load.ok) {
    for (const err of load.errors) stderr.push(formatErrorLine(err));
    return { code: EXIT_MANIFEST, stdout, stderr };
  }

  stdout.push(`valid quality manifest (schema version ${load.manifest.version}): ${load.manifest.repo}`);
  return { code: 0, stdout, stderr };
}

// Run the CLI only when this module is the process entrypoint, not when a test
// imports `run`. This seam keeps `run` exitless and capturable.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = run(process.argv.slice(2));
  for (const line of result.stdout) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.exit(result.code);
}
