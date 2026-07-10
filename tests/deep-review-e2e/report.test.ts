/* Real-git e2e for the report writer's fail-closed secret scan (Phase 5 §5.3). Each
   case wires a REAL executable wrapper at <root>/tools/run-gitleaks (or omits it)
   and asserts the three honest states end-to-end: a clean scan writes the report, a
   hit refuses (EXIT_FAILURE), and an absent scanner refuses fail-closed
   (EXIT_SCANNER_UNAVAILABLE) — never the old fail-open "write anyway". */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_OK, EXIT_FAILURE, EXIT_SCANNER_UNAVAILABLE } from '../../deep-review/src/types.ts';
import {
  initCoreRepo,
  placeFindings,
  findingsFile,
  finding,
  runVerb,
  writeExecutable,
  cleanup,
  FINDINGS_REL,
} from './helper.ts';

const CLEAN_WRAPPER = '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n';
const HIT_WRAPPER = '#!/usr/bin/env bash\ncat >/dev/null\necho "aws-key redacted-leak" >&2\nexit 1\n';

/* The written report basenames under the reports root (excludes the findings file
   + its lock), so a case can assert whether a report was emitted. */
function reportFiles(repo: string): string[] {
  const dir = path.join(repo, 'reports/quality');
  return fs.readdirSync(dir).filter((name) => /^deep-review-.*\.md$/.test(name));
}

test('clean scan -> report is written and its path printed', () => {
  const box = initCoreRepo();
  try {
    placeFindings(box.repo, findingsFile([finding()]));
    writeExecutable(box.repo, 'tools/run-gitleaks', CLEAN_WRAPPER);

    const res = runVerb(box.repo, ['report', '--findings', FINDINGS_REL], box.env);
    assert.equal(res.status, EXIT_OK, res.stderr);
    const written = reportFiles(box.repo);
    assert.equal(written.length, 1, `expected one report, got ${written.join(', ')}`);
    assert.match(res.stdout.trim(), /deep-review-.*\.md$/);
    assert.equal(fs.existsSync(res.stdout.trim()), true);
  } finally {
    cleanup(box);
  }
});

test('hit -> EXIT_FAILURE and NO report written', () => {
  const box = initCoreRepo();
  try {
    placeFindings(box.repo, findingsFile([finding()]));
    writeExecutable(box.repo, 'tools/run-gitleaks', HIT_WRAPPER);

    const res = runVerb(box.repo, ['report', '--findings', FINDINGS_REL], box.env);
    assert.equal(res.status, EXIT_FAILURE, res.stdout || res.stderr);
    assert.match(res.stderr, /secret scan flagged/);
    assert.equal(reportFiles(box.repo).length, 0, 'a report was written despite a secret-scan hit');
  } finally {
    cleanup(box);
  }
});

test('absent wrapper -> EXIT_SCANNER_UNAVAILABLE (fail-closed) and NO report written', () => {
  const box = initCoreRepo();
  try {
    placeFindings(box.repo, findingsFile([finding()]));
    /* No tools/run-gitleaks wired: the scanner cannot run. */

    const res = runVerb(box.repo, ['report', '--findings', FINDINGS_REL], box.env);
    assert.equal(res.status, EXIT_SCANNER_UNAVAILABLE, res.stdout || res.stderr);
    assert.match(res.stderr, /unavailable/);
    assert.equal(reportFiles(box.repo).length, 0, 'a report was written despite an unavailable scanner');
  } finally {
    cleanup(box);
  }
});
