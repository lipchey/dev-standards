import fs from 'node:fs';
import path from 'node:path';
import { addOrReplaceFeatureRecord, defaultFeatureBranch, defaultFeatureWorktree, readFeatureRecords, writeFeatureRecords } from './feature-record.ts';
import { parseSubset, serializeFrontMatter, serializeSubset } from './front-matter.ts';
import type { FeatureRecord, FrontMatter, WorkflowConfig } from './types.ts';
import type { RunGit } from './trailers.ts';
import { withWorkflowPhaseTrailer } from './trailers.ts';
import type { CmuxAdapter, CmuxSectionSpec, PaneAgent } from './cmux-adapter.ts';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export class SlugError extends Error {
  readonly input: string;
  constructor(input: string) {
    super(`invalid feature slug: ${JSON.stringify(input)}`);
    this.name = 'SlugError';
    this.input = input;
    Object.setPrototypeOf(this, SlugError.prototype);
  }
}

export function sanitizeFeatureSlug(input: string): string {
  if (!SLUG_RE.test(input)) throw new SlugError(input);
  if (input.includes('..') || input.includes('/') || input.includes('\\') || input.includes('\0')) {
    throw new SlugError(input);
  }
  return input;
}

export interface FeatureStartOptions {
  slug: string;
  branch?: string;
  worktree?: boolean;
}

export interface NewFeatureDeps {
  repoRoot: string;
  statePath: string;
  config: WorkflowConfig;
  runGit: RunGit;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  mkdir: (dirPath: string) => void;
  cmux?: CmuxAdapter;
  workflowCommand?: string;
}

export interface FeatureStartResult {
  slug: string;
  branch: string;
  worktree: string;
  planningFile?: string;
  cmux?: {
    armed: boolean;
    paneIds: string[];
    instructions: string;
    error?: string;
  };
}

interface PreparedFeatureStart {
  slug: string;
  branch: string;
  worktree: string;
  state: ReturnType<typeof readStateDoc>;
  doc: ReturnType<typeof parseSubset>;
  records: FeatureRecord[];
}

function safeBranch(branch: string): void {
  if (!branch.startsWith('feature/') || branch.startsWith('-') || branch.includes(':') || /\s|[\x00-\x1f\x7f]/.test(branch)) {
    throw new Error(`unsafe feature branch ${JSON.stringify(branch)}`);
  }
}

function resolveParent(repoRoot: string, config: WorkflowConfig): string {
  return path.resolve(repoRoot, config.worktree_parent);
}

function assertGuideFiles(deps: NewFeatureDeps): void {
  const missing = deps.config.required_review_guides.filter((guide) => !fs.existsSync(path.resolve(deps.repoRoot, guide)));
  if (missing.length > 0) throw new Error(`missing required review guide(s): ${missing.join(', ')}`);
}

function readStateDoc(deps: NewFeatureDeps): { frontText: string; body: string } {
  let text: string;
  try {
    text = deps.readFile(deps.statePath);
  } catch {
    text = '---\n---\n\n# Handoff State\n';
  }
  const lines = text.split('\n');
  if (lines[0] !== '---') return { frontText: '---\n---\n', body: text };
  const close = lines.findIndex((line, idx) => idx > 0 && line === '---');
  if (close < 0) return { frontText: '---\n---\n', body: text };
  return {
    frontText: `${lines.slice(0, close + 1).join('\n')}\n`,
    body: lines.slice(close + 1).join('\n'),
  };
}

function readRecordState(deps: NewFeatureDeps): { state: ReturnType<typeof readStateDoc>; doc: ReturnType<typeof parseSubset>; records: FeatureRecord[] } {
  const state = readStateDoc(deps);
  const doc = parseSubset(state.frontText);
  return { state, doc, records: readFeatureRecords(doc) };
}

function writeRecords(deps: NewFeatureDeps, state: ReturnType<typeof readStateDoc>, doc: ReturnType<typeof parseSubset>, records: FeatureRecord[]): void {
  writeFeatureRecords(doc, records);
  deps.mkdir(path.dirname(deps.statePath));
  deps.writeFile(deps.statePath, serializeSubset(doc) + state.body);
}

function makePlanning(slug: string, branch: string, worktree: string, deps: NewFeatureDeps): string {
  const fm: FrontMatter = {
    feature: slug,
    branch,
    worktree,
    base: deps.config.base_branch,
    base_sha: deps.runGit(['rev-parse', deps.config.base_branch], deps.repoRoot).trim(),
    cmux_section: slug,
    state: 'created',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: '',
    updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    phases: {},
    budget_spent: { total_seconds: 0 },
  };
  return `${serializeFrontMatter(fm)}\n# Plan\n\n`;
}

function createBranch(deps: NewFeatureDeps, branch: string, worktree: string): void {
  if (worktree === '') deps.runGit(['switch', '-c', branch], deps.repoRoot);
  else {
    deps.mkdir(path.dirname(worktree));
    deps.runGit(['worktree', 'add', '-b', branch, worktree, deps.config.base_branch], deps.repoRoot);
  }
}

