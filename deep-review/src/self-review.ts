import { spawnSync } from 'node:child_process';
import { EXIT_FAILURE, EXIT_OK, EXIT_WRONG_STATE } from './types.ts';
import type { FindingsFileV2, MachineError, SelfReviewRecord } from './types.ts';
import { mutateFindings, readFindings } from './findings-io.ts';
import { nonToolingDirtyPaths } from './worktree.ts';
import type { DeepReviewContext } from './descriptor.ts';
import type { Deadline } from './deadline.ts';

const STDERR_TAIL_MAX = 2000;

export interface SelfReviewInput {
  verdict: SelfReviewRecord['verdict'];
  note?: string;
}

export interface SelfReviewDeps {
  cwd: string;
  findingsPath: string;
  deadline: Deadline;
  readHead: (cwd: string, deadline: Deadline) => string;
  /* `git status --porcelain` of the worktree; the capture gate refuses on non-tooling dirt. */
  getStatus: (cwd: string, deadline: Deadline) => string;
  readFindings: (path: string) => FindingsFileV2;
  mutate: (
    path: string,
    fn: (file: FindingsFileV2) => FindingsFileV2,
    expectedRevision?: number,
  ) => FindingsFileV2;
  now: () => string;
}

export interface SelfReviewResult {
  exitCode: number;
  machineError?: MachineError;
}

/* Wraps any fixed-argv git read (rev-parse HEAD / status) so the CLI can surface the exact
   failing command and a bounded stderr tail. */
class GitReadError extends Error {
  readonly command: string;
  readonly stderr: string;

  constructor(command: string, message: string, stderr: string) {
    super(message);
    this.name = 'GitReadError';
    this.command = command;
    this.stderr = stderr;
    Object.setPrototypeOf(this, GitReadError.prototype);
  }
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

function runGit(command: string, args: string[], cwd: string, deadline: Deadline): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: Math.max(1, deadline.remainingMs()),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    throw new GitReadError(command, `${command} failed: ${message}`, message);
  }
  if (result.status !== 0) {
    throw new GitReadError(
      command,
      `${command} failed (status ${result.status}): ${(result.stderr ?? '').trim()}`,
      result.stderr ?? '',
    );
  }
  return result.stdout ?? '';
}

function realReadHead(cwd: string, deadline: Deadline): string {
  const sha = runGit('git rev-parse HEAD', ['rev-parse', 'HEAD'], cwd, deadline).trim();
  if (sha === '') throw new GitReadError('git rev-parse HEAD', 'git rev-parse HEAD returned no sha', '');
  return sha;
}

function realGetStatus(cwd: string, deadline: Deadline): string {
  return runGit('git status --porcelain', ['status', '--porcelain'], cwd, deadline);
}

export function realSelfReviewDeps(
  cwd: string,
  findingsPath: string,
  ctx: DeepReviewContext,
): SelfReviewDeps {
  return {
    cwd,
    findingsPath,
    deadline: ctx.deadline,
    readHead: realReadHead,
    getStatus: realGetStatus,
    readFindings: (path) => readFindings(path),
    mutate: (path, fn, expectedRevision) =>
      mutateFindings(
        path,
        { reportsRootAbs: ctx.reportsRootAbs },
        fn,
        undefined,
        expectedRevision,
      ),
    now: () => new Date().toISOString(),
  };
}

function gitReadFailure(error: unknown): SelfReviewResult {
  return {
    exitCode: EXIT_FAILURE,
    machineError: {
      command: error instanceof GitReadError ? error.command : 'git',
      step: 'self-review',
      message: error instanceof Error ? error.message : String(error),
      stderr_tail: error instanceof GitReadError ? tailOf(error.stderr) : '',
    },
  };
}

export function runSelfReview(
  input: SelfReviewInput,
  deps: SelfReviewDeps,
): SelfReviewResult {
  const baseRevision = deps.readFindings(deps.findingsPath).revision;
  let head: string;
  let status: string;
  try {
    head = deps.readHead(deps.cwd, deps.deadline);
    status = deps.getStatus(deps.cwd, deps.deadline);
  } catch (error) {
    return gitReadFailure(error);
  }
  /* A verdict binds only to HEAD, so a stamp taken over a dirty tree would attest changes
     that never land (review dirty -> record clean -> discard -> handoff sees clean==HEAD).
     Refuse non-tooling dirt at capture; handoff re-checks dirt + sha as the backstop. */
  const dirty = nonToolingDirtyPaths(status);
  if (dirty.length > 0) {
    return {
      exitCode: EXIT_WRONG_STATE,
      machineError: {
        command: 'git status --porcelain',
        step: 'self-review',
        message: `worktree has uncommitted non-tooling changes (${dirty.length}); commit or discard the fix before recording a self-review verdict`,
        stderr_tail: '',
      },
    };
  }
  const baseRecord = {
    sha: head,
    verdict: input.verdict,
    noted_at: deps.now(),
  };
  const self_review: SelfReviewRecord =
    input.note === undefined ? baseRecord : { ...baseRecord, note: input.note };
  deps.mutate(
    deps.findingsPath,
    (file) => ({ ...file, self_review }),
    baseRevision,
  );
  return { exitCode: EXIT_OK };
}
