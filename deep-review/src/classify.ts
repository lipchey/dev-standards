// Finding classifier (§2.3): assigns each finding a routing `classification` and
// the `status` that opens its lifecycle, applying the precedence
//   no-touch → needs-plan → fixable-now.
//
// SAFETY (engine-introduced, flagged for review): a finding whose `file` is in
// the §2.5 no-touch set is recorded as `classification: "no-touch"` even when
// `needs_plan` is true. A no-touch path is ALWAYS emitted as a plan, never
// autonomously planned-then-edited, so no-touch WINS over needs-plan here — it is
// not "downgraded" to needs-plan. This precedence is deliberate; do not simplify
// it away.
//
// `classifyFinding` is a total function of (finding, isNoTouchFn). `classifyAll`
// re-derives every NON-protected finding idempotently and resets `infra-blocked`
// to `pending` (the retry path); a PROTECTED status (a landed fix, a red-test
// failure, an unsafe-path rejection) is a verdict and is never re-derived.
// `classifyAndBind` wraps classify + the unbound→bound transition in ONE CAS write.

import type { Classification, FindingRecord, FindingStatus, FindingsFileV2 } from './types.ts';
import { PROTECTED_STATUSES } from './types.ts';
import { isNoTouch } from './no-touch.ts';
import { mutateFindings } from './findings-io.ts';
import type { MutateFindingsDeps } from './findings-io.ts';

// Routes a single finding. Precedence: no-touch (wins, even over needs_plan) →
// needs-plan → fixable-now. The `isNoTouchFn` seam is the only effectful input,
// injected so the rule is unit-testable without the glob set.
export function classifyFinding(
  finding: FindingRecord,
  isNoTouchFn: (relPath: string) => boolean,
): { classification: Classification; status: FindingStatus } {
  // No-touch wins when finding.file OR ANY slice_files entry is no-touch, so this
  // routing matches the commit-slice enforcement gate (which refuses a slice that
  // touches a no-touch path even when finding.file is editable). Defense in depth:
  // a finding that would be REFUSED at commit time is never routed as fixable-now.
  if (isNoTouchFn(finding.file) || finding.slice_files.some((p) => isNoTouchFn(p))) {
    return { classification: 'no-touch', status: 'no-touch' };
  }
  if (finding.needs_plan === true) {
    return { classification: 'needs-plan', status: 'needs-plan' };
  }
  return { classification: 'fixable-now', status: 'pending' };
}

// Classifies every finding against the §2.5 no-touch `set`. A PROTECTED status
// (`fixed`/`fix-failed`/`invalid`) is a verdict and is carried forward untouched;
// every other finding is re-derived idempotently, which also resets an
// `infra-blocked` finding back to `pending` (a retry) and drops its stale
// `infra_error`. A new file object is returned (input not mutated).
export function classifyAll(findingsFile: FindingsFileV2, set: string[]): FindingsFileV2 {
  const isNoTouchFn = (relPath: string): boolean => isNoTouch(relPath, set);
  const findings = findingsFile.findings.map((finding): FindingRecord => {
    if (PROTECTED_STATUSES.includes(finding.status)) return finding;
    const { classification, status } = classifyFinding(finding, isNoTouchFn);
    // A re-derived finding (incl. a reset infra-blocked) leaves infra-blocked, so
    // its infra_error no longer applies — drop it.
    const { infra_error: _cleared, ...rest } = finding;
    return { ...rest, classification, status };
  });
  return { ...findingsFile, findings };
}

// The confinement root + the run descriptor the classify verb needs. A structural
// subset of the vertical's DeepReviewContext (W2), so the CLI can pass that ctx
// straight through.
export interface ClassifyContext {
  reportsRootAbs: string;
  descriptor: { run_id: string; base_sha: string } | null;
}

// Classifies AND binds in one CAS write (the sole findings mutator). When the file
// is an unbound draft (`run_id === null`) and cwd is a run worktree (a descriptor
// is present), the run_id + base_sha are pinned in the SAME write — closing the
// gap where an unbound file had no path to a verified run. review-only (no
// descriptor) stays unbound.
export function classifyAndBind(
  findingsPath: string,
  ctx: ClassifyContext,
  set: string[],
  deps?: MutateFindingsDeps,
): FindingsFileV2 {
  return mutateFindings(
    findingsPath,
    ctx,
    (file) => {
      const classified = classifyAll(file, set);
      if (classified.run_id === null && ctx.descriptor !== null) {
        return {
          ...classified,
          run_id: ctx.descriptor.run_id,
          base_sha: ctx.descriptor.base_sha,
        };
      }
      return classified;
    },
    deps,
  );
}
