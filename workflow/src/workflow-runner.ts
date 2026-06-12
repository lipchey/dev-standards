// Entry point for the workflow helper, built to workflow/dist/workflow-runner.mjs
// (single-file ESM, vendored to adopting repos as tools/workflow-runner.mjs, like
// the verify runner). This file is the IO EDGE: it owns the real fs reads, the
// process streams, and the one `process.exit`. All command logic lives in
// ./cli.ts behind the injected CliIO seam so it stays unit-testable without
// touching the filesystem or the process. Mirrors runner/src/verify-runner.ts.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.ts';
import type { CliIO } from './cli.ts';

// Node realpaths import.meta.url under symlinks; realpath both sides for the
// entrypoint check (the idiom from runner/src/manifest-cli.ts; inlined to keep
// the workflow bundle self-contained, with no cross-module dependency).
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

// The real IO edge: fs reads + the process streams.
const realIO: CliIO = {
  cwd: () => process.cwd(),
  readFile: (filePath) => readFileSync(filePath, 'utf8'),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export function main(argv: string[]): number {
  return runCli(argv, realIO);
}

// Keep imports test-safe: only run (and exit) when invoked as the entrypoint.
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
