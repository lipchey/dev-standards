// Core types for the workflow helper state machine (Phase 3, ADR-012).
// Zero runtime dependencies (ADR-006); pure data + type declarations. The
// transition table and seat map that wire these together live in
// ./transitions.ts.

// §2.1 state set. The runtime array is the single source of truth; the
// WorkflowState union is derived from it so the two can never drift, and the
// import-time table assertion (./transitions.ts) checks membership against it.
// Failure-state names are the literal §2.2 table values, not a mechanical
// `<phase>-failed` derivation.
export const WORKFLOW_STATES = [
  // Main-line (ordered).
  'created',
  'plan-inprogress',
  'plan-ready',
  'review-plan-inprogress',
  'plan-reviewed',
  'consolidate-inprogress',
  'plan-consolidated',
  'implement-inprogress',
  'implemented',
  'review-impl-inprogress',
  'implementation-reviewed',
  'shipped',
  // Side states.
  'plan-changes-requested',
  'impl-changes-requested',
  // Special.
  'needs-human',
  // Failure states (literal names).
  'new-feature-failed',
  'plan-failed',
  'review-plan-failed',
  'consolidate-failed',
  'implement-failed',
  'review-impl-failed',
  'ship-failed',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

// §2.2 transition-table phases. `process-review` is a documented NON-table
// phase (Claude, human-triggered) with no row and no gate; it is deliberately
// absent here and excluded from the pinned seat map. The runtime array is the
// source of truth; the union is derived from it (same pattern as WORKFLOW_STATES)
// so the front-matter validator can check phase keys against it at runtime.
export const WORKFLOW_PHASES = [
  'new-feature',
  'plan',
  'review-plan',
  'consolidate-plan',
  'implement-plan',
  'review-implementation',
  'ship-feature',
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

// §2.3 model seats (ADR-008).
export type Seat = 'human+helper' | 'Claude' | 'Codex' | 'helper';

// §2.1 needs_human_reason vocabulary (ADR-012 removed merge-blocked/conflict).
// Runtime array is the source of truth; the union is derived so the front-matter
// validator can check `needs_human_reason` membership at runtime.
export const NEEDS_HUMAN_REASONS = [
  'loopback-cap',
  'budget-exhausted',
  'guide-missing',
  'corrupt-state',
] as const;

export type NeedsHumanReason = (typeof NEEDS_HUMAN_REASONS)[number];

// §2.7 exit-code contract. Pinned as named constants so call sites read by name.
export const EXIT_OK = 0;
export const EXIT_ALREADY_DONE = 10;
export const EXIT_WRONG_STATE = 11;
export const EXIT_TIMEOUT = 12;
export const EXIT_NEEDS_HUMAN = 13;
export const EXIT_LOCK_BUSY = 14;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

// §2.4 feature record (front matter of `.agents/handoffs/STATE.md`).
export interface FeatureRecord {
  slug: string;
  branch: string;
  worktree: string;
  pr: number;
  review_state:
    | ''
    | 'building'
    | 'awaiting_human_review'
    | 'processing_review'
    | 'ci_failed'
    | 'done';
}

// §2.8 workflow config shape; the `{ enabled: false }` minimal form is also
// valid config (hence `enabled: boolean`). The Phase-1 runner declares its own
// independent copy of this shape on Manifest.workflow (serialization boundary);
// this is the workflow module's authoritative version.
export interface WorkflowConfig {
  schema: 1;
  enabled: boolean;
  base_branch: string;
  worktree_parent: string;
  cmux_mode: 'manual' | 'auto';
  loopback_mode: 'manual' | 'auto';
  reviewer_independence: 'different-runtime' | 'same-runtime';
  required_review_guides: string[];
  commit_exclude: string[];
  archive: boolean;
  timeouts: { default_wait_seconds: number; default_work_seconds: number };
  budget: { workflow_total_seconds: number };
  agents: { claude: string[]; codex: string[] };
  ship: { ci_wait_seconds: number; notify: boolean };
  notify: { webhook_env: string };
}

// §2.11 / spec §3 planning-file front matter, reconciled with the plan: `state`
// is a §2.1 WorkflowState; `needs_human_reason` is a §2.1 NeedsHumanReason;
// `merge_waiver` and every merge field are dropped (ADR-012). This is the
// native-typed view consumed by the gate/transactions/status code; the strict
// YAML-subset parser/serializer in ./front-matter.ts maps it to/from disk.
// `auto_advanced` is the §2.9 conditional-consolidate marker (boolean), the one
// boolean the subset carries; `reason` is a §2.11/§2.12 quoted single-line
// scalar (ASCII, <=200, no control chars), not a YAML block scalar.
export interface PhaseRecord {
  last_success_loop: number | null;
  attempts: number;
  start_sha: string | null;
  complete_sha: string | null;
  auto_advanced?: boolean; // present only when the consolidate phase auto-advanced
}

export interface ForcedAction {
  phase: WorkflowPhase;
  loop: number;
  from_state: WorkflowState;
  reason: string;
  at: string; // ISO-8601 UTC timestamp
  claimed_by: string;
}

export interface FrontMatter {
  feature: string;
  branch: string;
  worktree: string;
  base: string;
  base_sha: string;
  cmux_section: string;
  state: WorkflowState;
  loopback_count: number;
  loopback_cap: number;
  claimed_by: string;
  updated: string; // ISO-8601 UTC timestamp
  // Keyed by WorkflowPhase; empty when no phase has been recorded yet. An empty
  // map is OMITTED on the wire because the subset has no block form for `{}`.
  phases: Partial<Record<WorkflowPhase, PhaseRecord>>;
  budget_spent: { total_seconds: number };
  needs_human_reason?: NeedsHumanReason; // present only at needs-human
  forced_actions?: ForcedAction[]; // present only when a forced action occurred
}
