// §2.5 / §2.7 `workflow fetch-review`: the data-fetch step of a human "process
// review" session. It pulls the latest submitted PR review plus its review threads
// (up to the GraphQL page cap; a PR beyond the cap is WARNed on stderr, never
// silently dropped), writes a normalized JSON file (§2.5), and advances the
// matching feature record to `processing_review` (§2.4 lifecycle). Pure logic +
// injected seams (ADR-006): all fs/git/gh IO (and the warning stream) arrives
// through the deps, wired only at the CLI edge. No silent retries; review comment
// bodies are stored verbatim as DATA and never influence control flow or reach an
// argv element.

import path from 'node:path';
import { EXIT_FAILURE, EXIT_OK, EXIT_WRONG_STATE } from './types.ts';
import type { FeatureRecord } from './types.ts';
import { parseSubset, serializeSubset } from './front-matter.ts';
import { readFeatureRecords, writeFeatureRecords } from './feature-record.ts';
import { isGitError, machineGitError } from './trailers.ts';
import type { MachineReadableError, RunGit } from './trailers.ts';
import { isGhError, machineReadableGhError, REVIEW_PAGE_LIMIT } from './gh.ts';
import type { GhAdapter, GhReviewNode, GhReviewThreadNode } from './gh.ts';

export interface FetchReviewOptions {
  pr?: number;
}

export interface FetchReviewDeps {
  repoRoot: string;
  statePath: string;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  mkdir: (dirPath: string) => void;
  runGit: RunGit;
  gh: GhAdapter;
  // The warning stream (the CLI wires `io.stderr`). Used ONLY for the non-fatal
  // truncation WARNing — the command still succeeds and writes the file.
  stderr: (text: string) => void;
}

export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented';

export interface NormalizedComment {
  id: number;
  thread_id: string;
  resolved: boolean;
  file: string;
  line: number;
  body: string;
  in_reply_to: number;
}

export interface NormalizedReview {
  pr: number;
  review_id: number;
  verdict: ReviewVerdict;
  submitted_at: string;
  pr_mergeable: boolean;
  comments: NormalizedComment[];
}

export interface FetchReviewResult {
  exitCode: number;
  message: string;
  pr?: number;
  reviewId?: number;
  path?: string;
  error?: MachineReadableError;
}

interface StateDoc {
  frontText: string;
  body: string;
}

// §2.5 verdict normalization. GraphQL PullRequestReviewState → the §2.5 vocabulary.
// PENDING / DISMISSED are NOT verdicts (no submittedAt verdict), so they are
// excluded from "the latest submitted review".
const VERDICT_BY_STATE: Record<string, ReviewVerdict> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
};

// Copies ship.ts's STATE.md split idiom byte-for-byte: front matter (incl. the
// `---` fences) is parsed/serialized via the subset codec; the markdown body is
// preserved untouched so every non-`features` key round-trips byte-stable.
function readStateDoc(deps: FetchReviewDeps): StateDoc {
  const text = deps.readFile(deps.statePath);
  const lines = text.split('\n');
  if (lines[0] !== '---') return { frontText: '---\n---\n', body: text };
  const close = lines.findIndex((line, index) => index > 0 && line === '---');
  if (close < 0) return { frontText: '---\n---\n', body: text };
  return {
    frontText: `${lines.slice(0, close + 1).join('\n')}\n`,
    body: lines.slice(close + 1).join('\n'),
  };
}

// The latest SUBMITTED review (state in the §2.5 verdict set, with a submittedAt),
// chosen by max submittedAt (ISO-8601 sorts lexically). When none exists the file
// is still written with review_id 0 / verdict commented so the step is idempotent.
function latestSubmittedReview(reviews: GhReviewNode[]): {
  reviewId: number;
  verdict: ReviewVerdict;
  submittedAt: string;
} {
  let best: GhReviewNode | undefined;
  let bestVerdict: ReviewVerdict | undefined;
  for (const review of reviews) {
    const at = review.submittedAt;
    const verdict = review.state === undefined ? undefined : VERDICT_BY_STATE[review.state];
    if (typeof at !== 'string' || at === '' || verdict === undefined) continue;
    if (best === undefined || at >= (best.submittedAt as string)) {
      best = review;
      bestVerdict = verdict;
    }
  }
  if (best === undefined || bestVerdict === undefined) {
    return { reviewId: 0, verdict: 'commented', submittedAt: '' };
  }
  return { reviewId: best.databaseId ?? 0, verdict: bestVerdict, submittedAt: best.submittedAt as string };
}

// Flattens every comment of every FETCHED thread (resolved threads included with
// resolved:true so re-runs are idempotent), preserving per-thread comment order.
// "Fetched" is load-bearing: the query caps each connection at REVIEW_PAGE_LIMIT,
// and the caller WARNs when that cap truncates. Comment bodies are copied verbatim
// as data — never interpreted.
function normalizeComments(threads: GhReviewThreadNode[]): NormalizedComment[] {
  const comments: NormalizedComment[] = [];
  for (const thread of threads) {
    const threadId = thread.id ?? '';
    const resolved = thread.isResolved === true;
    for (const comment of thread.comments?.nodes ?? []) {
      comments.push({
        id: comment.databaseId ?? 0,
        thread_id: threadId,
        resolved,
        file: comment.path ?? '',
        line: comment.line ?? 0,
        body: comment.body ?? '',
        in_reply_to: comment.replyTo?.databaseId ?? 0,
      });
    }
  }
  return comments;
}

