// E4 — the metadata-only secret-scanned deep-review report writer.
//
// The PRIMARY safety guarantee is CONSTRUCTION: `renderReport` builds the report
// from finding METADATA ONLY (id, severity, file:line, title, impact, status,
// sha) — never from any raw code/body. As DEFENSE IN DEPTH it collapses every
// embedded newline/control character in a title/impact to a single space, so the
// report stays single-line-per-field by construction: a finding can never break
// the markdown structure, smuggle a multi-line fenced code block, or terminate a
// field. This hardens the "metadata-only" floor BEYOND what findings-io enforces
// (findings-io validates path safety + structure, but does NOT strip newlines
// from free-text title/impact). The secret scan is a best-effort SECOND layer.
//
// The secret scan is run by the CLI edge (W4) over the rendered body and INJECTED
// here as a SecretScanResult; `writeReport` does not run it. `unavailable` aborts
// fail-closed (EXIT_SCANNER_UNAVAILABLE, file NOT written), `hit` aborts as a
// finding (EXIT_FAILURE, file NOT written), `clean` writes the report via the
// confined atomic writer to <reportsDir>/deep-review-<date>.md.

import path from 'node:path';
import { EXIT_OK, EXIT_FAILURE, EXIT_SCANNER_UNAVAILABLE } from './types.ts';
import type { FindingRecord, FindingsFileV2, FindingStatus, MachineError, SecretScanResult } from './types.ts';
import { HANDOFF_BLOCKING_STATUSES } from './types.ts';
import { writeConfined } from '../../runner/src/report.ts';

// ── Metadata-only field rendering ────────────────────────────────────────────

// Collapse every run of C0 control chars (0x00-0x1F: NUL/newline/CR/tab/…) and
// DEL (0x7F) to a SINGLE space, then trim. This is the construction-time
// guarantee that a free-text field (title/impact) renders on exactly one line: no
// embedded newline can break the markdown layout, and a smuggled "```" can never
// sit at the START of a line to open a fenced code block. Written as a codepoint
// scan (NOT a regex literal) so no control byte ever appears in this source —
// mirroring slice.ts `hasControlChar`.
function collapseToSingleLine(value: string): string {
  let out = '';
  let pendingGap = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      // A control char becomes a single space, but only once per run and never as
      // a leading space (out is empty), so runs collapse to one space.
      if (out.length > 0) pendingGap = true;
      continue;
    }
    if (pendingGap) {
      out += ' ';
      pendingGap = false;
    }
    out += value[i];
  }
  return out.trim();
}

// One bullet line of finding metadata. `withSha` appends the recorded slice SHA
// (only the Fixed bucket carries one). Every emitted string field is run through
// collapseToSingleLine so the bullet is single-line by construction.
function findingLine(finding: FindingRecord, withSha: boolean): string {
  const id = collapseToSingleLine(finding.id);
  const file = collapseToSingleLine(finding.file);
  const title = collapseToSingleLine(finding.title);
  const impact = collapseToSingleLine(finding.impact);
  const head = `- \`${id}\` [${finding.severity}] ${file}:${finding.line} — ${title} — impact: ${impact}`;
  if (!withSha) return head;
  const sha = collapseToSingleLine(finding.sha);
  return `${head} — sha: \`${sha}\``;
}

// A report section: a `## <heading>` plus one bullet per finding, or an explicit
// `_None._` placeholder so an empty bucket still renders valid markdown.
function section(heading: string, findings: FindingRecord[], withSha: boolean): string {
  const body =
    findings.length === 0
      ? '_None._'
      : findings.map((finding) => findingLine(finding, withSha)).join('\n');
  return `## ${heading}\n\n${body}`;
}

function byStatus(findings: FindingRecord[], status: FindingStatus): FindingRecord[] {
  return findings.filter((finding) => finding.status === status);
}

// Builds the deep-review markdown report from finding METADATA ONLY. Pure: no
// effects, deterministic for a given findings file. Every lifecycle bucket renders
// its own section (Fixed carries SHAs; the rest carry their one-line title/impact
// plan). When any finding is still in a HANDOFF_BLOCKING status (pending /
// infra-blocked) the report opens with an INCOMPLETE marker naming the count.
export function renderReport(findingsFile: FindingsFileV2): string {
  const { findings } = findingsFile;
  const blocking = findings.filter((f) => HANDOFF_BLOCKING_STATUSES.includes(f.status)).length;

  const parts: string[] = [];
  if (blocking > 0) {
    parts.push(`> INCOMPLETE: ${blocking} findings not terminal`);
  }
  parts.push(
    `# Deep-Review Report`,
    `- Mode: ${collapseToSingleLine(findingsFile.mode)}`,
    `- Generated: ${collapseToSingleLine(findingsFile.generated_at)}`,
    section('Fixed', byStatus(findings, 'fixed'), true),
    section('Pending', byStatus(findings, 'pending'), false),
    section('Infra-blocked', byStatus(findings, 'infra-blocked'), false),
    section('Fix-failed', byStatus(findings, 'fix-failed'), false),
    section('No-touch', byStatus(findings, 'no-touch'), false),
    section('Needs-plan', byStatus(findings, 'needs-plan'), false),
    section('Invalid', byStatus(findings, 'invalid'), false),
  );
  return `${parts.join('\n\n')}\n`;
}

