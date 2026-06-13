import { spawnSync } from 'node:child_process';
import type { MachineReadableError } from './trailers.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_TAIL_MAX = 2000;
const LIST_FIELDS = 'number,url,state,mergedAt,headRefName,headRefOid';
const VIEW_FIELDS = 'number,url,state,mergedAt,headRefName,headRefOid,isDraft,mergeable';
const REPO_FIELDS = 'owner,name';

// The per-connection page size of REVIEW_DATA_QUERY. The query does NOT paginate,
// so this is a HARD cap: at most this many reviews / review threads / comments-
// per-thread are fetched. `prReviewData` flags truncation (via `pageInfo` and the
// returned node counts) so a PR beyond the cap is WARNed, never silently dropped.
export const REVIEW_PAGE_LIMIT = 100;

// The single GraphQL query that fetches, in one round-trip: the submitted reviews
// (for the §2.5 verdict/submitted_at/review_id), the PR `mergeable` state (§2.5
// pr_mergeable — folded in here so no extra `pr view` REST call is needed), and the
// review threads with their comments (per-thread `resolved` + `thread_id` and each
// comment). Each connection is capped at REVIEW_PAGE_LIMIT with NO pagination:
// `reviews(last:N)` keeps the most recent reviews (the latest submitted verdict is
// always among them), while `reviewThreads`/`comments` also select
// `pageInfo{hasNextPage}` so `prReviewData` can flag a >cap PR for a WARNing rather
// than silently dropping reviewer feedback. owner/name/number are passed as typed
// GraphQL VARIABLES (`-f`/`-F`), never string-concatenated into the query or argv,
// so no operand reaches a query-injection or shell-injection surface.
export const REVIEW_DATA_QUERY = [
  'query($owner:String!,$name:String!,$number:Int!){',
  'repository(owner:$owner,name:$name){',
  'pullRequest(number:$number){',
  `mergeable reviews(last:${REVIEW_PAGE_LIMIT}){nodes{databaseId state submittedAt}}`,
  `reviewThreads(first:${REVIEW_PAGE_LIMIT}){pageInfo{hasNextPage}nodes{id isResolved comments(first:${REVIEW_PAGE_LIMIT}){pageInfo{hasNextPage}nodes{databaseId path line body replyTo{databaseId}}}}}`,
  '}}}',
].join('');

export interface GhSpawnOptions {
  shell: false;
  encoding: 'utf8';
  timeout: number;
}

export interface GhSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type GhSpawn = (file: string, args: string[], options: GhSpawnOptions) => GhSpawnResult;

export interface GhPrView {
  number?: number;
  url?: string;
  state?: string;
  mergedAt?: string | null;
  headRefName?: string;
  headRefOid?: string;
  isDraft?: boolean;
  mergeable?: string | boolean | null;
}

export interface GhCreatePrOptions {
  base: string;
  head: string;
  title: string;
  bodyFile: string;
}

export interface GhCreatePrResult {
  url: string;
}

export interface GhCheckRun {
  name?: string;
  state?: string;
  bucket?: string;
  conclusion?: string;
}

export interface GhRepoInfo {
  owner: string;
  name: string;
}

export interface GhReviewNode {
  databaseId?: number;
  state?: string;
  submittedAt?: string | null;
}

export interface GhReviewCommentNode {
  databaseId?: number;
  path?: string;
  line?: number | null;
  body?: string;
  replyTo?: { databaseId?: number } | null;
}

export interface GhReviewThreadNode {
  id?: string;
  isResolved?: boolean;
  comments?: { nodes?: GhReviewCommentNode[]; pageInfo?: { hasNextPage?: boolean } };
}

