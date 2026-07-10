import type { Fileset, Manifest } from './types.ts';
import { matches } from './glob.ts';
import { stagedFiles, trackedFiles } from './git.ts';

const DEFAULT_DIFF_FILTER = 'ACMR';

// Optional git helpers let tests inject deterministic file lists.
export interface FilesetContext {
  cwd: string;
  stagedFiles?: (diffFilter?: string, cwd?: string) => string[];
  trackedFiles?: (cwd?: string) => string[];
  // Remaining tier budget (ms) → bounds the real git probes; injected seams ignore it.
  remainingMs?: () => number;
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
  const timeoutMs = context.remainingMs?.();
  if (fileset.source === 'git_staged') {
    // Keep the declared/default diff filter observable to injected helpers.
    const filter = fileset.diff_filter ?? DEFAULT_DIFF_FILTER;
    if (context.stagedFiles) return context.stagedFiles(filter, context.cwd);
    return stagedFiles(filter, context.cwd, timeoutMs);
  }
  if (context.trackedFiles) return context.trackedFiles(context.cwd);
  return trackedFiles(context.cwd, timeoutMs);
}

export function filesetByName(manifest: Manifest, name: string): Fileset | undefined {
  return manifest.filesets.find((fileset) => fileset.name === name);
}
