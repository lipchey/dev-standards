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
// canonical repo-relative slash-path matching; reject anything that would spawn outside the
// worktree or make the spawned path and the no-touch pattern disagree:
//   - absolute / `..`-escaping -> spawns a binary outside the worktree, slips the match;
//   - backslash -> `..\` / `C:\` normalizes differently under path.win32 than the posix
//     slice paths the matcher compares against (the shim toolchain is POSIX bash, so no
//     legitimate entry needs one);
//   - trailing separator -> `path.posix.normalize` keeps it, so the no-touch pattern
//     `scripts/verify/` never matches the slice path `scripts/verify`, and the spawned
//     `<cwd>/scripts/verify/` fails with ENOTDIR (a silent verification gap).
// The manifest schema only shape-checks (non-empty string, mirroring paths.reports whose
// confinement is a runtime concern), so reject here — the single projection point that owns
// the default. LIMITATION: the no-touch match is LEXICAL (like quality.json / the
// project-facts ref / the baseline `verify`); a consumer that makes verify_entry a SYMLINK
// to an unprotected in-repo file leaves that target editable — keep the shim a regular file.
function requireRepoRelative(filePath: string, entry: string): string {
  if (
    path.isAbsolute(entry) ||
    entry.includes('\\') ||
    entry.endsWith('/') ||
    entry.split('/').includes('..')
  ) {
    throw new Error(
      `manifest at ${filePath} is invalid: deep_review.verify_entry must be a repo-relative path without '..' segments, backslashes, or a trailing slash, got ${JSON.stringify(entry)}`,
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
