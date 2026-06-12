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
// absent here and excluded from the pinned seat map.
export type WorkflowPhase =
  | 'new-feature'
  | 'plan'
  | 'review-plan'
  | 'consolidate-plan'
  | 'implement-plan'
  | 'review-implementation'
  | 'ship-feature';

// §2.3 model seats (ADR-008).
export type Seat = 'human+helper' | 'Claude' | 'Codex' | 'helper';

// §2.1 needs_human_reason vocabulary (ADR-012 removed merge-blocked/conflict).
export type NeedsHumanReason =
  | 'loopback-cap'
  | 'budget-exhausted'
  | 'guide-missing'
  | 'corrupt-state';

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
