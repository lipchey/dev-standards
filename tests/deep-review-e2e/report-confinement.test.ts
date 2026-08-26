/* Real-git e2e for BUG-11: `paths.reports` must be confined under the repo root when the
   `report` verb writes the deep-review report. Before the fix, deep-review resolved
   `paths.reports` to an absolute directory FIRST and then handed THAT resolved directory to
   the atomic writer as its OWN confinement root — a directory is always "within itself", so
   the confinement check was tautological and a `../`-escaping or symlinked-ancestor
   `paths.reports` silently wrote the report outside the repo. The fix (config.ts
   `requireRepoRelative` + cli.ts passing the TRUE repo root + report.ts's `repoRootAbs`)
   mirrors runner/src/report.ts's own `writeReport(report, root, reportsPath)` pattern: reject
   `..`/absolute at config load, and confine the write against the REAL repo root (realpath'd,
   so a symlinked ancestor is caught too) — never the reports dir resolved in isolation. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_OK, EXIT_FAILURE } from '../../deep-review/src/types.ts';
import {
  initCoreRepo,
  placeFindings,
  findingsFile,
  finding,
  runVerb,
  writeFile,
  writeExecutable,
  cleanup,
  FINDINGS_REL,
} from './helper.ts';

const CLEAN_GITLEAKS_WRAPPER = '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n';

/* A minimal VALID quality manifest — mirrors helper.ts's private `qualityJson()` shape exactly
   (same required schema keys) — parameterized ONLY on `paths.reports`, so a case can drive an
   escaping/safe value through the real CLI without needing helper.ts (an EXISTING shared file
   this task must not edit) to expose that knob. */
function customQualityJson(reportsPath: string): string {
  const manifest = {
    version: 1,
    repo: 'e2e-fixture',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 120, fast_seconds: 300, full_seconds: 900, audit_seconds: 1800 },
    policy: {
      mutates_by_default: false,
      format_fix_staged_allowed: false,
      typed_eslint_in_precommit: false,
      block_new_dead_code_only: true,
    },
    paths: { reports: reportsPath, baselines: 'quality-baselines' },
    generated: { hooks_dir: '.githooks' },
    workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
    filesets: [],
    tiers: {
      staged: [],
      fast: [{ name: 'noop', argv: ['node', '--version'], timeout_seconds: 5, covers: ['.'] }],
      full: [],
    },
    deep_review: {
      enabled: true,
      trigger: 'manual-only',
      modes: ['review-only', 'review-and-refactor'],
      budget: { seconds: 900 },
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/* Wires a `report`-ready fixture with a CUSTOM paths.reports, without touching helper.ts. */
function withCustomReportsPath(reportsPath: string): ReturnType<typeof initCoreRepo> {
  const box = initCoreRepo();
  writeFile(box.repo, 'quality.json', customQualityJson(reportsPath));
  placeFindings(box.repo, findingsFile([finding()]));
  writeExecutable(box.repo, 'tools/run-gitleaks', CLEAN_GITLEAKS_WRAPPER);
  return box;
}

test('paths.reports with a `..` segment is rejected at config load; no report written outside the repo', () => {
  const box = withCustomReportsPath('../outside-reports');
  try {
    const outsideDir = path.join(box.root, 'outside-reports');
    const res = runVerb(box.repo, ['report', '--findings', FINDINGS_REL], box.env);
    assert.equal(res.status, EXIT_FAILURE, res.stdout || res.stderr);
    assert.match(res.stderr, /repo-relative/);
    assert.equal(fs.existsSync(outsideDir), false, 'no report/directory written outside the repo root');
  } finally {
    cleanup(box);
  }
});

test('paths.reports as an absolute path is rejected at config load; no report written outside the repo', () => {
  const box = initCoreRepo();
  try {
    const absTarget = path.join(box.root, 'abs-outside');
    writeFile(box.repo, 'quality.json', customQualityJson(absTarget));
    placeFindings(box.repo, findingsFile([finding()]));
    writeExecutable(box.repo, 'tools/run-gitleaks', CLEAN_GITLEAKS_WRAPPER);

    const res = runVerb(box.repo, ['report', '--findings', FINDINGS_REL], box.env);
    assert.equal(res.status, EXIT_FAILURE, res.stdout || res.stderr);
    assert.match(res.stderr, /repo-relative/);
    assert.equal(fs.existsSync(absTarget), false, 'no report/directory written to the absolute escape target');
  } finally {
    cleanup(box);
  }
});

test('paths.reports resolving through a symlinked ancestor that escapes the repo is rejected fail-closed; nothing leaks into the symlink target', () => {
  const box = initCoreRepo();
  try {
    const outsideTarget = path.join(box.root, 'outside-target');
    fs.mkdirSync(outsideTarget, { recursive: true });
    fs.symlinkSync(outsideTarget, path.join(box.repo, 'reports-link'));
    writeFile(box.repo, 'quality.json', customQualityJson('reports-link'));
    placeFindings(box.repo, findingsFile([finding()]));
    writeExecutable(box.repo, 'tools/run-gitleaks', CLEAN_GITLEAKS_WRAPPER);

    const res = runVerb(box.repo, ['report', '--findings', FINDINGS_REL], box.env);
    assert.equal(res.status, EXIT_FAILURE, res.stdout || res.stderr);
    assert.match(res.stderr, /outside the repo root/);
    assert.equal(fs.readdirSync(outsideTarget).length, 0, 'no report leaked into the symlinked-outside target');
  } finally {
    cleanup(box);
  }
});

test('control: a safe repo-relative paths.reports still writes normally (no regression)', () => {
  const box = withCustomReportsPath('custom-reports');
  try {
    const res = runVerb(box.repo, ['report', '--findings', FINDINGS_REL], box.env);
    assert.equal(res.status, EXIT_OK, res.stdout || res.stderr);
    const written = fs
      .readdirSync(path.join(box.repo, 'custom-reports'))
      .filter((name) => /^deep-review-.*\.md$/.test(name));
    assert.equal(written.length, 1, `expected one report under custom-reports, got ${written.join(', ')}`);
    assert.equal(res.stdout.trim(), path.join(box.repo, 'custom-reports', written[0] as string));
  } finally {
    cleanup(box);
  }
});
