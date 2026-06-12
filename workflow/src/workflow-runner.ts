// Entry point for the workflow helper, built to workflow/dist/workflow-runner.mjs
// (single-file ESM, vendored to adopting repos as tools/workflow-runner.mjs, like
// the verify runner). This file is the IO EDGE: it owns the real fs reads, the
// process streams, and the one `process.exit`. All command logic lives in
// ./cli.ts behind the injected CliIO seam so it stays unit-testable without
// touching the filesystem or the process. Mirrors runner/src/verify-runner.ts.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.ts';
import type { CliIO } from './cli.ts';
import { realLockSeams } from './lock.ts';
import { runGit } from './trailers.ts';
import { realDoctorProbes } from './doctor.ts';

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

// Synchronous blocking sleep for the gate --wait poll loop at the edge (the same
// idiom as lock.ts's backoff sleep: Atomics.wait on a private buffer needs no
// busy-spin and is permitted on the Node main thread).
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The real IO edge: fs reads/writes, git, the process streams, the wall clock,
// the blocking sleep, and the caller identity (the cmux pane, via the
// WORKFLOW_CLAIMED_BY env the launcher sets; empty when unset).
const realIO: CliIO = {
  cwd: () => process.cwd(),
  readFile: (filePath) => readFileSync(filePath, 'utf8'),
  writeFile: (filePath, content) => {
    writeFileSync(filePath, content);
  },
  mkdir: (dirPath) => {
    mkdirSync(dirPath, { recursive: true });
  },
  runGit: (args, cwd) => runGit(args, cwd),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  now: () => Date.now(),
  sleep: sleepSync,
  claimedBy: process.env.WORKFLOW_CLAIMED_BY ?? '',
  doctorProbes: realDoctorProbes(),
  launchProcess: (launch) => {
    const result = spawnSync(launch.file, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      stdio: 'inherit',
      shell: false,
    });
    return {
      status: result.status ?? 1,
      stdout: '',
      stderr: result.error?.message ?? '',
    };
  },
};

export function main(argv: string[]): number {
  // State-mutating commands (recover) run inside the §2.10 worktree mutex; the
  // edge supplies the real lock seams (wall clock, blocking sleep, PID oracle).
  return runCli(argv, realIO, realLockSeams());
}

// Keep imports test-safe: only run (and exit) when invoked as the entrypoint.
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
