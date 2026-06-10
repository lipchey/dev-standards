import path from 'node:path';
import { parseArgs } from './cli.ts';
import { loadManifest } from './manifest.ts';
import type { ManifestLoadResult } from './manifest.ts';
import { expandFileset } from './filesets.ts';
import { runCheck } from './exec.ts';
import { writeReport } from './report.ts';
import { doctor } from './doctor.ts';
import type { Check, CheckResult, Manifest, TierName } from './types.ts';

/** Exit code for CLI/usage faults (bad args, reserved scope). */
const EXIT_USAGE = 2;
/** Exit code for a manifest that cannot be read or fails validation. */
const EXIT_MANIFEST = 1;
/** Exit code when a blocking check failed or timed out during a tier run. */
const EXIT_CHECK_FAILED = 1;

/**
 * Runs the quality runner for one CLI invocation and returns the process exit
 * code. All process exit happens at the single call site below; `main` only
 * returns codes so it stays testable.
 *
 * Order mirrors the Task 8 spec: parse args, derive the repo root from the
 * manifest path, load + validate the manifest BEFORE any check executes, then
 * dispatch on scope (doctor / reserved fix-staged / tier run).
 */
function main(argv: string[]): number {
  const invocation = parseArgs(argv);
  if (!invocation.ok) {
    process.stderr.write(`${invocation.message}\n`);
    return EXIT_USAGE;
  }

  const { manifestPath, scope } = invocation;
  // Root is the manifest's directory: reports and workspaces resolve from here.
  const root = path.dirname(path.resolve(manifestPath));

  // `loadManifest` lets filesystem faults (e.g. a missing manifest) throw; wrap
  // it so a missing/unreadable manifest is a clean non-zero exit, not a stack.
  let load: ManifestLoadResult;
  try {
    load = loadManifest(manifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`could not read manifest at "${manifestPath}": ${detail}\n`);
    return EXIT_MANIFEST;
  }

  if (!load.ok) {
    for (const err of load.errors) {
      const where = err.path === '' ? '(root)' : err.path;
      process.stderr.write(`${where}: ${err.message}\n`);
    }
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

  // `scope` is now narrowed to a `TierName`. `runTier` shells out to git (via
  // fileset expansion) and writes the report, so an environment fault (no git,
  // a bad diff_filter, an fs error) can throw. Mirror the `loadManifest` guard
  // so such faults are a clean non-zero exit, not an uncaught stack trace.
  try {
    return runTier(manifest, root, scope);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error running ${scope} tier: ${detail}\n`);
    return 1;
  }
}

/**
 * Expands every fileset once, runs the tier's checks sequentially, writes the
 * structured report, prints a concise summary, and returns the exit code: 1
 * when any BLOCKING check failed or timed out, else 0. `report-only` outcomes
 * are recorded but never fail the run.
 */
function runTier(manifest: Manifest, root: string, scope: TierName): number {
  const filesByName = new Map<string, string[]>();
  for (const fileset of manifest.filesets) {
    filesByName.set(fileset.name, expandFileset(fileset, { cwd: root }));
  }

  const results: CheckResult[] = [];
  for (const check of tierChecks(manifest, scope)) {
    const result = runCheck({ check, tier: scope, cwd: root, filesByName });
    results.push(result);
    process.stdout.write(summarize(result));
  }

  const reportPath = writeReport(
    { repo: manifest.repo, scope, generatedAt: new Date().toISOString(), results },
    path.resolve(root, manifest.paths.reports),
  );
  process.stdout.write(`report: ${reportPath}\n`);

  const blockingFailed = results.some(
    (r) => r.mode === 'blocking' && (r.status === 'fail' || r.status === 'timeout'),
  );
  return blockingFailed ? EXIT_CHECK_FAILED : 0;
}

/** The checks for `scope`; the optional `audit` tier defaults to empty. */
function tierChecks(manifest: Manifest, scope: TierName): Check[] {
  if (scope === 'audit') return manifest.tiers.audit ?? [];
  return manifest.tiers[scope];
}

/** One concise summary line per check result. */
function summarize(r: CheckResult): string {
  const exit = r.exitCode === null ? '-' : String(r.exitCode);
  return `  ${r.status.padEnd(7)} ${r.name} [${r.mode}] ${r.durationMs}ms exit ${exit}\n`;
}

process.exit(main(process.argv.slice(2)));
