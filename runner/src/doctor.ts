import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from './types.ts';
import { reportSchedulerClass } from './scheduler.ts';

export interface DoctorReport {
  ok: boolean;
  messages: string[];
}

/**
 * Diagnoses a loaded manifest against the on-disk repo rooted at `root`,
 * without exiting the process. It reports the scheduler class, then applies two
 * Phase 1a environment checks:
 *
 * - A missing generated hooks directory is ADVISORY: it adds a message but does
 *   not flip `ok` (hooks are installed later in the rollout).
 * - A missing workspace directory is a FAILURE: each absent `root/<path>` flips
 *   `ok` to false and adds a message, so a misconfigured manifest is caught
 *   before any check runs.
 *
 * Returns every message it gathered plus the aggregate `ok`; the caller decides
 * the exit code.
 */
export function doctor(manifest: Manifest, root: string): DoctorReport {
  const messages: string[] = [reportSchedulerClass(manifest)];
  let ok = true;

  const hooksDir = path.resolve(root, manifest.generated.hooks_dir);
  if (!isDirectory(hooksDir)) {
    messages.push(
      `advisory: generated hooks directory not found at "${manifest.generated.hooks_dir}" (install hooks to create it)`,
    );
  }

  for (const workspace of manifest.workspaces) {
    const workspaceDir = path.resolve(root, workspace.path);
    if (!isDirectory(workspaceDir)) {
      ok = false;
      messages.push(`workspace "${workspace.name}" directory missing: "${workspace.path}"`);
    }
  }

  return { ok, messages };
}

/** True when `target` exists and is a directory; false for any missing path. */
function isDirectory(target: string): boolean {
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}
