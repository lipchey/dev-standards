// §2.7 / spec §2.7 + §10 `workflow cleanup [--dry-run]`: the most safety-critical
// command in the helper. It sweeps EVERY feature record in
// `.agents/handoffs/STATE.md`, asks GitHub each PR's merge status, and decides one
// of three outcomes per record — VALIDATING the record as UNTRUSTED input before
// any destructive op (validation-before-destruction), archiving a slim
// metadata-only summary, and dropping the record only after a fully successful
// clean-up.
//
// Outcomes (plan §2.7 + §2.4), decided via `viewPr(record.pr)`:
//   1. PR merged + CLEAN worktree  -> archive, remove worktree, force-delete
//      local branch, prune, close cmux section when armed, DROP record.
//   2. PR merged + DIRTY worktree  -> set review_state: done, leave everything.
//   3. PR not merged (open/awaiting/ci_failed) -> untouched (skip).
//   In-place records (worktree: "") -> rule 4 + the worktree-removal step are
//      N/A; merged + rules 1-3 pass -> archive, force-delete branch, drop record.
//
// `--dry-run` performs ZERO side effects (no archive write, no branch delete, no
// worktree removal, no cmux close, no record mutation) and reports what WOULD
// happen.
//
// Pure core + injected seams (ADR-006): all fs/git/gh/cmux effects arrive through
// the deps, wired only at the CLI edge. Per-record VALIDATION failures are NOT
// errors — they are reported-and-skipped and the sweep continues (exit 0 if no
// infra failure). A genuine gh/git spawn failure aborts the sweep with the §2.7
// machine-readable error (no silent retries).

import path from 'node:path';
import { EXIT_FAILURE, EXIT_OK } from './types.ts';
import type { FeatureRecord, WorkflowConfig } from './types.ts';
import { parseSubset, serializeSubset } from './front-matter.ts';
import type { SubsetMap } from './front-matter.ts';
import { readFeatureRecords, writeFeatureRecords } from './feature-record.ts';
import { isGitError, machineGitError } from './trailers.ts';
import type { MachineReadableError, RunGit } from './trailers.ts';
import { assertSafeFeatureBranch, isGhError, machineReadableGhError } from './gh.ts';
import type { GhAdapter } from './gh.ts';
import { sanitizeFeatureSlug } from './new-feature.ts';

export interface CleanupOptions {
  dryRun: boolean;
}

// The cmux close-section seam: closes the feature's section when cmux is armed,
// degrades silently (ok:false) otherwise (mirrors the S13 probe-first adapter).
export interface CmuxCloseResult {
  ok: boolean;
  error?: string;
}

export interface CleanupDeps {
  repoRoot: string;
  statePath: string;
  config: WorkflowConfig;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  mkdir: (dirPath: string) => void;
  now: () => string; // ISO-8601 UTC; the archive <date> is its leading YYYY-MM-DD
  runGit: RunGit; // status/worktree/branch/check-ref-format — fixed argv, shell:false
  // The `git worktree remove` seam, isolated so the destructive removal is a single
  // injectable edge (the CLI wires it through runGit; tests record it separately).
  removeWorktree: (worktreePath: string) => void;
  gh: GhAdapter;
  // Close the cmux section for a feature when armed; degrades when cmux/the verb is
  // absent. Called only on a successful full cleanup (outcome 1), never under dry-run.
  closeCmuxSection: (section: string) => CmuxCloseResult;
  cmuxArmed: boolean;
  // Scans the archive CONTENT before it is persisted (same seam shape as ship's
  // scanPrBody: null = clean, non-null = hit description). A hit SKIPS the archive
  // and LOGS the skip, but the rest of the cleanup PROCEEDS.
  scanPrBody: (content: string) => string | null;
  // Resolves a worktree path's realpath for rule 4 confinement (the CLI wires the
  // real fs.realpathSync; tests inject identity / an escape).
  realpath: (filePath: string) => string;
  // Tests whether a recorded worktree path still exists on disk (the CLI wires
  // fs.existsSync; tests inject a controllable stub). Used by rule 4 to recognize
  // the partial-failure re-run case: a recorded worktree that was already removed
  // on disk (so real `git worktree list` no longer reports it) is treated as the
  // already-removed / in-place case — validation PASSES so the deferred branch
  // delete can be retried — WITHOUT weakening the present-but-out-of-parent or
  // present-but-unassociated skip. Takes the recorded path as-is (no resolution).
  pathExists: (filePath: string) => boolean;
  // Non-fatal operator log (skips, dry-run plan lines). The CLI wires io.stderr/stdout.
  log: (text: string) => void;
}

