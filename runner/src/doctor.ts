import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from './types.ts';
import { reportSchedulerClass } from './scheduler.ts';

export interface DoctorReport {
  ok: boolean;
  messages: string[];
}

// Phase 1a: missing hooks are advisory; missing workspaces fail the diagnosis.
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

function isDirectory(target: string): boolean {
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}
