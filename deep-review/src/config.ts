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
/* Shared by verify_entry and every required_reads entry (§P2-2): both must resolve inside
   the worktree, and the guides-read gate's tail match compares against these repo-relative
   values, so an escaping/backslash/trailing-slash spelling must be rejected at the one
   projection point rather than silently mis-anchoring the read-proof check. */
function requireRepoRelative(manifestPath: string, field: string, entry: string): string {
  if (
    entry === '' ||
    path.isAbsolute(entry) ||
    entry.includes('\\') ||
    entry.endsWith('/') ||
    entry.split('/').includes('..')
  ) {
    throw new Error(
      `manifest at ${manifestPath} is invalid: deep_review.${field} must be a repo-relative path without '..' segments, backslashes, or a trailing slash, got ${JSON.stringify(entry)}`,
    );
  }
  return entry;
}

/* `guidesDir` is an optional repo overlay; canonical guides stay package-owned. */
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
  /* Repo-relative project files the guides-read gate additionally requires the reviewer to
     open (on top of the always-required package guide templates + overlay). Defaults to []:
     a fresh consumer is only guaranteed the submodule guides, so a non-empty engine default
     would demand reading files an adopter may not have yet. The consumer seed populates this
     with files that repo actually ships (project-facts / code-conventions / CHECKLIST). */
  requiredReads: string[];
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
    /* One default keeps the engine and skill aligned on the optional overlay location.
       Confined repo-relative like verify_entry: an absolute/escaping guides_dir would make the
       fix-mode no-touch glob (`policyProtectedPaths`) match nothing, leaving the overlay
       editable, and would need runtime confinement everywhere it is resolved. */
    guidesDir: requireRepoRelative(filePath, 'guides_dir', deepReview?.guides_dir ?? '.claude/review-guides'),
    noTouchGlobsRef: deepReview?.no_touch_globs_ref,
    verifyAfterFix: deepReview?.verify_after_fix,
    verifyEntry: requireRepoRelative(filePath, 'verify_entry', deepReview?.verify_entry ?? 'verify'),
    reportsDir: result.manifest.paths.reports,
    requiredReads: (deepReview?.required_reads ?? []).map((entry) =>
      requireRepoRelative(filePath, 'required_reads', entry),
    ),
  };
}