export interface CleanupResult {
  exitCode: number;
  message: string;
  error?: MachineReadableError;
}

interface StateDoc {
  frontText: string;
  body: string;
}

// What cleanup decided for one record (also the dry-run plan vocabulary).
//
// A `full-cleanup` outcome carries the EXACT archive bytes that were scanned in
// `decide()` plus the archive file path derived from the SAME `deps.now()` call.
// `applyFullCleanup()` writes those stored bytes to that stored path verbatim — no
// fresh `now()`, no rebuild — so bytes-scanned === bytes-written and the filename
// date === the content date (Item A: scan exactly what you write).
type Outcome =
  | {
      kind: 'full-cleanup';
      record: FeatureRecord;
      archiveSkipped: boolean;
      archiveContent: string;
      archivePath: string;
    }
  | { kind: 'dirty-done'; record: FeatureRecord }
  | { kind: 'skip'; record: FeatureRecord; reason: string };

// Copies ship.ts's STATE.md split idiom byte-for-byte: front matter (incl. the
// `---` fences) is parsed/serialized via the subset codec; the markdown body is
// preserved untouched so every non-`features` key round-trips byte-stable.
function readStateDoc(deps: CleanupDeps): StateDoc {
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

// `merged` per spec §2.7: state === "MERGED" AND a non-null mergedAt. Both are
// required so an in-flight or closed-unmerged PR never reads as merged.
function isMerged(view: { state?: string; mergedAt?: string | null }): boolean {
  return view.state === 'MERGED' && view.mergedAt !== null && view.mergedAt !== undefined && view.mergedAt !== '';
}

// "Clean worktree" = `git status --porcelain` in that worktree is empty.
function isWorktreeClean(deps: CleanupDeps, worktree: string): boolean {
  return deps.runGit(['status', '--porcelain'], worktree).trim() === '';
}

// Parses `git worktree list --porcelain` into branch -> worktree path AND the set
// of branches currently checked out in a live worktree. A `worktree <path>` line
// opens a block; the block's `branch refs/heads/<name>` names its checked-out
// branch. The cleanup-running repo's own HEAD is one of these blocks, so it is
// naturally included in the live set (rule 3 protects the branch you stand on).
function parseWorktrees(porcelain: string): { byBranch: Map<string, string>; liveBranches: Set<string> } {
  const byBranch = new Map<string, string>();
  const liveBranches = new Set<string>();
  let currentPath: string | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      liveBranches.add(branch);
      if (currentPath !== null) byBranch.set(branch, currentPath);
    } else if (line.trim() === '') {
      currentPath = null;
    }
  }
  return { byBranch, liveBranches };
}

