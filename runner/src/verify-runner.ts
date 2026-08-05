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
import { runFixStaged } from './fix-staged.ts';
import { appendRunEvent, buildRunEvent, gitContext, resolveSinkPath } from './telemetry.ts';
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
    // Its own boundary (this runs before the tier try below): a git fault inside becomes a clean
    // CLI error, never a stack trace.
    try {
      return runFixStaged(manifest, root);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`error running fix-staged: ${detail}\n`);
      return 1;
    }
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

// report-only outcomes are recorded but do not fail; one MONOTONIC deadline bounds the
// whole tier (setup + git + checks). `now` is performance.now() so a backward wall-clock
// jump can't extend a hard deadline; it is injectable only so tests can drive the clock.
// Remaining-time is recomputed before every spawn/budget check and passed as each spawn's
// timeout, so a hung git or check can't outlive the tier budget.
export function runTier(
  manifest: Manifest,
  root: string,
  scope: TierName,
  now: () => number = () => performance.now(),
): number {
  // Wall-clock start for the telemetry event; `now()` is the monotonic budget clock only.
  const startedAtIso = new Date().toISOString();
  const startedAt = now();
  const budgetSeconds = manifest.budgets[`${scope}_seconds`];
  const deadlineMs = startedAt + budgetSeconds * 1000;
  // performance.now() is fractional; spawn timeouts must be integers, so floor the
  // remaining budget (never granting MORE than what is left) before it reaches a spawn.
  const remainingMs = (): number => Math.floor(deadlineMs - now());
  const assertBudget = (): void => assertWithinBudget(startedAt, budgetSeconds, now);
  const checks = tierChecks(manifest, scope);

  // `audit` is an explicit operator request, not an optional no-op. A green run with no
  // checks falsely claims that an audit happened (and becomes especially dangerous once a
  // consumer wires mutation/duplication gates around this tier).
  if (scope === 'audit' && checks.length === 0) {
    throw new Error('audit tier is not configured or has no checks');
  }

  // Initialize results before setup so a deadline hit during git/fileset expansion can
  // still emit the work completed so far.
  const results: CheckResult[] = [];
  const emitReport = (): string =>
    writeReport(
      { repo: manifest.repo, scope, generatedAt: new Date().toISOString(), results },
      root,
      manifest.paths.reports,
    );

  // Exactly-once finalization seam, independent of report writing. Fenced in its own try so a
  // telemetry failure can never mask the original error (abort path) nor affect the tier result;
  // the write itself is additionally fail-open. Skip the git probes entirely when disabled.
  const emitTelemetry = (exit: number | null, aborted: boolean): void => {
    try {
      if (resolveSinkPath() === null) return;
      const { branch, head_sha } = gitContext(root);
      appendRunEvent(
        buildRunEvent({
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          repo: manifest.repo,
          scope,
          branch,
          head_sha,
          exit,
          aborted,
          results,
        }),
      );
    } catch {
      /* telemetry is fail-open; never affect the tier result or mask a re-thrown error */
    }
  };

  try {
    const filesByName = new Map<string, string[]>();
    for (const fileset of manifest.filesets) {
      const referenced = checks.some(
        (check) =>
          check.skip_if_empty === fileset.name || check.argv.includes(`{files:${fileset.name}}`),
      );
      if (!referenced) continue;
      filesByName.set(fileset.name, expandFileset(fileset, { cwd: root, remainingMs }));
      // Fileset expansion (git + in-memory globbing) can itself cross the deadline; assert
      // after each so a tier with zero checks can't succeed once the budget is spent (FIX #2).
      assertBudget();
    }

    for (const check of checks) {
      process.stdout.write(
        `  check ${check.name} [${check.mode ?? 'blocking'}] configured timeout ${check.timeout_seconds}s\n`,
      );
      const left = remainingMs();
      // Never spawn with a spent budget; fail the check without launching it.
      const result =
        left <= 0
          ? deadlineFail(check, scope)
          : runCheck({ check, tier: scope, cwd: root, filesByName, remainingMs: left });
      results.push(result);
      process.stdout.write(summarize(result));
      assertBudget();
    }

    /* Fail closed before the success/report path (FIX #2), mode-independently: a spent
       hard deadline fails the whole TIER even when the last check was report-only (which
       never blocks) or the tier had zero checks. `remainingMs() <= 0` matches the per-check
       `left <= 0` guard, which assertWithinBudget's strict elapsed>budget misses in the
       final-millisecond floor window — so an exactly-spent budget can no longer false-green. */
    assertBudget();
    if (remainingMs() <= 0) {
      throw new Error(`Runtime budget exceeded: the ${scope} tier budget (${budgetSeconds}s) is spent.`);
    }
  } catch (error) {
    // Report write here is best-effort — we're already past the deadline, so a partial
    // report is acceptable. Guard it in its own try so a report-write failure can never
    // mask/replace the original deadline/error, which is always re-thrown (FIX #7).
    try {
      emitReport();
    } catch {
      /* keep the original deadline/error */
    }
    // Abort path: partial results, no exit decision. A report-write failure above must not
    // prevent this, and this must not mask/replace the original error re-thrown below.
    emitTelemetry(null, true);
    throw error;
  }

  /* Telemetry before the report write: the two sinks are independent by contract, so a
     normal-path report failure (which still fails the run loudly) must not lose the event. */
  const exit = results.some(isBlockingResult) ? EXIT_CHECK_FAILED : 0;
  emitTelemetry(exit, false);

  const reportPath = emitReport();
  process.stdout.write(`report: ${reportPath}\n`);

  return exit;
}

/* The tier's exit decision. Operational failures (`error` and `timeout`) block REGARDLESS of
   mode, so a broken or hung report-only check cannot pass the tier fail-open. Only a genuine
   finding (`fail`) is mode-gated; `bypassed`, `pass`, and `skipped` never block. */
export function isBlockingResult(r: CheckResult): boolean {
  return r.status === 'error' || r.status === 'timeout' || (r.mode === 'blocking' && r.status === 'fail');
}

// A check whose tier deadline is already spent: failed as timed-out, never spawned.
function deadlineFail(check: Check, scope: TierName): CheckResult {
  return {
    name: check.name,
    tier: scope,
    status: 'timeout',
    exitCode: null,
    durationMs: 0,
    mode: check.mode ?? 'blocking',
  };
}

function tierChecks(manifest: Manifest, scope: TierName): Check[] {
  if (scope === 'audit') return manifest.tiers.audit ?? [];
  return manifest.tiers[scope];
}

export function summarize(r: CheckResult): string {
  const exit = r.exitCode === null ? '-' : String(r.exitCode);
  /* Only on a kill: the I/O-stall share of the window is the first question asked about a
     timeout, and printing it everywhere would bury it. Every check's sample still reaches
     telemetry. */
  const stall = r.status === 'timeout' && r.ioStallMs !== undefined ? ` io-stall ${r.ioStallMs}ms` : '';
  return `  ${r.status.padEnd(7)} ${r.name} [${r.mode}] ${r.durationMs}ms exit ${exit}${stall}\n`;
}

// Keep imports test-safe.
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
