import type { Manifest } from './types.ts';

/**
 * Builds the one-line scheduler-class report for a manifest. The message names
 * the repo and its declared scheduler class so `doctor` (and any future caller)
 * can surface which scheduling contract the repo opted into. Pure: no IO.
 */
export function reportSchedulerClass(manifest: Manifest): string {
  return `repo "${manifest.repo}" scheduler class: ${manifest.scheduler_class}`;
}
