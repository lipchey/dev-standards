import type { FrontMatter, WorkflowPhase } from './types.ts';
import { excludePathspecs } from './commit-scope.ts';

export interface DiffRangeOptions {
  planningFile?: string;
  reportsGlob?: string;
  commitExclude?: string[];
}

export interface DiffRangeResult {
  range: string;
  argv: string[];
}

export function diffRangeForPhase(
  phase: WorkflowPhase,
  fm: FrontMatter,
  options: DiffRangeOptions = {},
): DiffRangeResult {
  const planningFile = options.planningFile ?? 'workflow-session-planning.md';
  const reportsGlob = options.reportsGlob ?? 'reports/**';
  const commitExclude = options.commitExclude ?? [];
  const range = `${fm.base_sha}..HEAD`;
  return {
    range,
    argv: [
      'diff',
      '--name-only',
      range,
      '--',
      '.',
      `:(exclude)${planningFile}`,
      `:(exclude)${reportsGlob}`,
      ...excludePathspecs(commitExclude),
    ],
  };
}