export interface GhReviewData {
  reviews: GhReviewNode[];
  threads: GhReviewThreadNode[];
  // §2.5 pr_mergeable source (MergeableState enum string / null), folded into the
  // same GraphQL node so fetch-review needs no separate `pr view` round-trip.
  mergeable: string | boolean | null;
  // Honest truncation signal: true when the connection hit REVIEW_PAGE_LIMIT (its
  // `pageInfo.hasNextPage` was true, or it returned a full page). The caller WARNs
  // so a >cap thread/comment PR is never silently under-reported. Reviews are not
  // flagged: `reviews(last:N)` always retains the latest submitted verdict, which
  // is all §2.5 reads from them.
  truncated: { threads: boolean; comments: boolean };
}

export interface GhAdapter {
  findPrByHead: (head: string, step?: string) => GhPrView | null;
  viewPr: (pr: number, step?: string) => GhPrView;
  createPr: (opts: GhCreatePrOptions, step?: string) => GhCreatePrResult;
  editPrBody: (pr: number, bodyFile: string, step?: string) => void;
  watchChecks: (pr: number, step?: string) => GhCheckRun[];
  deleteLocalBranchArgs: (branch: string, base?: string) => string[];
  repoInfo: (step?: string) => GhRepoInfo;
  prReviewData: (owner: string, name: string, pr: number, step?: string) => GhReviewData;
}

export interface GhAdapterDeps {
  binary?: string;
  spawn?: GhSpawn;
  timeoutMs?: number;
}

export class GhError extends Error {
  readonly kind = 'gh-error' as const;
  readonly command: string;
  readonly stderr_tail: string;
  step?: string;

  constructor(command: string, stderrTail: string, message: string, step?: string) {
    super(message);
    this.name = 'GhError';
    this.command = command;
    this.stderr_tail = stderrTail;
    if (step !== undefined) this.step = step;
    Object.setPrototypeOf(this, GhError.prototype);
  }
}

export function machineReadableGhError(error: GhError): { error: MachineReadableError } {
  const payload: MachineReadableError = error.step === undefined
    ? { command: error.command, message: error.message, stderr_tail: error.stderr_tail }
    : { command: error.command, step: error.step, message: error.message, stderr_tail: error.stderr_tail };
  return { error: payload };
}

// The shared `GhError` predicate (its home, next to GhError/machineReadableGhError).
// Cross-realm-safe: a bundled copy can defeat `instanceof`, so it also matches the
// documented `kind` tag. Imported by every command that maps a caught gh failure
// to the §2.7 machine-readable error (ship, fetch-review) instead of re-copying it.
export function isGhError(error: unknown): error is GhError {
  return error instanceof GhError || (typeof error === 'object' && error !== null && (error as { kind?: unknown }).kind === 'gh-error');
}

export function assertSafeRefName(ref: string, label = 'ref'): void {
  if (
    ref === ''
    || ref.startsWith('-')
    || ref.includes(':')
    || /\s|[\x00-\x1f\x7f]/.test(ref)
  ) {
    throw new Error(`unsafe ${label} ${JSON.stringify(ref)}`);
  }
}

export function assertSafeFeatureBranch(branch: string): void {
  assertSafeRefName(branch, 'branch');
  if (!branch.startsWith('feature/')) {
    throw new Error(`unsafe branch ${JSON.stringify(branch)}: expected feature/ namespace`);
  }
}