function prepareFeatureStart(opts: FeatureStartOptions, deps: NewFeatureDeps): PreparedFeatureStart {
  const slug = sanitizeFeatureSlug(opts.slug);
  const branch = opts.branch ?? defaultFeatureBranch(slug);
  safeBranch(branch);
  assertGuideFiles(deps);
  const parent = resolveParent(deps.repoRoot, deps.config);
  const worktree = opts.worktree === true ? defaultFeatureWorktree(parent, slug) : '';
  if (worktree !== '') {
    const resolved = path.resolve(worktree);
    const resolvedParent = path.resolve(parent);
    if (resolved !== resolvedParent && !resolved.startsWith(`${resolvedParent}${path.sep}`)) {
      throw new Error(`worktree escapes configured parent: ${worktree}`);
    }
  }
  const state = readRecordState(deps);
  const next = addOrReplaceFeatureRecord(state.records, { slug, branch, worktree, pr: 0, review_state: 'building' });
  deps.runGit(['check-ref-format', '--branch', branch], deps.repoRoot);
  return { slug, branch, worktree, state: state.state, doc: state.doc, records: next };
}

function rollbackBranchAndWorktree(deps: NewFeatureDeps, branch: string, worktree: string): void {
  if (worktree !== '') {
    try {
      deps.runGit(['worktree', 'remove', '--force', worktree], deps.repoRoot);
    } catch {
      // Preserve the original failure.
    }
  }
  try {
    deps.runGit(['branch', '-D', branch], deps.repoRoot);
  } catch {
    // Preserve the original failure.
  }
}

export function buildPipelineSpec(
  slug: string,
  worktree: string,
  planningFile: string,
  workflowCommand = 'workflow',
): CmuxSectionSpec {
  const phasePanes: Array<{ phase: string; agent: PaneAgent }> = [
    { phase: 'plan', agent: 'claude' },
    { phase: 'review-plan', agent: 'codex' },
    { phase: 'consolidate-plan', agent: 'claude' },
    { phase: 'implement-plan', agent: 'claude' },
    { phase: 'review-implementation', agent: 'codex' },
    { phase: 'ship-feature', agent: 'helper' },
  ];
  return {
    section: slug,
    worktree,
    panes: phasePanes.map(({ phase, agent }) => ({
      pane_id: phase,
      cwd: worktree,
      agent,
      command: [workflowCommand, 'await-and-launch', phase, '--file', planningFile],
    })),
  };
}

function armPipeline(slug: string, worktree: string, planningFile: string, deps: NewFeatureDeps): FeatureStartResult['cmux'] {
  if (deps.cmux === undefined) return undefined;
  try {
    const result = deps.cmux.launch(buildPipelineSpec(slug, worktree, planningFile, deps.workflowCommand));
    const cmux: NonNullable<FeatureStartResult['cmux']> = {
      armed: result.ok,
      paneIds: result.paneIds,
      instructions: result.instructions,
    };
    if (result.error !== undefined) cmux.error = result.error;
    return cmux;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      armed: false,
      paneIds: [],
      instructions: `copy-paste required: cmux arming failed (${detail})\n`,
      error: detail,
    };
  }
}

export function featureStart(opts: FeatureStartOptions, deps: NewFeatureDeps): FeatureStartResult {
  const prepared = prepareFeatureStart(opts, deps);
  const { slug, branch, worktree } = prepared;
  createBranch(deps, branch, worktree);
  writeRecords(deps, prepared.state, prepared.doc, prepared.records);
  return { slug, branch, worktree };
}

export function newFeature(slugInput: string, deps: NewFeatureDeps): FeatureStartResult {
  const slug = sanitizeFeatureSlug(slugInput);
  const prepared = prepareFeatureStart({
    slug,
    branch: defaultFeatureBranch(slug),
    worktree: true,
  }, deps);
  const { branch, worktree } = prepared;
  createBranch(deps, branch, worktree);
  const planningFile = path.join(worktree, 'workflow-session-planning.md');
  try {
    deps.writeFile(planningFile, makePlanning(slug, branch, worktree, deps));
    deps.runGit(['add', '--', 'workflow-session-planning.md'], worktree);
    deps.runGit(['commit', '-q', '-m', withWorkflowPhaseTrailer(`workflow(new-feature): created ${slug}`, 'created')], worktree);
    writeRecords(deps, prepared.state, prepared.doc, prepared.records);
    const result: FeatureStartResult = { slug, branch, worktree, planningFile };
    const cmux = armPipeline(slug, worktree, planningFile, deps);
    if (cmux !== undefined) result.cmux = cmux;
    return result;
  } catch (error) {
    rollbackBranchAndWorktree(deps, branch, worktree);
    throw error;
  }
}
