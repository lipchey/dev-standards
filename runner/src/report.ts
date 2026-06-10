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
