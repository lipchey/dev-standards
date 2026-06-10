import type { Fileset, Manifest } from './types.ts';
import { matches } from './glob.ts';
import { stagedFiles, trackedFiles } from './git.ts';

const DEFAULT_DIFF_FILTER = 'ACMR';

// Optional git helpers let tests inject deterministic file lists.
export interface FilesetContext {
  cwd: string;
  stagedFiles?: (diffFilter?: string, cwd?: string) => string[];
  trackedFiles?: (cwd?: string) => string[];
}

// Source order is preserved; validation rejects repo_all diff_filter before this point.
export function expandFileset(fileset: Fileset, context: FilesetContext): string[] {
  const candidates = selectSource(fileset, context);

  return candidates.filter((file) => {
    const included = fileset.include.some((pattern) => matches(file, pattern));
    if (!included) return false;
    const excluded = (fileset.exclude ?? []).some((pattern) => matches(file, pattern));
    return !excluded;
  });
}

function selectSource(fileset: Fileset, context: FilesetContext): string[] {
  if (fileset.source === 'git_staged') {
    const staged = context.stagedFiles ?? stagedFiles;
    // Keep the declared/default diff filter observable to injected helpers.
    return staged(fileset.diff_filter ?? DEFAULT_DIFF_FILTER, context.cwd);
  }
  const tracked = context.trackedFiles ?? trackedFiles;
  return tracked(context.cwd);
}

export function filesetByName(manifest: Manifest, name: string): Fileset | undefined {
  return manifest.filesets.find((fileset) => fileset.name === name);
}
