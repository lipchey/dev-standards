// Deep-review config loader. REUSES the runner's exported `loadManifest`
// (runner/src/manifest.ts) — the single, audited parse + validate path for the
// quality manifest — rather than re-parsing the manifest here. The `deep_review`
// block is validated transitively inside `loadManifest` (validate.ts), so this
// module only projects the already-validated manifest onto the slice the engine
// needs.

import { loadManifest } from '../../runner/src/manifest.ts';

// The default run budget when the manifest omits `deep_review.budget` (§0: deadline defaults to
// 900s). Applied here so downstream (cli deadline creation) reads a single always-present value.
const DEFAULT_BUDGET_SECONDS = 900;

// The engine view of the manifest: the `deep_review` fields the runtime actually uses, projected
// off the validated manifest (schema-validated but previously dropped — 5.0). `enabled`/`modes`
// gate preflight; `budget` seeds the deadline; `guidesDir` is the preflight availability check;
// `noTouchGlobsRef`/`verifyAfterFix` feed the no-touch set and verify scope. `tiers` stay dropped
// (no named-check resolver in this phase — YAGNI while there is one consumer).
export interface DeepReviewConfig {
  enabled: boolean;
  modes: Array<'review-only' | 'review-and-refactor'>;
  budget: { seconds: number; tokens?: number | null };
  guidesDir: string;
  noTouchGlobsRef: string | undefined;
  verifyAfterFix: '--fast' | '--full' | undefined;
  reportsDir: string;
}

export function loadConfig(filePath: string): DeepReviewConfig {
  const result = loadManifest(filePath);
  if (!result.ok) {
    const detail = result.errors.map((error) => `${error.path || '<root>'}: ${error.message}`).join('; ');
    throw new Error(`manifest at ${filePath} is invalid: ${detail}`);
  }
  const deepReview = result.manifest.deep_review;
  return {
    enabled: deepReview?.enabled ?? false,
    modes: deepReview?.modes ?? [],
    budget: deepReview?.budget ?? { seconds: DEFAULT_BUDGET_SECONDS },
    // Defaulted HERE so seeder, skill body and engine can never disagree on where guides live.
    guidesDir: deepReview?.guides_dir ?? '.agents/review-guides',
    noTouchGlobsRef: deepReview?.no_touch_globs_ref,
    verifyAfterFix: deepReview?.verify_after_fix,
    reportsDir: result.manifest.paths.reports,
  };
}
