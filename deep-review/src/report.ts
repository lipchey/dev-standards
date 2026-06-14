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
// `writeReport` renders the body, then runs an injected secret scanner over the
// rendered string; a hit ABORTS (EXIT_FAILURE + a §2.4 MachineError naming step
// "secret-scan") and the file is NOT written. Only on a clean scan is the file
// written, via the injected write seam, to <reportsDir>/deep-review-<date>.md.
// All effects (now/scanner/fs-write) live behind injected deps; the renderer is
// pure. The default scanner is `createSecretScanner` (workflow/src/secret-scan.ts),
// which is a NO-OP returning clean where no `<root>/tools/run-gitleaks` wrapper
// exists — true of dev-standards and every fixture repo.

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { EXIT_OK, EXIT_FAILURE } from './types.ts';
import type { FindingRecord, FindingsFile, FindingStatus, MachineError } from './types.ts';
import { createSecretScanner } from '../../workflow/src/secret-scan.ts';

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
// effects, deterministic for a given findings file. Groups findings into Fixed
// (with SHAs) and the three rejected buckets — No-touch, Needs-plan, Fix-failed —
// whose one-line plan IS the title/impact bullet. Empty / all-rejected files
// still render a valid (non-crashing) report.
export function renderReport(findingsFile: FindingsFile): string {
  const { findings } = findingsFile;
  const sections = [
    `# Deep-Review Report`,
    `- Mode: ${collapseToSingleLine(findingsFile.mode)}`,
    `- Generated: ${collapseToSingleLine(findingsFile.generated_at)}`,
    section('Fixed', byStatus(findings, 'fixed'), true),
    section('No-touch', byStatus(findings, 'no-touch'), false),
    section('Needs-plan', byStatus(findings, 'needs-plan'), false),
    section('Fix-failed', byStatus(findings, 'fix-failed'), false),
  ];
  return `${sections.join('\n\n')}\n`;
}

// ── Write seam ───────────────────────────────────────────────────────────────

// The injected effects for `writeReport`. `reportsDir` is the manifest's
// `paths.reports` (the CLI resolves it against the repo root); `writeFile` is the
// fs-write seam; `now` (default `() => new Date()`) yields the report date; `scan`
// (default `createSecretScanner()`, a no-op-clean where no tools/run-gitleaks
// wrapper exists) is the best-effort second-layer secret scanner over the
// rendered body. `now`/`scan` are OPTIONAL (defaulted) so a caller can wire only
// the destination + writer; the CLI overrides `scan` to pin the repo-root cwd.
export interface WriteReportDeps {
  reportsDir: string;
  writeFile: (filePath: string, content: string) => void;
  now?: () => Date;
  scan?: (body: string) => string | null;
}

// What `writeReport` returns at the command edge: an exit code, plus EITHER the
// written path (success) OR a §2.4 MachineError (a secret-scan hit). Both are
// OMITTED (never undefined) under exactOptionalPropertyTypes when not applicable.
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

// Renders the report, secret-scans the rendered body, and writes it on a clean
// scan. A scan HIT aborts: the file is NOT written and a §2.4 MachineError naming
// step "secret-scan" is returned with EXIT_FAILURE. The metadata-only renderer is
// the primary guarantee; this scan is the best-effort second layer.
export function writeReport(findingsFile: FindingsFile, deps: WriteReportDeps): ReportResult {
  const now = deps.now ?? (() => new Date());
  const scan = deps.scan ?? createSecretScanner();

  const body = renderReport(findingsFile);
  const filePath = path.join(deps.reportsDir, `deep-review-${reportDate(now)}.md`);

  const hit = scan(body);
  if (hit !== null) {
    const machineError: MachineError = {
      command: 'deep-review report',
      step: 'secret-scan',
      message: 'secret scan flagged the rendered report; refusing to write',
      stderr_tail: hit,
    };
    return { exitCode: EXIT_FAILURE, machineError };
  }

  deps.writeFile(filePath, body);
  return { exitCode: EXIT_OK, path: filePath };
}

// The production deps: the report date from the real clock, the secret scanner
// pinned to the repo-root `cwd` (so it resolves `<root>/tools/run-gitleaks` and a
// custom `<root>/.gitleaks.toml` deterministically — no-op-clean where neither
// exists), and a real fs write. Mirrors slice.ts `realSliceDeps`.
export function realReportDeps(cwd: string, reportsDir: string): WriteReportDeps {
  return {
    reportsDir,
    now: () => new Date(),
    scan: createSecretScanner({ cwd: () => cwd }),
    writeFile: (filePath, content) => {
      writeFileSync(filePath, content);
    },
  };
}