// True when `child` is `parent` itself or lives under it (path-segment aware, so
// `/a/worktrees-evil` is NOT under `/a/worktrees`). Both inputs are realpath'd by
// the caller before this comparison.
function isUnder(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The 4 destructive-op validation rules, run BEFORE any worktree removal or
// `git branch -D`. ANY rule failing returns a skip reason (report-and-skip, never
// delete). UNTRUSTED records: a stale/corrupt/hand-edited record must never drive
// a destructive op.
//
// Returns null when every rule passes (the record is safe to clean up).
function validateForDestruction(
  deps: CleanupDeps,
  record: FeatureRecord,
  view: { state?: string; mergedAt?: string | null; headRefName?: string },
  worktrees: { byBranch: Map<string, string>; liveBranches: Set<string> },
): string | null {
  // ── Rule 0: safe slug ─────────────────────────────────────────────────────
  // Feature records are UNTRUSTED and readFeatureRecords does NOT re-sanitize the
  // slug. The slug feeds the archive FILE PATH (`.agents/handoffs/<date>-workflow-
  // ${slug}.md`), the cmux section name, and log lines, so a hand-edited
  // `slug: "../../../../README"` would otherwise drive a path-traversal archive
  // write (overwriting a repo file) BEFORE any delete. Screen it FIRST, before any
  // archive/cmux/branch op, reusing the S12 slug validator (charset [a-z0-9-],
  // length 1-60, no separators / `..` / leading `-` / control chars / empty). A
  // failing slug is report-and-skip — never archive, never delete (same as the
  // other rules). Defense in depth: applyFullCleanup also confines the resolved
  // archive path under <repoRoot>/.agents/handoffs.
  try {
    sanitizeFeatureSlug(record.slug);
  } catch {
    return `unsafe slug ${JSON.stringify(record.slug)}: not a valid feature slug`;
  }

  // ── Rule 1: safe ref ──────────────────────────────────────────────────────
  // PURE screen first (never pass an unscreened operand to git), then
  // `git check-ref-format --branch`. A check-ref-format non-zero exit is "rule
  // fails -> skip", NOT a machine-readable command error — so it is caught here
  // and converted to a skip reason rather than propagating as an infra failure.
  try {
    assertSafeFeatureBranch(record.branch);
  } catch (error) {
    return `unsafe branch ref ${JSON.stringify(record.branch)}: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    deps.runGit(['check-ref-format', '--branch', record.branch], deps.repoRoot);
  } catch {
    return `branch ${JSON.stringify(record.branch)} failed git check-ref-format`;
  }

  // ── Rule 2: head-ref match ────────────────────────────────────────────────
  // viewPr must report a MERGED PR AND its headRefName must equal the record
  // branch — a mismatch means the record does not own that PR's branch.
  if (!isMerged(view)) {
    return `PR ${record.pr} is not merged (state=${view.state ?? 'unknown'})`;
  }
  if (view.headRefName !== record.branch) {
    return `PR ${record.pr} head ref ${JSON.stringify(view.headRefName ?? '')} does not match record branch ${JSON.stringify(record.branch)}`;
  }

  // ── Rule 3: never base or current ─────────────────────────────────────────
  // Refuse the base branch OR any branch currently checked out in a live worktree
  // (incl. the cleanup-running repo's own HEAD). Order note: the feature's OWN
  // worktree is removed FIRST in the cleanup sequence so its checkout no longer
  // blocks `git branch -D`; rule 3 protects base + the branch you stand on + any
  // OTHER live worktree's branch. The feature's own worktree association (rule 4)
  // is allowed here — it is removed before the delete.
  if (record.branch === deps.config.base_branch) {
    return `record branch ${JSON.stringify(record.branch)} is the base branch; refusing to delete`;
  }
  const ownWorktree = worktrees.byBranch.get(record.branch);
  const liveElsewhere = worktrees.liveBranches.has(record.branch)
    && (record.worktree === '' || ownWorktree === undefined || safeRealpath(deps, ownWorktree) !== safeRealpath(deps, record.worktree));
  if (liveElsewhere) {
    return `branch ${JSON.stringify(record.branch)} is checked out in a live worktree; refusing to delete`;
  }

  // ── Rule 4: worktree confinement (in-place + already-removed exempt) ───────
  // When record.worktree is non-empty:
  //   - If the recorded path is GONE on disk (deps.pathExists === false), the
  //     worktree was already removed — the partial-failure re-run case (Item B):
  //     run 1 removed the worktree but its `git branch -D` then threw, so the
  //     record was kept; on re-run real `git worktree list` no longer reports it
  //     and its byBranch association is gone. Treat this exactly like the already-
  //     removed / in-place case: validation PASSES (fall through to return null).
  //     applyFullCleanup still calls removeWorktree on the gone path, which no-ops
  //     idempotently (isAlreadyAbsentWorktree tolerance at the CLI edge), then
  //     retries the branch delete (gated by rules 1-3) and drops the record. This
  //     is the ONLY way the record stops leaking — without it rule 4 below would
  //     skip it forever once git stops associating the removed worktree.
  //   - Else (path EXISTS): its realpath must resolve UNDER config.worktree_parent
  //     AND be the worktree git associates with record.branch (the present-but-
  //     out-of-parent and present-but-unassociated skips are preserved unchanged).
  // When worktree === "": skip this rule (and the worktree-removal step).
  if (record.worktree !== '' && deps.pathExists(record.worktree)) {
    const resolved = safeRealpath(deps, record.worktree);
    const parent = safeRealpath(deps, deps.config.worktree_parent);
    if (!isUnder(parent, resolved)) {
      return `worktree ${JSON.stringify(record.worktree)} resolves outside worktree_parent ${JSON.stringify(deps.config.worktree_parent)}; refusing to remove`;
    }
    const assoc = worktrees.byBranch.get(record.branch);
    if (assoc === undefined || safeRealpath(deps, assoc) !== resolved) {
      return `worktree ${JSON.stringify(record.worktree)} is not the worktree git associates with branch ${JSON.stringify(record.branch)}; refusing to remove`;
    }
  }

  return null;
}

// realpath, but never throw (a missing path resolves to itself so confinement
// still compares deterministically rather than crashing the sweep).
function safeRealpath(deps: CleanupDeps, p: string): string {
  try {
    return deps.realpath(p);
  } catch {
    return p;
  }
}

// The slim archive (spec §10 step 7 — metadata ONLY, bodies FORBIDDEN). Every
// line is a heading or a `- ` metadata bullet (mirrors ship's metadata-only PR
// body). HARD INVARIANT: never embed raw review/finding/diff/comment bodies or
// code fences. Planning enrichment (verdict one-liners, loopback count, SHAs) is
// out of scope unless a planning file is wired; this build keeps to the always-
// available STATE.md metadata, which is the load-bearing record.
function buildArchive(record: FeatureRecord, now: string): string {
  const date = now.slice(0, 10);
  return [
    `# workflow cleanup: ${record.slug}`,
    `- slug: ${record.slug}`,
    `- branch: ${record.branch}`,
    `- pr: ${record.pr}`,
    `- review_state: ${record.review_state}`,
    `- date: ${date}`,
    `- archived_at: ${now}`,
    '',
  ].join('\n');
}

// Derives the archive file path from a CALLER-SUPPLIED timestamp (never a fresh
// `deps.now()`), so the filename date matches the `date`/`archived_at` baked into
// the archive content built from the SAME timestamp (Item A: no clock-tick drift).
function archivePath(deps: CleanupDeps, record: FeatureRecord, now: string): string {
  const date = now.slice(0, 10);
  return path.join(deps.repoRoot, '.agents', 'handoffs', `${date}-workflow-${record.slug}.md`);
}

// Decides the outcome for ONE record. Reads the PR view (the gh round-trip that can
// throw a GhError -> infra failure) and applies the merge/dirty/validation logic.
// Pure of side effects: returns the decision; the caller applies it.
function decide(
  deps: CleanupDeps,
  record: FeatureRecord,
  worktrees: { byBranch: Map<string, string>; liveBranches: Set<string> },
): Outcome {
  // Outcome 3 (no-PR variant): an in-progress feature record has no PR yet —
  // new-feature/feature-start write `pr: 0` (and `review_state: "building"`) until
  // ship opens one. Skip it BEFORE the `viewPr(record.pr)` round-trip: `gh pr view 0`
  // exits non-zero -> GhError, which (thrown from this pre-apply decide() map) would
  // ABORT the whole sweep instead of skipping one record. `pr <= 0` is the load-
  // bearing no-PR signal (a real PR always has a positive number); the skip outcome
  // is the same report-and-continue family as the not-merged/validation skips, and
  // changes no §2.7 destructive-op rule.
  if (record.pr <= 0) {
    return { kind: 'skip', record, reason: `no PR yet (pr=${record.pr}, review_state=${record.review_state})` };
  }

  const view = deps.gh.viewPr(record.pr);

  // Outcome 3: not merged -> untouched.
  if (!isMerged(view)) {
    return { kind: 'skip', record, reason: `PR ${record.pr} not merged (state=${view.state ?? 'unknown'})` };
  }

  // Merged. Validate the record as UNTRUSTED input BEFORE deciding to destroy.
  const invalid = validateForDestruction(deps, record, view, worktrees);
  if (invalid !== null) {
    return { kind: 'skip', record, reason: invalid };
  }

  // Outcome 2: merged + DIRTY worktree -> set done, leave everything. (In-place
  // records have no worktree, so the dirty split is N/A — they are always clean.)
  // FIX 2: only run the dirty/clean check when the recorded worktree STILL EXISTS
  // on disk. On the already-removed rerun case (rule 4 passed because pathExists is
  // false), running `git status --porcelain` with cwd=the gone worktree makes the
  // REAL runner spawn git against a missing cwd -> ENOENT -> GitError -> the sweep
  // would ABORT before applyFullCleanup's tolerant removeWorktree no-op. A gone
  // worktree is treated as already-removed (like in-place for this run): fall
  // through to the full-cleanup path WITHOUT calling git status in the missing dir.
  const worktreeGone = record.worktree !== '' && !deps.pathExists(record.worktree);
  if (record.worktree !== '' && !worktreeGone && !isWorktreeClean(deps, record.worktree)) {
    return { kind: 'dirty-done', record };
  }

  // Outcome 1: merged + clean (or in-place). Item A: take ONE timestamp, build the
  // archive content ONCE from it, derive the archive path from the SAME timestamp,
  // and SCAN exactly those bytes. The stored content/path are what `applyFullCleanup`
  // writes verbatim — so bytes-scanned === bytes-written and filename date ===
  // content date (no drift across a clock tick / UTC midnight). A scan hit still
  // SKIPS the archive write but the cleanup PROCEEDS (archiveSkipped semantics kept).
  const now = deps.now();
  const archiveContent = buildArchive(record, now);
  const scanHit = deps.scanPrBody(archiveContent);
  return {
    kind: 'full-cleanup',
    record,
    archiveSkipped: scanHit !== null,
    archiveContent,
    archivePath: archivePath(deps, record, now),
  };
}

// Applies a full-cleanup outcome's side effects in the SECURITY ordering:
// write archive (the EXACT bytes scanned in decide(), if clean & config.archive)
// -> remove worktree (skip if in-place) -> git branch -D via deleteLocalBranchArgs
// through runGit -> prune -> close cmux when armed. The record DROP is done by the
// caller after this returns. Item A: the archive content and path are taken from
// the outcome (built+scanned in decide() under a single now()), never rebuilt here.
function applyFullCleanup(
  deps: CleanupDeps,
  outcome: { record: FeatureRecord; archiveSkipped: boolean; archiveContent: string; archivePath: string },
): void {
  const { record, archiveSkipped } = outcome;
  if (archiveSkipped) {
    deps.log(`cleanup: ${record.slug}: archive SKIPPED (secret scan hit); proceeding with cleanup\n`);
  } else if (deps.config.archive) {
    // DEFENSE IN DEPTH (FIX 1): even though rule 0 already screened the slug, never
    // write outside the handoffs dir. Resolve both the handoffs root and the archive
    // path and confirm the archive stays UNDER it (path-segment aware). A path that
    // escapes is SKIPPED (no write) and logged — the rest of the cleanup PROCEEDS.
    const handoffsRoot = safeRealpath(deps, path.join(deps.repoRoot, '.agents', 'handoffs'));
    const resolvedArchive = safeRealpath(deps, outcome.archivePath);
    if (!isUnder(handoffsRoot, resolvedArchive)) {
      deps.log(`cleanup: ${record.slug}: archive SKIPPED (path escapes .agents/handoffs); proceeding with cleanup\n`);
    } else {
      deps.mkdir(path.dirname(outcome.archivePath));
      deps.writeFile(outcome.archivePath, outcome.archiveContent);
    }
  }

  // Remove the feature's OWN worktree FIRST (so its checkout no longer blocks the
  // branch delete). Skip entirely for in-place records.
  if (record.worktree !== '') {
    deps.removeWorktree(record.worktree);
  }

  // Force-delete the local branch via the gh primitive (refuses base, screens the
  // ref, returns the GIT argv) run through runGit. This is the merge-guarded
  // destructive op — only reachable after validation passed.
  const argv = deps.gh.deleteLocalBranchArgs(record.branch, deps.config.base_branch);
  deps.runGit(argv, deps.repoRoot);

  // Prune now-stale worktree administrative entries.
  deps.runGit(['worktree', 'prune'], deps.repoRoot);

  // Close the feature's cmux section when armed; degrade silently otherwise. The
  // section name is the slug (the new-feature/cmux convention).
  if (deps.cmuxArmed) {
    const result = deps.closeCmuxSection(record.slug);
    if (!result.ok) {
      deps.log(`cleanup: ${record.slug}: cmux close degraded (${result.error ?? 'unavailable'})\n`);
    }
  }
}

function failure(message: string, error?: MachineReadableError): CleanupResult {
  return error === undefined ? { exitCode: EXIT_FAILURE, message } : { exitCode: EXIT_FAILURE, message, error };
}

// The dry-run plan line for one decided outcome.
function dryRunLine(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'full-cleanup':
      return `cleanup --dry-run: WOULD full-clean ${outcome.record.branch} (archive${outcome.archiveSkipped ? ' SKIPPED (scan hit)' : ''}, remove worktree${outcome.record.worktree === '' ? ' [in-place: none]' : ''}, delete branch, prune, drop record)\n`;
    case 'dirty-done':
      return `cleanup --dry-run: WOULD set ${outcome.record.branch} review_state=done (merged but worktree dirty; keep everything)\n`;
    case 'skip':
      return `cleanup --dry-run: WOULD skip ${outcome.record.branch} (${outcome.reason})\n`;
  }
}

