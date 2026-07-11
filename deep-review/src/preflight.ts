// Preflight gate (Phase 5 §5.0). Before select-worktree and every fix verb the runtime must
// confirm fix-mode is actually configured on this repo: `deep_review.enabled` is true,
// `review-and-refactor` is an allowed mode, and the review guides are AVAILABLE — the guides_dir
// holds EVERY canonical guide (the sorted `*.md` names in this repo's
// agents/review-guide-templates/). This is an availability check BY NAME, NOT "guides loaded": the
// runtime never reads a guide — the agent skill does. A partial set (the pilot's original 1/7)
// fails closed with the missing names + the seeder hint; a missing/unreadable templates dir (a
// broken checkout) fails too, rather than silently waving the gate through.
//
// A failure surfaces as EXIT_PREFLIGHT through the §2.4 MachineError channel. classify/report/
// check-path are NOT gated — the review-only path must keep working with fix-mode disabled.
// Preflight lives ONLY in the cli dispatch, never inside a verb module (so handoff.ts keeps its
// "reads no config" invariant).

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, normalize, sep } from 'node:path';
import { EXIT_PREFLIGHT } from './types.ts';
import type { MachineError } from './types.ts';
import type { DeepReviewConfig } from './config.ts';

// The verbs preflight gates. Any other verb passes through (review-only path).
const GATED_VERBS = new Set(['select-worktree', 'commit-slice', 'verify', 'handoff']);

// The canonical guide set is defined in ONE place: the `*.md` names under this repo's
// agents/review-guide-templates/. Resolved from import.meta.url so it works from BOTH execution
// points — deep-review/src/preflight.ts (tsx tests) and the bundled
// deep-review/dist/deep-review-runner.mjs — which BOTH sit at depth 2 from the repo root.
// Changing that layout breaks this resolution.
const TEMPLATES_DIR = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));

export type PreflightOutcome =
  | { ok: true }
  | { ok: false; exitCode: number; machineError: MachineError };

export interface PreflightDeps {
  // Lists directory entry names; returns [] on any error (missing/unreadable dir).
  listDir: (p: string) => string[];
  // The canonical guide set: sorted `*.md` names in agents/review-guide-templates/. Empty means the
  // templates dir is missing/unreadable (a broken checkout) -> fail closed. Default reads the real
  // templates dir; tests inject a fake set.
  listCanonicalGuides: () => string[];
}

const realPreflightDeps: PreflightDeps = {
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  listCanonicalGuides: () => {
    try {
      return readdirSync(TEMPLATES_DIR)
        .filter((name) => name.endsWith('.md'))
        .sort();
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
// guides directory (cli resolves the manifest's `guides_dir` — defaulted by loadConfig — against
// the repo root).
export function runPreflight(
  cfg: DeepReviewConfig,
  verb: string,
  guidesDirAbs: string,
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
  // Same lexical guard as the seeder (scripts/seed-review-guides.sh): guides live INSIDE the repo.
  // Judged on the RAW manifest value so the two components can never disagree on a config's legality.
  if (isAbsolute(cfg.guidesDir) || normalize(cfg.guidesDir) === '..' || normalize(cfg.guidesDir).startsWith(`..${sep}`)) {
    return fail(verb, `deep_review.guides_dir must be repo-relative and stay inside the repo root, got: ${cfg.guidesDir}`);
  }
  // Fail closed on a broken checkout: with no canonical set to compare against, "availability"
  // is undefined and the gate must not silently pass.
  const canonical = deps.listCanonicalGuides();
  if (canonical.length === 0) {
    return fail(verb, `canonical guide templates unavailable: ${TEMPLATES_DIR}`);
  }
  // Compare by NAME via listDir (never read content — "availability, not loaded"). The dirent type
  // is irrelevant; a matching name is present.
  const present = new Set(deps.listDir(guidesDirAbs));
  const missing = canonical.filter((name) => !present.has(name));
  if (missing.length > 0) {
    return fail(
      verb,
      `review guides are incomplete: ${guidesDirAbs} is missing ${missing.join(', ')} ` +
        '(run vendor/dev-standards/scripts/seed-review-guides.sh . to seed them)',
    );
  }
  return { ok: true };
}
