// Deep-review config loader. REUSES the runner's exported `loadManifest`
// (runner/src/manifest.ts) — the single, audited parse + validate path for the
// quality manifest — rather than re-parsing the manifest here. The `deep_review`
// block is validated transitively inside `loadManifest` (validate.ts), so this
// module only projects the already-validated manifest onto the slice the engine
// needs.

import path from 'node:path';
import { loadManifest } from '../../runner/src/manifest.ts';

// The default run budget when the manifest omits `deep_review.budget` (§0: deadline defaults to
// 900s). Applied here so downstream (cli deadline creation) reads a single always-present value.
const DEFAULT_BUDGET_SECONDS = 900;

// verify_entry is spawned as path.join(cwd, entry) AND is protected as no-touch by
// canonical repo-relative slash-path matching; an absolute, backslash-bearing, or
// `..`-escaping value would spawn a binary outside the worktree and/or slip the no-touch
// match (a `..\` / `C:\` value normalizes differently under path.win32 than the posix
// slice paths the matcher compares against). The manifest schema only shape-checks
// (non-empty string, mirroring paths.reports whose confinement is a runtime concern), so
// reject the escape here, at the single projection point that owns the default. A backslash
// is rejected outright: the verify shim toolchain is POSIX (bash), so no legitimate entry
// needs one, and allowing it only reopens the win32 traversal ambiguity.
function requireRepoRelative(filePath: string, entry: string): string {
  if (path.isAbsolute(entry) || entry.includes('\\') || entry.split('/').includes('..')) {
    throw new Error(
      `manifest at ${filePath} is invalid: deep_review.verify_entry must be a repo-relative path without '..' segments or backslashes, got ${JSON.stringify(entry)}`,
    );
  }
  return entry;
}

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
  // Relative path (from the worktree root) of the verify shim the engine spawns.
  // Defaulted HERE (like guidesDir) so it is the single source; the spawn sites take it as required.
  verifyEntry: string;
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
    verifyEntry: requireRepoRelative(filePath, deepReview?.verify_entry ?? 'verify'),
    reportsDir: result.manifest.paths.reports,
  };
}
