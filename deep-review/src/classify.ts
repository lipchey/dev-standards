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
// Pure: `classifyFinding` is a total function of (finding, isNoTouchFn);
// `classifyAll` builds the no-touch predicate from the engine's set and maps it
// over the file, skipping any finding findings-io already marked `invalid`.

import type { Classification, FindingRecord, FindingStatus, FindingsFile } from './types.ts';
import { isNoTouch } from './no-touch.ts';

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

// Classifies every finding in the file against the §2.5 no-touch `set`. A finding
// already `status: "invalid"` (an unsafe path localized by findings-io) is left
// untouched — its `status` and `classification` carry that verdict forward. All
// other fields are preserved; a new file object is returned (input not mutated).
export function classifyAll(findingsFile: FindingsFile, set: string[]): FindingsFile {
  const isNoTouchFn = (relPath: string): boolean => isNoTouch(relPath, set);
  const findings = findingsFile.findings.map((finding): FindingRecord => {
    if (finding.status === 'invalid') return finding;
    const { classification, status } = classifyFinding(finding, isNoTouchFn);
    return { ...finding, classification, status };
  });
  return { ...findingsFile, findings };
}
