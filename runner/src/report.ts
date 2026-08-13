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
 * Reports paths are repo-controlled: confine the directory with lexical and
 * realpath checks, then replace the leaf via temp+rename so symlinks are not
 * followed.
 */
export function writeReport(report: RunnerReport, root: string, reportsPath: string): string {
  const relPath = path.join(reportsPath, `verify-${report.scope}.json`);
  return writeConfined(root, relPath, JSON.stringify(report, null, 2) + '\n');
}

export function resolveConfinedPath(rootDir: string, relPath: string): string {
  const realRoot = fs.realpathSync(rootDir);
  const filePath = path.resolve(rootDir, relPath);
  const dir = path.dirname(filePath);

  assertWithinRoot(rootDir, filePath, relPath);
  assertWithinRoot(realRoot, realpathOfDeepestExisting(dir), relPath);
  return filePath;
}

export function readConfined(rootDir: string, relPath: string): string {
  const filePath = resolveConfinedPath(rootDir, relPath);
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('confined read requires a regular file');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Confine `relPath` under `rootDir` (repo-controlled path): a lexical containment
 * check, then a realpath check on the deepest existing ancestor of the parent, a
 * `mkdir -p`, and a post-mkdir realpath check; the leaf is replaced via
 * temp+rename so a symlinked leaf is never followed. Returns the absolute path
 * written. Shared by the runner report writer and the deep-review findings/report
 * writers so all repo-controlled writes route through one confinement.
 */
export function writeConfined(rootDir: string, relPath: string, content: string): string {
  const realRoot = fs.realpathSync(rootDir);
  const target = path.resolve(rootDir, relPath);
  const dir = path.dirname(target);

  assertWithinRoot(rootDir, target, relPath);
  assertWithinRoot(realRoot, realpathOfDeepestExisting(dir), relPath);

  fs.mkdirSync(dir, { recursive: true });
  assertWithinRoot(realRoot, fs.realpathSync(dir), relPath);

  writeFileReplacingLeaf(dir, target, content);
  return target;
}

// Atomic leaf replacement inside an already-confined directory.
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

function assertWithinRoot(root: string, child: string, relPath: string): void {
  const rel = path.relative(root, child);
  const contained = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!contained) {
    throw new Error(
      `path ${JSON.stringify(relPath)} resolves outside the repo root: ` +
        `${JSON.stringify(child)} is not within ${JSON.stringify(root)}`,
    );
  }
}

// Resolve symlinks in the deepest existing ancestor before mkdir creates the rest.
function realpathOfDeepestExisting(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync(current);
}
