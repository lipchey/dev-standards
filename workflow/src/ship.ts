import path from 'node:path';
import { EXIT_FAILURE, EXIT_OK } from './types.ts';
import type { FeatureRecord, FrontMatter, WorkflowConfig } from './types.ts';
import { parseFrontMatter, serializeFrontMatter } from './front-matter.ts';
import { parseSubset, serializeSubset } from './front-matter.ts';
import { readFeatureRecords, writeFeatureRecords } from './feature-record.ts';
import { isGitError, machineGitError, withWorkflowPhaseTrailer } from './trailers.ts';
import type { MachineReadableError, RunGit } from './trailers.ts';
import { isGhError, machineReadableGhError } from './gh.ts';
import type { GhAdapter, GhCheckRun } from './gh.ts';
import type { NotifyPayload, NotifyPostResult } from './notify.ts';

export interface ShipOptions {
  bodyFile?: string;
  noCiWait?: boolean;
}

export interface ShipDeps {
  repoRoot: string;
  statePath: string;
  planningFile?: string;
  config: WorkflowConfig;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  mkdir: (dirPath: string) => void;
  now: () => string;
  runGit: RunGit;
  gh: GhAdapter;
  notify: (payload: NotifyPayload) => NotifyPostResult;
  scanPrBody: (body: string) => string | null;
}

export interface ShipResult {
  exitCode: number;
  message: string;
  pr?: number;
  url?: string;
  ci?: 'green' | 'red' | 'none';
  error?: MachineReadableError;
}

interface StateDoc {
  frontText: string;
  body: string;
}

interface FeatureState {
  state: StateDoc;
  doc: ReturnType<typeof parseSubset>;
  records: FeatureRecord[];
}

function readStateDoc(deps: ShipDeps): StateDoc {
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

function extractPlanningFrontMatter(text: string): string {
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new Error('planning file is missing front matter');
  const close = lines.findIndex((line, index) => index > 0 && line === '---');
  if (close < 0) throw new Error('planning file front matter is not closed');
  return `${lines.slice(0, close + 1).join('\n')}\n`;
}

function readFeatureState(deps: ShipDeps): FeatureState {
  const state = readStateDoc(deps);
  const doc = parseSubset(state.frontText);
  return { state, doc, records: readFeatureRecords(doc) };
}

function writeFeatureState(deps: ShipDeps, featureState: FeatureState, records: FeatureRecord[]): void {
  writeFeatureRecords(featureState.doc, records);
  deps.mkdir(path.dirname(deps.statePath));
  deps.writeFile(deps.statePath, serializeSubset(featureState.doc) + featureState.state.body);
}

function parseDirtyPaths(out: string): string[] {
  return out
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.length > 3 ? entry.slice(3) : entry)
    .filter((entry) => entry !== '.workflow.lock');
}

function currentBranch(deps: ShipDeps): string {
  return deps.runGit(['branch', '--show-current'], deps.repoRoot).trim();
}

