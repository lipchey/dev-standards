import type { Manifest } from './types.ts';

export function reportSchedulerClass(manifest: Manifest): string {
  return `repo "${manifest.repo}" scheduler class: ${manifest.scheduler_class}`;
}