// ── Write seam ───────────────────────────────────────────────────────────────

// The injected effects for `writeReport`. `reportsDir` is the manifest's `paths.reports`
// (BUG-11: kept REPO-RELATIVE by the CLI, confined against `repoRootAbs`, below — never
// pre-resolved to an absolute path by the caller). `scanResult` is the secret scan of the
// rendered body, already run by the CLI edge. `now` (default `() => new Date()`) yields the
// report date; `write` (default `writeConfined`) performs the confined atomic write and returns
// the absolute path.
export interface WriteReportDeps {
  reportsDir: string;
  // BUG-11: the CONFINEMENT ROOT for the atomic writer. Optional so a caller that already
  // resolved `reportsDir` to an absolute, pre-confined directory (report.test.ts's fixtures)
  // keeps writing there unchanged — passing a bare directory as its OWN confinement root makes
  // `writeConfined`'s check tautological (a directory is always "within itself"), which is
  // exactly the bug: a manifest `paths.reports` of `../outside` or a symlinked ancestor escaped
  // the repo undetected. The CLI edge (cli.ts) always supplies this as the TRUE repo root
  // (`env.realpath(env.cwd)`) with `reportsDir` kept REPO-RELATIVE, mirroring
  // runner/src/report.ts's own `writeReport(report, root, reportsPath)`.
  repoRootAbs?: string;
  scanResult: SecretScanResult;
  now?: () => Date;
  write?: (rootDir: string, relPath: string, content: string) => string;
}

// What `writeReport` returns at the command edge: an exit code, plus EITHER the
// written path (success) OR a §2.4 MachineError (a secret-scan hit or an
// unavailable scanner). Both are OMITTED (never undefined) under
// exactOptionalPropertyTypes when not applicable.
export interface ReportResult {
  exitCode: number;
  machineError?: MachineError;
  path?: string;
}

// The UTC date stamp (YYYY-MM-DD) used in the report filename. Taken from the
// injected clock so the filename is deterministic in tests; UTC (not local) so it
// never depends on the host timezone.
function reportDate(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}

// Guards the injected scan result, then writes the metadata-only report on a clean
// scan. `unavailable` → EXIT_SCANNER_UNAVAILABLE (fail-closed: a scanner that could
// not run must NOT let content through). `hit` → EXIT_FAILURE. Both abort BEFORE
// any write. `clean` → render + confined atomic write to
// <reportsDir>/deep-review-<date>.md, returning the written path.
export function writeReport(findingsFile: FindingsFileV2, deps: WriteReportDeps): ReportResult {
  const now = deps.now ?? (() => new Date());
  const write = deps.write ?? writeConfined;
  const { scanResult } = deps;

  if (scanResult.status === 'unavailable') {
    const machineError: MachineError = {
      command: 'deep-review report',
      step: 'secret-scan',
      message: 'secret scanner unavailable; refusing to write report (fail-closed)',
      stderr_tail: scanResult.reason,
    };
    return { exitCode: EXIT_SCANNER_UNAVAILABLE, machineError };
  }
  if (scanResult.status === 'hit') {
    const machineError: MachineError = {
      command: 'deep-review report',
      step: 'secret-scan',
      message: 'secret scan flagged the rendered report; refusing to write',
      stderr_tail: scanResult.findings,
    };
    return { exitCode: EXIT_FAILURE, machineError };
  }

  const body = renderReport(findingsFile);
  const filename = `deep-review-${reportDate(now)}.md`;
  // BUG-11: when a TRUE confinement root is supplied, the write target is `reportsDir` joined
  // under THAT root (path.join, not path.resolve — reportsDir must stay a RELATIVE operand so
  // writeConfined's own realpath check can catch a `../` or a symlinked-ancestor escape). Without
  // one (the pre-existing direct-caller shape), `reportsDir` is used exactly as before: itself
  // the confinement root, with the bare filename as the relative target.
  const [rootDir, relPath] =
    deps.repoRootAbs === undefined ? [deps.reportsDir, filename] : [deps.repoRootAbs, path.join(deps.reportsDir, filename)];
  const filePath = write(rootDir, relPath, body);
  return { exitCode: EXIT_OK, path: filePath };
}
