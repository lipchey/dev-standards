import path from 'node:path';
import { parseArgs } from './cli.ts';
import { loadManifest } from './manifest.ts';
import type { ManifestLoadResult } from './manifest.ts';
import { EXIT_MANIFEST, EXIT_USAGE, formatErrorLine, isMainModule } from './manifest-cli.ts';
import { expandFileset } from './filesets.ts';
import { runCheck } from './exec.ts';
import { errorRows as groupErrorRows, runCheckGroup } from './group.ts';
import { assertWithinBudget } from './budget.ts';
import { writeReport } from './report.ts';
import { doctor } from './doctor.ts';
import { runFixStaged } from './fix-staged.ts';
import { appendRunEvent, buildRunEvent, gitContext, resolveSinkPath } from './telemetry.ts';
import type { Check, CheckResult, Manifest, TierName } from './types.ts';

const EXIT_CHECK_FAILED = 1;

/* THE TERMINAL RECORD — grammar. One line, always a run's LAST, in exactly this shape:

     VERIFY RESULT: scope=<scope> outcome=<outcome> [reason=<slug>] [blockers=N] [checks=N]

   `outcome` is a CLOSED vocabulary of four, splitting on the single question a reader has —
   is this exit a statement about the CODE, or about the MACHINERY?
     passed | failed      a verdict; the tier ran and decided (stdout, beside the checks)
     aborted              machinery: the tier started and threw before deciding (stderr)
     no-verdict           machinery: no tier decision exists at all (stderr)
   `reason` is REQUIRED on `no-verdict` and carries every finer distinction — refused, killed,
   never dispatched. It is deliberately NOT a closed vocabulary: its charset is fixed
   (`[a-z0-9-]+`, no whitespace, no `=`) and unknown slugs are opaque to a reader, so a wrapper
   can name a fault this runner has never heard of without an upstream release to do it.

   A WRAPPER MAY EMIT THIS LINE TOO, and must, for the faults it alone can see: the runner
   cannot report on a path where it was never invoked (a shim that refuses before dispatch, a
   remote lane whose workload never launched). Consumers own their own reason slugs. When more
   than one line is present the LAST one is the verdict — which is what the outermost caller,
   the one that actually knows how the run ended, always writes.

   `scope` is whatever the invocation named, so a runner-emitted record can carry a non-tier scope
   (`doctor`, `fix-staged`) when the fault precedes the mode's own work. A WRAPPER's records are
   tier-only: it speaks for a missing verdict, and a non-tier mode has none to be missing.

   Not every exit carries the line, and one hole is deliberate: a usage error (EXIT_USAGE) has no
   record. argv did not parse, so there is no scope to name truthfully — and that exit is
   unambiguous without one, since the code is shared with nothing and the rejected argument is
   already on stderr. The record disambiguates; it is not a receipt. */
function noVerdict(scope: string, reason: string): number {
  process.stderr.write(`VERIFY RESULT: scope=${scope} outcome=no-verdict reason=${reason}\n`);
  return EXIT_MANIFEST;
}

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
    return noVerdict(scope, 'manifest-unreadable');
  }

  if (!load.ok) {
    for (const err of load.errors) process.stderr.write(`${formatErrorLine(err)}\n`);
    return noVerdict(scope, 'manifest-invalid');
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
    /* The abort record closes the terminal grammar: a tier that threw never reached its exit
       decision, so it is neither passed nor failed, and a reader must not have to tell the
       difference by recognizing the prose above. Detail first, record last — the run's last
       line is a VERIFY RESULT whichever way it ended. Both stay on stderr: unlike the normal
       outcomes this is a fault, and the detail line is already stderr and tested for. */
    process.stderr.write(`error running ${scope} tier: ${detail}\n`);
    process.stderr.write(`VERIFY RESULT: scope=${scope} outcome=aborted\n`);
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
    const executedGroups = new Set<string>();
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
      if (check.group !== undefined && executedGroups.has(check.group)) continue;
      process.stdout.write(
        `  check ${check.name} [${check.mode ?? 'blocking'}] configured timeout ${check.timeout_seconds}s\n`,
      );
      const left = remainingMs();
      if (check.group !== undefined) {
        const groupName = check.group;
        const group = manifest.groups?.find((candidate) => candidate.name === groupName);
        executedGroups.add(groupName);
        const members = checks.filter((candidate) => candidate.group === groupName);
        const groupResults = group === undefined
          ? groupErrorRows(
              { checks: members, tier: scope },
              `group execution failed: group ${JSON.stringify(groupName)} is not declared`,
            )
          : left <= 0
            ? members.map((member) => deadlineFail(member, scope))
            : runCheckGroup({
                group,
                checks: members,
                tier: scope,
                cwd: root,
                timeoutMs: Math.min(
                  members.reduce((sum, member) => sum + member.timeout_seconds * 1000, 0),
                  left,
                ),
              });
        for (const groupResult of groupResults) results.push(groupResult);
        process.stdout.write(groupResults.map(summarize).join(''));
        assertBudget();
        continue;
      }
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
  const blocking = results.filter(isBlockingResult);
  const exit = blocking.length > 0 ? EXIT_CHECK_FAILED : 0;
  emitTelemetry(exit, false);

  const reportPath = emitReport();
  process.stdout.write(`report: ${reportPath}\n`);

  /* The tier's terminal record — the verdict half of the grammar defined above.
     Until now a blocking failure was announced only by its inline summarize() line, so a long run
     buried it under every later passing check and ended byte-identically to a green one: a real
     full run put its single failure at line 750 of 1316 and still signed off with `report: <path>`
     (owner, 2026-08-05). The exit code stays the machine contract; this is for the log, which for
     a remote run is the only artifact that reaches the caller at all. Re-print exactly the set
     that decided `exit`, so the record cites its own evidence and cannot drift from it — names go
     on those lines, never inside the record, whose vocabulary stays fixed and parseable.
     `passed` means the exit decision was zero,
     NOT that every result was `pass` — report-only findings, bypassed and skipped checks all
     legitimately survive it, which is why `blockers` is derived only from isBlockingResult. */
  if (blocking.length > 0) {
    process.stdout.write(`blocking failures:\n${blocking.map(summarize).join('')}`);
  }
  process.stdout.write(
    `VERIFY RESULT: scope=${scope} outcome=${exit === 0 ? 'passed' : 'failed'}` +
      `${blocking.length > 0 ? ` blockers=${blocking.length}` : ''} checks=${results.length}\n`,
  );

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

/* Keep imports test-safe. `process.exitCode` rather than `process.exit()`: pipe-backed stdout
   flushes asynchronously, and an immediate exit drops whatever is still buffered — which is
   exactly the terminal record this run just wrote. remote-runner spawns the shim with piped
   stdio, so a remote `--full` is precisely the case that would have lost it. */
if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