export function cleanup(opts: CleanupOptions, deps: CleanupDeps): CleanupResult {
  try {
    const stateDoc = readStateDoc(deps);
    const doc: SubsetMap = parseSubset(stateDoc.frontText);
    const records = readFeatureRecords(doc);

    // ONE `git worktree list --porcelain` for the whole sweep (rules 3 & 4).
    const worktrees = parseWorktrees(deps.runGit(['worktree', 'list', '--porcelain'], deps.repoRoot));

    // Decide every record first (each decide() does the gh round-trip; a GhError
    // here aborts the whole sweep before any side effect).
    const outcomes = records.map((record) => decide(deps, record, worktrees));

    // ── Dry-run: report what WOULD happen, ZERO side effects, return. ─────────
    if (opts.dryRun) {
      for (const outcome of outcomes) deps.log(dryRunLine(outcome));
      const summary = summarize(outcomes);
      return { exitCode: EXIT_OK, message: `dry-run: would ${summary} (no side effects performed)` };
    }

    // ── Apply: destruction only after all gates passed per record. ───────────
    // Item B: the sweep is RESUMABLE. Each record applies in its OWN try; on success
    // its branch is accumulated for drop (full-cleanup) or done (dirty-done). If
    // `applyFullCleanup` THROWS mid-loop, we STOP the loop but STILL persist STATE.md
    // reflecting the records ALREADY cleaned/done (single write), then return the
    // machine-readable failure. So a re-run starts from the persisted state and never
    // re-processes an already-cleaned record (whose branch/worktree are gone on disk).
    const dropped = new Set<string>();
    const doneBranches = new Set<string>();
    let applyError: unknown;
    for (const outcome of outcomes) {
      try {
        if (outcome.kind === 'full-cleanup') {
          applyFullCleanup(deps, outcome);
          dropped.add(outcome.record.branch);
        } else if (outcome.kind === 'dirty-done') {
          doneBranches.add(outcome.record.branch);
        } else {
          deps.log(`cleanup: skip ${outcome.record.branch} (${outcome.reason})\n`);
        }
      } catch (error) {
        // A destructive runGit / removeWorktree threw. Stop the loop; the finally
        // below still persists the progress made by the earlier records.
        applyError = error;
        break;
      }
    }

    // Single STATE.md round-trip — runs on BOTH the all-success path and the
    // partial-failure path. Drop the fully-cleaned records, set dirty-merged records
    // to done, leave every skipped (and not-yet-reached) record + non-features key
    // untouched. On partial failure this commits the progress already made on disk.
    persistState(deps, doc, stateDoc, records, dropped, doneBranches);

    if (applyError !== undefined) {
      if (isGhError(applyError)) return failure(applyError.message, machineReadableGhError(applyError).error);
      if (isGitError(applyError)) return failure(applyError.message, machineGitError(applyError));
      const detail = applyError instanceof Error ? applyError.message : String(applyError);
      return failure(detail);
    }

    return { exitCode: EXIT_OK, message: summarize(outcomes) };
  } catch (error) {
    // Pre-apply path (readStateDoc / worktree list / decide()'s gh round-trips):
    // nothing has been written yet, so abort with NO STATE.md write.
    if (isGhError(error)) return failure(error.message, machineReadableGhError(error).error);
    if (isGitError(error)) return failure(error.message, machineGitError(error));
    const detail = error instanceof Error ? error.message : String(error);
    return failure(detail);
  }
}

