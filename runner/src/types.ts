// Reserved for Phase 3a meta-repo adoption; no validator fixture coverage yet.
export type Stack = 'node-service' | 'frontend-web' | 'n8n-ops' | 'meta-docs';
export type SchedulerClass =
  | 'github-actions-push-and-schedule'
  | 'n8n-webhook-and-schedule'
  | 'schedule-only'
  | 'local-only';
export type FilesetSource = 'git_staged' | 'repo_all';
export type CheckMode = 'blocking' | 'report-only';
export type TierName = 'staged' | 'fast' | 'full' | 'audit';

export interface Fileset {
  name: string;
  source: FilesetSource;
  include: string[];
  exclude?: string[];
  diff_filter?: string;
}

export interface Check {
  name: string;
  argv: string[];
  timeout_seconds: number;
  skip_if_empty?: string;
  mode?: CheckMode;
  baseline?: string;
  bypassable?: boolean;
  /* Child exit codes this tool uses to signal an INTERNAL/operational failure (e.g. diff-cover
     exit 2 = stale coverage) rather than a caught defect. A declared code classifies the run to
     status:'error' — unbypassable, blocks regardless of mode — so a tool malfunction never counts
     as a caught finding or slips through a bypassable check. Integers 1–255, unique. */
  operational_exit_codes?: number[];
}

export interface Workspace {
  name: string;
  path: string;
  stack: Stack;
  package_manager: 'npm' | 'pnpm' | 'yarn' | 'none';
}

/* `fileset` must be a git_staged fileset; runs only when policy.format_fix_staged_allowed is true. */
export interface FormatConfig {
  argv: string[];
  fileset: string;
  timeout_seconds: number;
}

export interface Manifest {
  version: 1;
  repo: string;
  stack: Stack;
  scheduler_class: SchedulerClass;
  budgets: {
    staged_seconds: number;
    fast_seconds: number;
    full_seconds: number;
    audit_seconds: number;
  };
  policy: {
    mutates_by_default: boolean;
    format_fix_staged_allowed: boolean;
    typed_eslint_in_precommit: boolean;
    block_new_dead_code_only: boolean;
  };
  paths: { reports: string; baselines: string };
  generated: { hooks_dir: string; ci_quality?: string };
  workspaces: Workspace[];
  filesets: Fileset[];
  tiers: {
    staged: Check[];
    fast: Check[];
    full: Check[];
    audit?: Check[];
  };
  format?: FormatConfig;
  deep_review?: {
    enabled: boolean;
    trigger?: 'manual-only';
    modes?: Array<'review-only' | 'review-and-refactor'>;
    budget?: { seconds: number; tokens?: number | null };
    verify_after_fix?: '--fast' | '--full';
    no_touch_globs_ref?: string;
    guides_dir?: string;
  };
}

export interface ValidationError {
  path: string;
  rule: string;
  message: string;
  value?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export interface CheckResult {
  name: string;
  tier: TierName;
  status: 'pass' | 'fail' | 'skipped' | 'timeout' | 'bypassed' | 'error';
  /* exitCode is null for 'error' (spawn fault or signal kill — no exit code) and 'timeout';
     it carries the child's real exit code for 'pass'/'fail'/'bypassed'. */
  exitCode: number | null;
  durationMs: number;
  mode: CheckMode;
  /* For 'bypassed': the trimmed DS_BYPASS_REASON that relaxed the finding.
     For 'error': the errno code, signal, or spawn-error message. Absent otherwise. */
  reason?: string;
}
