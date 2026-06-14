// Entry point for the deep-review engine, built to deep-review/dist/
// deep-review-runner.mjs (single-file ESM, S22) and invoked only by the
// `deep-review-refactor` skill. This file is the IO EDGE: it owns the real
// process streams and the one `process.exit`. All command logic lives in ./cli.ts
// behind the injected CliDeps seam so it stays unit-testable without touching the
// process. Mirrors workflow/src/workflow-runner.ts.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.ts';
import type { CliDeps } from './cli.ts';

// Node realpaths import.meta.url under symlinks; realpath both sides for the
// entrypoint check (the idiom from workflow/runner; inlined to keep the bundle
// self-contained, with no cross-module dependency).
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

// The real IO edge: the process streams.
const realDeps: CliDeps = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export function main(argv: string[]): number {
  return runCli(argv, realDeps);
}

// Keep imports test-safe: only run (and exit) when invoked as the entrypoint.
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
