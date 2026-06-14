// Deep-review config loader. REUSES the runner's exported `loadManifest`
// (runner/src/manifest.ts) — the single, audited parse + validate path for the
// quality manifest — rather than re-parsing the manifest here. The `deep_review`
// block is validated transitively inside `loadManifest` (validate.ts), so this
// module only projects the already-validated manifest onto the slice the engine
// needs.

import { loadManifest } from '../../runner/src/manifest.ts';
import type { Manifest } from '../../runner/src/types.ts';

// The engine view of the manifest. `deep_review` and `workflow` are optional on
// the manifest, so their projected types include `undefined` (no block present).
export interface DeepReviewConfig {
  deepReview: Manifest['deep_review'];
  reportsDir: string;
  workflow: Manifest['workflow'];
}

export function loadConfig(filePath: string): DeepReviewConfig {
  const result = loadManifest(filePath);
  if (!result.ok) {
    const detail = result.errors.map((error) => `${error.path || '<root>'}: ${error.message}`).join('; ');
    throw new Error(`manifest at ${filePath} is invalid: ${detail}`);
  }
  const { manifest } = result;
  return {
    deepReview: manifest.deep_review,
    reportsDir: manifest.paths.reports,
    workflow: manifest.workflow,
  };
}