function realSpawn(file: string, args: string[], options: GhSpawnOptions): GhSpawnResult {
  const result = spawnSync(file, args, options);
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function commandString(binary: string, args: readonly string[]): string {
  return [binary, ...args].join(' ');
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

function ghJson<T>(value: string, command: string, step?: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GhError(command, tailOf(value), `${command} returned invalid JSON: ${detail}`, step);
  }
}

export function createGhAdapter(deps: GhAdapterDeps = {}): GhAdapter {
  const binary = deps.binary ?? 'gh';
  const spawn = deps.spawn ?? realSpawn;
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function run(args: string[], step?: string): string {
    const command = commandString(binary, args);
    const result = spawn(binary, args, { shell: false, encoding: 'utf8', timeout });
    if (result.error !== undefined) {
      const detail = result.error.message;
      throw new GhError(command, tailOf(detail), `${command} failed to spawn: ${detail}`, step);
    }
    if (result.status !== 0) {
      const detail = result.stderr.trim();
      throw new GhError(command, tailOf(result.stderr), `${command} failed (status ${result.status}): ${detail}`, step);
    }
    return result.stdout;
  }

  return {
    findPrByHead(head: string, step = 'pr-list'): GhPrView | null {
      assertSafeFeatureBranch(head);
      const args = ['pr', 'list', '--head', head, '--json', LIST_FIELDS, '--limit', '1'];
      const prs = ghJson<GhPrView[]>(run(args, step), commandString(binary, args), step);
      return prs[0] ?? null;
    },

    viewPr(pr: number, step = 'pr-view'): GhPrView {
      const id = String(pr);
      const args = ['pr', 'view', id, '--json', VIEW_FIELDS];
      return ghJson<GhPrView>(run(args, step), commandString(binary, args), step);
    },

    createPr(opts: GhCreatePrOptions, step = 'pr-create'): GhCreatePrResult {
      assertSafeRefName(opts.base, 'base branch');
      assertSafeFeatureBranch(opts.head);
      const args = [
        'pr',
        'create',
        '--base',
        opts.base,
        '--head',
        opts.head,
        '--title',
        opts.title,
        '--body-file',
        opts.bodyFile,
      ];
      return { url: run(args, step).trim() };
    },

    editPrBody(pr: number, bodyFile: string, step = 'pr-edit'): void {
      run(['pr', 'edit', String(pr), '--body-file', bodyFile], step);
    },

    watchChecks(pr: number, step = 'ci-wait'): GhCheckRun[] {
      const args = ['pr', 'checks', String(pr), '--watch', '--json', 'name,state,bucket,conclusion'];
      const out = run(args, step).trim();
      if (out === '') return [];
      return ghJson<GhCheckRun[]>(out, commandString(binary, args), step);
    },

    deleteLocalBranchArgs(branch: string, base = 'main'): string[] {
      if (branch === base) throw new Error(`refuses to delete base branch ${JSON.stringify(branch)}`);
      assertSafeFeatureBranch(branch);
      return ['branch', '-D', '--', branch];
    },

    repoInfo(step = 'repo-view'): GhRepoInfo {
      const args = ['repo', 'view', '--json', REPO_FIELDS];
      const raw = ghJson<{ owner?: { login?: string }; name?: string }>(run(args, step), commandString(binary, args), step);
      return { owner: raw.owner?.login ?? '', name: raw.name ?? '' };
    },

    prReviewData(owner: string, name: string, pr: number, step = 'review-data'): GhReviewData {
      assertSafeRefName(owner, 'owner');
      assertSafeRefName(name, 'repo name');
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${REVIEW_DATA_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${String(pr)}`,
      ];
      const envelope = ghJson<{
        data?: { repository?: { pullRequest?: {
          mergeable?: string | boolean | null;
          reviews?: { nodes?: GhReviewNode[] };
          reviewThreads?: { nodes?: GhReviewThreadNode[]; pageInfo?: { hasNextPage?: boolean } };
        } | null } };
      }>(run(args, step), commandString(binary, args), step);
      const prNode = envelope.data?.repository?.pullRequest;
      const threads = prNode?.reviewThreads?.nodes ?? [];
      const threadsTruncated =
        prNode?.reviewThreads?.pageInfo?.hasNextPage === true || threads.length >= REVIEW_PAGE_LIMIT;
      const commentsTruncated = threads.some(
        (thread) =>
          thread.comments?.pageInfo?.hasNextPage === true
          || (thread.comments?.nodes?.length ?? 0) >= REVIEW_PAGE_LIMIT,
      );
      return {
        reviews: prNode?.reviews?.nodes ?? [],
        threads,
        mergeable: prNode?.mergeable ?? null,
        truncated: { threads: threadsTruncated, comments: commentsTruncated },
      };
    },
  };
}
