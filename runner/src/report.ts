import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult } from './types.ts';

export interface RunnerReport {
  repo: string;
  scope: string;
  generatedAt: string;
  results: CheckResult[];
}

/**
 * Writes `report` as pretty, newline-terminated JSON to
 * `<root>/<reportsPath>/verify-<scope>.json`, creating the directory if needed,
 * and returns the written path.
 *
 * `reportsPath` is the manifest's `paths.reports` value — repo-supplied and so
 * untrusted — and the repo tree itself is untrusted. The output is therefore
 * confined to `root` by three guards, cheapest first, so a report can never be
 * written outside the repository:
 *   1. lexical — the resolved target must stay within `root` (rejects `..` and
 *      absolute paths that escape).
 *   2. symlink, pre-mkdir — the realpath of the deepest already-existing
 *      ancestor must stay within `root`'s realpath, so an existing symlink
 *      component cannot redirect the write before any directory is created.
 *   3. realpath, post-mkdir — defence in depth: the created directory's realpath
 *      must still be within `root`'s realpath.
 *
 * The three guards confine the report DIRECTORY, but the leaf
 * `verify-<scope>.json` is still repo-controlled: a hostile checkout can plant
 * it as a symlink to an operator-writable file outside the repo. A plain
 * `writeFileSync` on the leaf would follow that symlink and truncate the target.
 * The write is therefore atomic: data goes to a fresh, exclusively-created temp
 * file inside the confined directory, then `renameSync` replaces the leaf's
 * directory ENTRY — dropping any symlink rather than following it.
 */
export function writeReport(report: RunnerReport, root: string, reportsPath: string): string {
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(root, reportsPath);

  assertWithinRoot(root, target, reportsPath);
  assertWithinRoot(realRoot, realpathOfDeepestExisting(target), reportsPath);

  fs.mkdirSync(target, { recursive: true });
  assertWithinRoot(realRoot, fs.realpathSync(target), reportsPath);

  const filePath = path.join(target, `verify-${report.scope}.json`);
  writeFileReplacingLeaf(target, filePath, JSON.stringify(report, null, 2) + '\n');
  return filePath;
}

/**
 * Writes `data` to `filePath` so that an existing symlink at `filePath` is
 * REPLACED, never followed. The data is first written to a uniquely named temp
 * file inside `dir` (the already-confined report directory, so the temp name
 * introduces no new escape) opened with `wx` (`O_CREAT | O_EXCL`) — which
 * refuses to follow or reuse any pre-existing entry of that name — then renamed
 * over `filePath`. `rename(2)` removes the destination directory entry (a
 * symlink there is unlinked, not dereferenced) and is atomic on the same
 * filesystem, which `dir` and `filePath` always share. The temp file is removed
 * if the rename fails, so no stray temp is ever left behind.
 */
function writeFileReplacingLeaf(dir: string, filePath: string, data: string): void {
  const tmp = path.join(dir, `.verify-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { flag: 'wx' });
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup; surface the original rename failure below
    }
    throw error;
  }
}

/** Throws unless `child` is `root` itself or a path nested within it. */
function assertWithinRoot(root: string, child: string, reportsPath: string): void {
  const rel = path.relative(root, child);
  const contained = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!contained) {
    throw new Error(
      `paths.reports ${JSON.stringify(reportsPath)} resolves outside the repo root: ` +
        `${JSON.stringify(child)} is not within ${JSON.stringify(root)}`,
    );
  }
}

/**
 * Realpath of the deepest existing ancestor of `target` (which may not exist
 * yet). Walking to an ancestor that exists lets us resolve symlinks even though
 * the leaf report directory has not been created; `mkdirSync` will then create
 * the remaining components beneath that resolved, in-root ancestor.
 */
function realpathOfDeepestExisting(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break; // reached the filesystem root
    current = parent;
  }
  return fs.realpathSync(current);
}
