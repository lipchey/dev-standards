// Core types for the deep-review engine (ADR-007). This is a standalone top-level
// helper module alongside the frozen runner/, built to its own esbuild bundle (S22)
// and invoked only by the `deep-review-refactor` skill — never autonomously. Zero
// runtime dependencies; pure data + type declarations.
//
// The exit-code subset and machine-readable error shape are declared LOCALLY, not
// imported. They are a serialization boundary deep-review owns independently (it must
// not depend on the runner's internal types), mirroring the runner's own pattern of
// declaring its own copy of a shared shape rather than sharing a type across modules.

// §2.7 exit-code subset this engine uses. The numeric values MIRROR the shared
// launcher exit-code contract so a shared launcher reads the same contract.
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_WRONG_STATE = 11;
export const EXIT_NEEDS_HUMAN = 13;

// The §2.4 machine-readable error payload emitted as the last line of stderr on a
// tool/git/network failure.
// `step` is optional and OMITTED (never set to `undefined`) when unknown, under
// exactOptionalPropertyTypes. Declared locally, not imported (serialization
// boundary; deep-review owns this boundary independently).
export interface MachineError {
  command: string;
  step?: string;
  message: string;
  stderr_tail: string;
}

export type Severity = 'P1' | 'P2' | 'P3';
export type Classification = 'fixable-now' | 'no-touch' | 'needs-plan';
export type FindingStatus =
  | 'pending'
  | 'fixed'
  | 'fix-failed'
  | 'no-touch'
  | 'needs-plan'
  | 'invalid';

export interface FindingRecord {
  id: string;
  severity: Severity;
  file: string;
  line: number;
  title: string;
  impact: string;
  needs_plan: boolean;
  test_cmd: string[];
  slice_files: string[];
  classification: Classification | '';
  status: FindingStatus;
  sha: string;
}

export interface FindingsFile {
  schema: 1;
  mode: 'review-only' | 'review-and-refactor';
  generated_at: string;
  findings: FindingRecord[];
}
