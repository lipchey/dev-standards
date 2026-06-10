import type { Fileset, Manifest } from './types.ts';
import { matches } from './glob.ts';
import { stagedFiles, trackedFiles } from './git.ts';

/** The default git diff-filter for staged filesets when none is declared. */
const DEFAULT_DIFF_FILTER = 'ACMR';

/**
 * Dependencies for fileset expansion. The optional functions exist so tests can
 * inject deterministic file lists instead of hitting real git; production code
 * leaves them unset and the `git.ts` helpers are used.
 */
export interface FilesetContext {
  cwd: string;
  stagedFiles?: (diffFilter?: string, cwd?: string) => string[];
  trackedFiles?: (cwd?: string) => string[];
}

/**
 * Expands one declared fileset into the concrete list of files it selects.
 *
 * Source selection: `git_staged` reads the staged change set (using the
 * fileset's `diff_filter` when present, else the `ACMR` default); `repo_all`
 * reads all tracked files. A stray `diff_filter` on a `repo_all` fileset is
 * ignored here — validation already forbids that combination upstream.
 *
 * A file is kept when it matches ANY include pattern and matches NO exclude
 * pattern. Source order is preserved: the git helpers already return a
 * deterministic order, so we never sort or shuffle.
 */
export function expandFileset(fileset: Fileset, context: FilesetContext): string[] {
  const candidates = selectSource(fileset, context);

  return candidates.filter((file) => {
    const included = fileset.include.some((pattern) => matches(file, pattern));
    if (!included) return false;
    const excluded = (fileset.exclude ?? []).some((pattern) => matches(file, pattern));
    return !excluded;
  });
}

/** Reads the file source for `fileset`, using injected helpers when provided. */
function selectSource(fileset: Fileset, context: FilesetContext): string[] {
  if (fileset.source === 'git_staged') {
    const staged = context.stagedFiles ?? stagedFiles;
    // Pass the diff filter explicitly so the chosen value (declared or ACMR
    // default) is observable, rather than relying on the helper's own default.
    return staged(fileset.diff_filter ?? DEFAULT_DIFF_FILTER, context.cwd);
  }
  const tracked = context.trackedFiles ?? trackedFiles;
  return tracked(context.cwd);
}

/** Looks up a declared fileset by name, or `undefined` when none matches. */
export function filesetByName(manifest: Manifest, name: string): Fileset | undefined {
  return manifest.filesets.find((fileset) => fileset.name === name);
}
