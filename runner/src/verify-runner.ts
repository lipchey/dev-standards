import path from 'node:path';
import { parseArgs } from './cli.ts';
import { loadManifest } from './manifest.ts';
import type { ManifestLoadResult } from './manifest.ts';
import { EXIT_MANIFEST, EXIT_USAGE, formatErrorLine, isMainModule } from './manifest-cli.ts';
import { expandFileset } from './filesets.ts';
import { runCheck } from './exec.ts';
import { assertWithinBudget } from './budget.ts';
import { writeReport } from './report.ts';
import { doctor } from './doctor.ts';
import type { Check, CheckResult, Manifest, TierName } from './types.ts';

const EXIT_CHECK_FAILED = 1;

// Validate the manifest before any check runs; exit happens only at the entrypoint.
function main(argv: string[]): number {
  const invocation = parseArgs(argv);
  if (!invocation.ok) {
    process.stderr.write(`${invocation.message}\n`);
    return EXIT_USAGE;
  }

  const { manifestPath, scope } = invocation;
  const root = path.dirname(path.resolve(manifestPath));

  // Convert filesystem faults to clean CLI errors, not stack traces.
  let load: ManifestLoadResult;
  try {
    load = loadManifest(manifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`could not read manifest at "${manifestPath}": ${detail}\n`);
    return EXIT_MANIFEST;
  }

  if (!load.ok) {
    for (const err of load.errors) process.stderr.write(`${formatErrorLine(err)}\n`);
    return EXIT_MANIFEST;
  }

  const manifest = load.manifest;

  if (scope === 'doctor') {
    const report = doctor(manifest, root);
    for (const message of report.messages) process.stdout.write(`${message}\n`);
    return report.ok ? 0 : 1;
  }

  if (scope === 'fix-staged') {
    process.stderr.write('fix-staged is reserved and not implemented in Phase 1a\n');
    return EXIT_USAGE;
  }

  // Tier runs touch git and reports; keep environment faults as clean stderr.
  try {
    return runTier(manifest, root, scope);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error running ${scope} tier: ${detail}\n`);
    return 1;
  }
}

// report-only outcomes are recorded but do not fail; wall-clock budget is checked after each run.
export function runTier(manifest: Manifest, root: string, scope: TierName): number {
  const startedAt = Date.now();
  const budgetSeconds = manifest.budgets[`${scope}_seconds`];

  const filesByName = new Map<string, string[]>();
  for (const fileset of manifest.filesets) {
    filesByName.set(fileset.name, expandFileset(fileset, { cwd: root }));
  }

  const results: CheckResult[] = [];
  for (const check of tierChecks(manifest, scope)) {
    const result = runCheck({ check, tier: scope, cwd: root, filesByName });
    results.push(result);
    process.stdout.write(summarize(result));
    assertWithinBudget(startedAt, budgetSeconds);
  }

  const reportPath = writeReport(
    { repo: manifest.repo, scope, generatedAt: new Date().toISOString(), results },
    root,
    manifest.paths.reports,
  );
  process.stdout.write(`report: ${reportPath}\n`);

  const blockingFailed = results.some(
    (r) => r.mode === 'blocking' && (r.status === 'fail' || r.status === 'timeout'),
  );
  return blockingFailed ? EXIT_CHECK_FAILED : 0;
}

function tierChecks(manifest: Manifest, scope: TierName): Check[] {
  if (scope === 'audit') return manifest.tiers.audit ?? [];
  return manifest.tiers[scope];
}

function summarize(r: CheckResult): string {
  const exit = r.exitCode === null ? '-' : String(r.exitCode);
  return `  ${r.status.padEnd(7)} ${r.name} [${r.mode}] ${r.durationMs}ms exit ${exit}\n`;
}

// Keep imports test-safe.
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
