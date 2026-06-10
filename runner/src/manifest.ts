import { readFileSync } from 'node:fs';
import type { Manifest, ValidationError } from './types.ts';
import { validate } from './validate.ts';

export type ManifestLoadResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: ValidationError[] };

// Parse failures become ValidationErrors; filesystem faults remain caller errors.
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
  // validate() is the runtime gate for this cast.
  return { ok: true, manifest: parsed as Manifest };
}