// §2.5 pr_mergeable: MERGEABLE/true → true; CONFLICTING/false/UNKNOWN/null → false.
function mergeableToBool(value: string | boolean | null | undefined): boolean {
  if (value === true) return true;
  if (typeof value === 'string' && value.toUpperCase() === 'MERGEABLE') return true;
  return false;
}

function wrongState(message: string): FetchReviewResult {
  return { exitCode: EXIT_WRONG_STATE, message };
}

function failure(message: string, error?: MachineReadableError): FetchReviewResult {
  return error === undefined ? { exitCode: EXIT_FAILURE, message } : { exitCode: EXIT_FAILURE, message, error };
}

export function fetchReview(opts: FetchReviewOptions, deps: FetchReviewDeps): FetchReviewResult {
  try {
    const branch = deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], deps.repoRoot).trim();
    const stateDoc = readStateDoc(deps);
    const doc = parseSubset(stateDoc.frontText);
    const records = readFeatureRecords(doc);

    // §2.7 PR resolution: --pr wins; otherwise the record matching the current
    // branch supplies the PR. The record we advance is matched by pr (or branch).
    let targetPr: number;
    let record: FeatureRecord | undefined;
    if (opts.pr !== undefined) {
      targetPr = opts.pr;
      // --pr wins: match by pr first. If no record carries that PR, fall back to the
      // current-branch record ONLY when it can legitimately claim this PR — its pr is
      // unset (0) or already equal to targetPr. NEVER advance a record whose pr names
      // a DIFFERENT PR, or fetch-review would mark the wrong feature processing_review.
      const byPr = records.find((r) => r.pr === targetPr);
      if (byPr !== undefined) {
        record = byPr;
      } else {
        const byBranch = records.find((r) => r.branch === branch);
        if (byBranch === undefined) {
          return wrongState(`fetch-review: no feature record matches PR ${targetPr} or branch "${branch}"`);
        }
        if (byBranch.pr !== targetPr && byBranch.pr !== 0) {
          return wrongState(
            `fetch-review: branch "${branch}" record is PR ${byBranch.pr}, not ${targetPr}; refusing to advance a mismatched record`,
          );
        }
        record = byBranch;
      }
    } else {
      record = records.find((r) => r.branch === branch);
      if (record === undefined || record.pr === 0) {
        return wrongState(`fetch-review: no feature record for branch "${branch}" has a PR; pass --pr <n>`);
      }
      targetPr = record.pr;
    }

    // Fetch reviews + threads + mergeability for the target PR in ONE GraphQL
    // round-trip (repoInfo resolves owner/name); single-shot, no retries.
    const repo = deps.gh.repoInfo();
    const data = deps.gh.prReviewData(repo.owner, repo.name, targetPr);
    // §2.5 pr_mergeable now rides in the same node — no separate `pr view` call.
    const mergeable = mergeableToBool(data.mergeable);

    // The query does not paginate, so a PR with more than REVIEW_PAGE_LIMIT threads
    // or comments is truncated. That is NOT a failure (the file is still written
    // with what was fetched), but silently dropping reviewer feedback is unsafe for
    // a human process review, so WARN on stderr naming what overflowed.
    const truncated: string[] = [];
    if (data.truncated.threads) truncated.push('review threads');
    if (data.truncated.comments) truncated.push('comments');
    if (truncated.length > 0) {
      deps.stderr(
        `fetch-review: WARNING: PR ${targetPr} has more than ${REVIEW_PAGE_LIMIT} ${truncated.join(' and ')}; `
          + `only the first ${REVIEW_PAGE_LIMIT} per connection were fetched — some reviewer feedback is NOT in the review file\n`,
      );
    }

    const latest = latestSubmittedReview(data.reviews);
    const normalized: NormalizedReview = {
      pr: targetPr,
      review_id: latest.reviewId,
      verdict: latest.verdict,
      submitted_at: latest.submittedAt,
      pr_mergeable: mergeable,
      comments: normalizeComments(data.threads),
    };

    // reports/** is gitignored; create the dir via the injected mkdir seam.
    const reviewPath = path.join(deps.repoRoot, 'reports', 'reviews', `pr-${targetPr}-review-${latest.reviewId}.json`);
    deps.mkdir(path.dirname(reviewPath));
    deps.writeFile(reviewPath, `${JSON.stringify(normalized, null, 2)}\n`);

    // Advance ONLY the matched record to processing_review; the byte-stable
    // round-trip leaves every other record and non-features key untouched.
    const targetBranch = record.branch;
    const nextRecords = records.map((r) =>
      r.branch === targetBranch ? { ...r, review_state: 'processing_review' as const } : r,
    );
    writeFeatureRecords(doc, nextRecords);
    deps.mkdir(path.dirname(deps.statePath));
    deps.writeFile(deps.statePath, serializeSubset(doc) + stateDoc.body);

    return {
      exitCode: EXIT_OK,
      message: `fetched review ${latest.reviewId} (${normalized.verdict}) for PR ${targetPr}; ${normalized.comments.length} comment(s) -> ${reviewPath}`,
      pr: targetPr,
      reviewId: latest.reviewId,
      path: reviewPath,
    };
  } catch (error) {
    if (isGhError(error)) return failure(error.message, machineReadableGhError(error).error);
    if (isGitError(error)) return failure(error.message, machineGitError(error));
    const detail = error instanceof Error ? error.message : String(error);
    return failure(detail);
  }
}
