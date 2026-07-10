// Preflight gate (Phase 5 §5.0). Before select-worktree and every fix verb the runtime must
// confirm fix-mode is actually configured on this repo: `deep_review.enabled` is true,
// `review-and-refactor` is an allowed mode, and the review guides are AVAILABLE (the guides_dir
// exists and holds at least one `.md`). This is an availability check, NOT "guides loaded": the
// runtime never reads a guide — the agent skill does — so the honest name for the roadmap's
// "guides loaded" precondition is "the guides directory is present and non-empty".
//
// A failure surfaces as EXIT_PREFLIGHT through the existing §2.4 MachineError channel (the caller
// emits `{error}` as the last stderr line). classify/report/check-path are NOT gated — the
// review-only path must keep working with fix-mode disabled. Preflight lives ONLY in the cli
// dispatch, never inside a verb module (so handoff.ts keeps its "reads no config" invariant).

import { existsSync, readdirSync } from 'node:fs';
import { EXIT_PREFLIGHT } from './types.ts';
import type { MachineError } from './types.ts';
import type { DeepReviewConfig } from './config.ts';

// The verbs preflight gates. Any other verb passes through (review-only path).
const GATED_VERBS = new Set(['select-worktree', 'commit-slice', 'verify', 'handoff']);

export type PreflightOutcome =
  | { ok: true }
  | { ok: false; exitCode: number; machineError: MachineError };

export interface PreflightDeps {
  exists: (p: string) => boolean;
  // Lists directory entry names; returns [] on any error (missing/unreadable dir).
  listDir: (p: string) => string[];
}

const realPreflightDeps: PreflightDeps = {
  exists: (p) => existsSync(p),
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

function fail(verb: string, message: string): PreflightOutcome {
  return {
    ok: false,
    exitCode: EXIT_PREFLIGHT,
    machineError: { command: `deep-review ${verb}`, message, stderr_tail: '' },
  };
}

// Runs the fix-mode availability preflight for `verb`. `guidesDirAbs` is the resolved absolute
// guides directory (cli resolves the manifest's relative `guides_dir` against the repo root), or
// undefined when the manifest omits it.
export function runPreflight(
  cfg: DeepReviewConfig,
  verb: string,
  guidesDirAbs: string | undefined,
  over?: Partial<PreflightDeps>,
): PreflightOutcome {
  if (!GATED_VERBS.has(verb)) return { ok: true };
  const deps = over === undefined ? realPreflightDeps : { ...realPreflightDeps, ...over };

  if (cfg.enabled !== true) {
    return fail(verb, 'deep-review is disabled: set deep_review.enabled to true in quality.json to run fix-mode verbs');
  }
  if (!cfg.modes.includes('review-and-refactor')) {
    return fail(verb, 'fix mode is not allowed: add "review-and-refactor" to deep_review.modes in quality.json');
  }
  if (guidesDirAbs === undefined) {
    return fail(verb, 'review guides are unavailable: deep_review.guides_dir is not configured in quality.json');
  }
  if (!deps.exists(guidesDirAbs) || !deps.listDir(guidesDirAbs).some((entry) => entry.endsWith('.md'))) {
    return fail(
      verb,
      `review guides are unavailable: ${guidesDirAbs} must exist and contain at least one .md guide`,
    );
  }
  return { ok: true };
}
