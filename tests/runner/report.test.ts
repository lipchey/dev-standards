import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeReport } from '../../runner/src/report.ts';
import type { RunnerReport } from '../../runner/src/report.ts';

test('writeReport writes pretty, newline-terminated JSON that round-trips', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-report-'));
  try {
    const reportsDir = path.join(tmpDir, 'reports');
    const report: RunnerReport = {
      repo: 'dev-standards',
      scope: 'fast',
      generatedAt: new Date().toISOString(),
      results: [
        {
          name: 'tsc',
          tier: 'fast',
          status: 'pass',
          exitCode: 0,
          durationMs: 12,
          mode: 'blocking',
        },
      ],
    };

    const written = writeReport(report, reportsDir);

    assert.equal(written, path.join(reportsDir, 'verify-fast.json'));
    const content = fs.readFileSync(written, 'utf8');
    assert.ok(content.endsWith('\n'), 'report content must be newline-terminated');
    assert.deepEqual(JSON.parse(content), report);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
