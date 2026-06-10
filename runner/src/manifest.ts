import { readFileSync } from 'node:fs';
import type { Manifest, ValidationError } from './types.ts';
import { validate } from './validate.ts';

export type ManifestLoadResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: ValidationError[] };

/**
 * Reads and validates a quality manifest from `filePath`.
 *
 * It parses UTF-8 JSON, mapping any parse failure into the shared
 * `ValidationError` model (rule `json-parse`, path `""`) so callers handle one
 * uniform error shape. Structurally parseable input is handed to the hand
 * validator, whose full error list is returned on failure. This function never
 * executes runner checks — loading and validation are its entire contract.
 *
 * Filesystem read errors (e.g. a missing file) are an environment fault rather
 * than a manifest-content fault, so they propagate to the caller instead of
 * being disguised as a `json-parse` error.
 */
export function loadManifest(filePath: string): ManifestLoadResult {
  const raw = readFileSync(filePath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [{ path: '', rule: 'json-parse', message: `manifest is not valid JSON: ${detail}` }],
    };
  }

  const result = validate(parsed);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }
  // `validate` is the gate: an ok result guarantees the `Manifest` shape.
  return { ok: true, manifest: parsed as Manifest };
}
