import { loadManifest } from './manifest.ts';
import type { ManifestLoadResult } from './manifest.ts';
import {
  EXIT_MANIFEST,
  EXIT_USAGE,
  formatErrorLine,
  isMainModule,
  parseManifestArg,
  type CliResult,
} from './manifest-cli.ts';

// Frozen CLI contract: usage -> 2, unreadable/invalid manifest -> 1, valid -> 0.
export function run(argv: string[]): CliResult {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const parsed = parseManifestArg(argv);
  if (!parsed.ok) {
    stderr.push(parsed.message);
    return { code: EXIT_USAGE, stdout, stderr };
  }

  // Convert filesystem faults to clean CLI errors, not stack traces.
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

// Keep run() import-safe for tests.
if (isMainModule(import.meta.url)) {
  const result = run(process.argv.slice(2));
  for (const line of result.stdout) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.exit(result.code);
}
