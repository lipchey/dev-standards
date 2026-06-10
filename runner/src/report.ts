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
 * `<reportsDir>/verify-<scope>.json`, creating the directory if needed, and
 * returns the written path.
 */
export function writeReport(report: RunnerReport, reportsDir: string): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, `verify-${report.scope}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2) + '\n');
  return filePath;
}
