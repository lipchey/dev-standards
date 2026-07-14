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

/* Phase-5 fix-mode exit codes. Fixed numeric contract shared across the engine's
   verbs: preflight refusal, run-identity mismatch, a live findings-lock contention,
   and a fail-closed unavailable secret scanner. W2/W4 import these names; the
   numbers must not drift (17 is left unallocated — a deadline overrun surfaces as an
   ordinary timeout, see deadline.ts). */
export const EXIT_PREFLIGHT = 14;
export const EXIT_DESCRIPTOR_MISMATCH = 15;
export const EXIT_FINDINGS_CONFLICT = 16;
export const EXIT_SCANNER_UNAVAILABLE = 18;

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

// The result of a secret scan over the rendered report body (W2 produces it in
// secret-scan.ts; W1/W4 consume it). `clean` lets the write proceed, `hit` aborts
// as a finding, `unavailable` aborts fail-closed (the scanner could not run). This
// is a serialization boundary declared HERE (not imported from secret-scan.ts) so
// the producer and the consumers agree on one shape.
export type SecretScanResult =
  | { status: 'clean' }
  | { status: 'hit'; findings: string }
  | { status: 'unavailable'; reason: string };

type Severity = 'P1' | 'P2' | 'P3';
export type Classification = 'fixable-now' | 'no-touch' | 'needs-plan';

// The per-finding test reference. `test_cmd` (an arbitrary argv) was removed in
// schema v2: a finding names ONE of the two managed verify scopes, never a raw
// command. Named checks (`check:<tier>/<name>`) are deliberately out of scope here.
export type TestRef = 'verify:fast' | 'verify:full';

export type FindingStatus =
  | 'pending'
  | 'fixed'
  | 'fix-failed'
  | 'no-touch'
  | 'needs-plan'
  | 'invalid'
  | 'infra-blocked';

// Statuses classify must NEVER re-derive: a landed fix, a red-test failure, and an
// unsafe-path rejection are verdicts, not routing hints. `pending`/`no-touch`/
// `needs-plan` are re-derived idempotently and `infra-blocked` resets to pending
// (a retry path) — none of those are protected.
export const PROTECTED_STATUSES: readonly FindingStatus[] = ['fixed', 'fix-failed', 'invalid'];

// Statuses that BLOCK handoff and turn on the report's INCOMPLETE marker. A
// finding still `pending` (not attempted) or `infra-blocked` (attempt hit an
// operational failure) is not terminal. The resolved dispositions
// (`no-touch`/`needs-plan`/`invalid`) do NOT block — handoff hands them to a human
// as a list — so they are excluded here to avoid a designed deadlock.
export const HANDOFF_BLOCKING_STATUSES: readonly FindingStatus[] = ['pending', 'infra-blocked'];

export interface FindingRecord {
  id: string;
  severity: Severity;
  file: string;
  line: number;
  title: string;
  impact: string;
  needs_plan: boolean;
  test_ref: TestRef;
  slice_files: string[];
  classification: Classification | '';
  status: FindingStatus;
  // The slice commit SHA; only a `fixed` finding carries one, otherwise ''.
  sha: string;
  // Present ONLY on an `infra-blocked` finding (an operational failure of the fix
  // attempt: spawn error, missing shim, timeout, deadline). Omitted otherwise.
  infra_error?: string;
}

// A verify run's record. Written ONLY by the verify verb on a green run; any later
// slice commit invalidates it (the commit nulls it in the same write).
export interface VerificationRecord {
  sha: string;
  scope: TestRef;
  completed_at: string;
}

// The findings file, schema v2. `mode`/`generated_at` are carried forward from v1
// (slice/report/handoff still read them). `run_id`+`base_sha` are either BOTH null
// (an unbound draft) or BOTH set (bound to a run, immutable thereafter). `revision`
// is a monotonic counter bumped inside the single mutator.
export interface FindingsFileV2 {
  schema: 2;
  mode: 'review-only' | 'review-and-refactor';
  generated_at: string;
  run_id: string | null;
  base_sha: string | null;
  revision: number;
  verification: VerificationRecord | null;
  findings: FindingRecord[];
}
