import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from './types.ts';
import { reportSchedulerClass } from './scheduler.ts';
import { resolveSinkPath } from './telemetry.ts';

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

  // Telemetry sink preflight: the runtime write is fail-open and its stderr warning is easily
  // missed, so surface a broken sink here. Advisory only — telemetry never blocks a tier.
  const sink = resolveSinkPath();
  if (sink === null) {
    messages.push('telemetry: off (DS_TELEMETRY_PATH)');
  } else {
    const probe = probeSinkWritable(sink);
    messages.push(
      probe.ok
        ? `telemetry: ${sink}`
        : `advisory: telemetry sink not writable at "${sink}": ${probe.detail}`,
    );
  }

  return { ok, messages };
}

// Provision the parent and open an append handle to prove writability; writes no event.
function probeSinkWritable(sinkPath: string): { ok: boolean; detail?: string } {
  try {
    fs.mkdirSync(path.dirname(sinkPath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(sinkPath, 'a', 0o600);
    fs.closeSync(fd);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function isDirectory(target: string): boolean {
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}
