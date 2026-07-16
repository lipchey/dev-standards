/* Fix-mode verbs require an enabled mode and an available package guide set. */

import { loadReviewGuides } from './guides.ts';
import type { LoadedReviewGuide, ReviewGuideLoadOutcome } from './guides.ts';
import { assertGuidesDirConfined, GuidesUnavailable } from './guides-read.ts';
import { EXIT_PREFLIGHT } from './types.ts';
import type { MachineError } from './types.ts';
import type { DeepReviewConfig } from './config.ts';

const GATED_VERBS = new Set(['select-worktree', 'commit-slice', 'self-review', 'verify', 'handoff']);

export type PreflightOutcome =
  | { ok: true; guides: LoadedReviewGuide[] }
  | { ok: false; exitCode: number; machineError: MachineError };

export interface PreflightDeps {
  loadGuides: (overlayDirectory: string) => ReviewGuideLoadOutcome;
}

const realPreflightDeps: PreflightDeps = {
  loadGuides: (overlayDirectory) => loadReviewGuides(overlayDirectory),
};

function fail(verb: string, message: string): PreflightOutcome {
  return {
    ok: false,
    exitCode: EXIT_PREFLIGHT,
    machineError: { command: `deep-review ${verb}`, message, stderr_tail: '' },
  };
}

export function runPreflight(
  config: DeepReviewConfig,
  verb: string,
  cwd: string,
  overrides?: Partial<PreflightDeps>,
): PreflightOutcome {
  if (!GATED_VERBS.has(verb)) return { ok: true, guides: [] };
  const deps = overrides === undefined ? realPreflightDeps : { ...realPreflightDeps, ...overrides };

  if (config.enabled !== true) {
    return fail(verb, 'deep-review is disabled: set deep_review.enabled to true in quality.json to run fix-mode verbs');
  }
  if (!config.modes.includes('review-and-refactor')) {
    return fail(verb, 'fix mode is not allowed: add "review-and-refactor" to deep_review.modes in quality.json');
  }

  /* The SAME confinement the Stop-gate applies (assertGuidesDirConfined) — lexical + reject any
     symlink component, fail-closed — computed from cwd so this file-editing verb is never weaker
     than the gate (the pre-hardening lexical-only check let an in-repo symlink escaping the repo
     through). */
  let overlayDirectory: string;
  try {
    overlayDirectory = assertGuidesDirConfined(cwd, config.guidesDir);
  } catch (error) {
    if (error instanceof GuidesUnavailable) return fail(verb, error.message);
    throw error;
  }

  const guideLoad = deps.loadGuides(overlayDirectory);
  if (!guideLoad.ok) {
    return fail(
      verb,
      guideLoad.reason ?? `canonical guide templates unavailable: ${guideLoad.templatesDir}`,
    );
  }
  return { ok: true, guides: guideLoad.guides };
}