// The single STATE.md round-trip: drop the fully-cleaned records, set dirty-merged
// records to done, leave every other record (skipped, or not-yet-reached after a
// partial failure) and every non-features key untouched. Used by both the success
// path and the partial-failure path so the bytes written are identical in shape.
function persistState(
  deps: CleanupDeps,
  doc: SubsetMap,
  stateDoc: StateDoc,
  records: FeatureRecord[],
  dropped: Set<string>,
  doneBranches: Set<string>,
): void {
  const nextRecords = records
    .filter((r) => !dropped.has(r.branch))
    .map((r) => (doneBranches.has(r.branch) ? { ...r, review_state: 'done' as const } : r));
  writeFeatureRecords(doc, nextRecords);
  deps.mkdir(path.dirname(deps.statePath));
  deps.writeFile(deps.statePath, serializeSubset(doc) + stateDoc.body);
}

function summarize(outcomes: Outcome[]): string {
  const cleaned = outcomes.filter((o) => o.kind === 'full-cleanup').length;
  const done = outcomes.filter((o) => o.kind === 'dirty-done').length;
  const skipped = outcomes.filter((o) => o.kind === 'skip').length;
  return `clean up ${cleaned} merged feature(s), set ${done} dirty-merged to done, skip ${skipped}`;
}