function prNumberFromUrl(url: string): number {
  const match = /\/pull\/(\d+)(?:\D*)$/.exec(url);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function generatedBody(branch: string, fm: FrontMatter | null): string {
  const feature = fm?.feature ?? branch.replace(/^feature\//, '');
  const state = fm?.state ?? 'session-mode';
  return [
    `# ${feature}`,
    `- Feature: ${feature}`,
    `- Branch: ${branch}`,
    `- Workflow state: ${state}`,
    '- Review: implementation-reviewed by workflow helper',
    '- ADR-011: skipped when the owner explicitly disabled automatic review-chain for this session',
    '',
  ].join('\n');
}

function writePrBody(body: string, deps: ShipDeps): string {
  const bodyPath = path.join(deps.repoRoot, 'reports', 'workflow-pr-body.md');
  deps.mkdir(path.dirname(bodyPath));
  deps.writeFile(bodyPath, body);
  return bodyPath;
}

function classifyCi(checks: GhCheckRun[], noCiWait: boolean): { ci: 'green' | 'red' | 'none'; failed: string[] } {
  if (noCiWait || checks.length === 0) return { ci: 'none', failed: [] };
  const failed = checks
    .filter((check) => {
      const values = [check.bucket, check.conclusion, check.state].filter((v): v is string => v !== undefined).map((v) => v.toLowerCase());
      return values.some((v) => ['fail', 'failure', 'failed', 'cancelled', 'timed_out', 'timedout', 'error'].includes(v));
    })
    .map((check) => check.name ?? 'unnamed-check');
  return failed.length > 0 ? { ci: 'red', failed } : { ci: 'green', failed: [] };
}

function updateRecord(
  records: FeatureRecord[],
  branch: string,
  pr: number,
  reviewState: FeatureRecord['review_state'],
): { records: FeatureRecord[]; previous: FeatureRecord | null } {
  let previous: FeatureRecord | null = null;
  let found = false;
  const next = records.map((record) => {
    if (record.branch !== branch) return record;
    found = true;
    previous = record;
    return { ...record, pr, review_state: reviewState };
  });
  if (found) return { records: next, previous };
  return {
    previous: null,
    records: [...records, {
      slug: branch.replace(/^feature\//, ''),
      branch,
      worktree: '',
      pr,
      review_state: reviewState,
    }],
  };
}

function failure(message: string, error?: MachineReadableError): ShipResult {
  return error === undefined ? { exitCode: EXIT_FAILURE, message } : { exitCode: EXIT_FAILURE, message, error };
}

function loadPlanning(deps: ShipDeps): { fm: FrontMatter; body: string } | null {
  if (deps.planningFile === undefined) return null;
  const text = deps.readFile(deps.planningFile);
  const front = extractPlanningFrontMatter(text);
  return { fm: parseFrontMatter(front), body: text.slice(front.length) };
}

function commitShippedTransition(deps: ShipDeps, planning: { fm: FrontMatter; body: string }): ShipResult | null {
  if (deps.planningFile === undefined) return null;
  if (planning.fm.state === 'shipped') return null;
  planning.fm.state = 'shipped';
  planning.fm.updated = deps.now();
  deps.writeFile(deps.planningFile, `${serializeFrontMatter(planning.fm)}${planning.body}`);
  const rel = path.relative(deps.repoRoot, deps.planningFile);
  deps.runGit(['add', '--', rel], deps.repoRoot);
  try {
    deps.runGit([
      'commit',
      '-q',
      '-m',
      withWorkflowPhaseTrailer(`workflow(ship-feature): shipped ${planning.fm.feature}`, 'shipped'),
    ], deps.repoRoot);
  } catch (error) {
    planning.fm.state = 'ship-failed';
    planning.fm.updated = deps.now();
    deps.writeFile(deps.planningFile, `${serializeFrontMatter(planning.fm)}${planning.body}`);
    deps.runGit(['add', '--', rel], deps.repoRoot);
    deps.runGit([
      'commit',
      '-q',
      '--no-verify',
      '-m',
      withWorkflowPhaseTrailer('workflow(ship-feature): failed', 'ship-failed'),
    ], deps.repoRoot);
    const detail = error instanceof Error ? error.message : String(error);
    return failure(`ship transition commit failed: ${detail}`);
  }
  deps.runGit(['push', 'origin', 'HEAD'], deps.repoRoot);
  return null;
}

export function ship(opts: ShipOptions, deps: ShipDeps): ShipResult {
  try {
    const planning = loadPlanning(deps);
    if (planning !== null && planning.fm.state !== 'implementation-reviewed' && planning.fm.state !== 'shipped') {
      return failure(`ship requires planning state implementation-reviewed or shipped, found ${planning.fm.state}`);
    }

    const dirty = parseDirtyPaths(deps.runGit(['status', '--porcelain', '-z'], deps.repoRoot));
    if (dirty.length > 0) return failure(`ship requires a clean tree, dirty paths: ${dirty.join(', ')}`);

    const branch = planning?.fm.branch ?? currentBranch(deps);
    deps.runGit(['push', '-u', 'origin', branch], deps.repoRoot);

    const body = opts.bodyFile === undefined ? generatedBody(branch, planning?.fm ?? null) : deps.readFile(opts.bodyFile);
    const scanHit = deps.scanPrBody(body);
    if (scanHit !== null) return failure(`PR body failed secret scan: ${scanHit}`);
    const bodyPath = writePrBody(body, deps);

    let pr = deps.gh.findPrByHead(branch);
    if (pr === null) {
      const created = deps.gh.createPr({
        base: deps.config.base_branch,
        head: branch,
        title: planning?.fm.feature ?? branch,
        bodyFile: bodyPath,
      });
      pr = { number: prNumberFromUrl(created.url), url: created.url };
    } else {
      deps.gh.editPrBody(pr.number ?? 0, bodyPath);
    }
    const prNumber = pr.number ?? prNumberFromUrl(pr.url ?? '');
    const prUrl = pr.url ?? '';

    const transitionFailure = commitShippedTransition(deps, planning ?? { fm: frontMatterFromSession(branch, deps), body: '' });
    if (transitionFailure !== null) return transitionFailure;

    const checks = opts.noCiWait === true ? [] : deps.gh.watchChecks(prNumber);
    const ci = classifyCi(checks, opts.noCiWait === true);
    const featureState = readFeatureState(deps);
    const update = updateRecord(featureState.records, branch, prNumber, ci.ci === 'red' ? 'ci_failed' : 'awaiting_human_review');
    writeFeatureState(deps, featureState, update.records);

    const event = ci.ci === 'red'
      ? 'ci_failed'
      : update.previous?.review_state === 'processing_review'
        ? 'work_finished'
        : 'ready_for_review';
    const notifyResult = deps.notify({
      event,
      repo: path.basename(deps.repoRoot),
      pr: prNumber,
      url: prUrl,
      message: ci.ci === 'red' ? `CI failed: ${ci.failed.join(', ')}` : `Ready for review: ${prUrl}`,
    });
    const notifySuffix = notifyResult.ok ? '' : `; notify failed: ${notifyResult.error ?? 'unknown notify failure'}`;

    if (ci.ci === 'red') {
      return {
        exitCode: EXIT_FAILURE,
        message: `CI failed: ${ci.failed.join(', ')}${notifySuffix}`,
        pr: prNumber,
        url: prUrl,
        ci: 'red',
        error: {
          command: 'gh pr checks --watch',
          step: 'ci-wait',
          message: `CI failed: ${ci.failed.join(', ')}`,
          stderr_tail: ci.failed.join(', '),
        },
      };
    }
    const ciMessage = ci.ci === 'none' ? 'no CI checks reported' : 'CI green';
    return { exitCode: EXIT_OK, message: `${ciMessage}${notifySuffix}`, pr: prNumber, url: prUrl, ci: ci.ci };
  } catch (error) {
    if (isGhError(error)) return failure(error.message, machineReadableGhError(error).error);
    if (isGitError(error)) return failure(error.message, machineGitError(error));
    const detail = error instanceof Error ? error.message : String(error);
    return failure(detail);
  }
}

function frontMatterFromSession(branch: string, deps: ShipDeps): FrontMatter {
  return {
    feature: branch.replace(/^feature\//, ''),
    branch,
    worktree: deps.repoRoot,
    base: deps.config.base_branch,
    base_sha: '',
    cmux_section: branch.replace(/^feature\//, ''),
    state: 'shipped',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: '',
    updated: deps.now(),
    phases: {},
    budget_spent: { total_seconds: 0 },
  };
}
