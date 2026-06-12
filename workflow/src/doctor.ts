// §6 (spec) `workflow doctor` — the NON-mutating setup/health diagnosis. It takes
// NO lock (reads take no lock) and NEVER writes the planning file, the manifest,
// or git history. It runs a list of independent named checks, each returning a
// {name, ok, detail} record, then prints the §2.2 transition table.
//
// The pure check/decision logic is kept separate from the fs/git/probe EDGE: every
// side-effecting effect (file existence, directory writability, the cmux session
// probe, the `gh auth status` probe, the per-runtime wrapper probe, env reads) is
// reached only through INJECTED seams (DoctorProbes), so each check has a green AND
// a failing fixture in tests without touching the real machine. `realDoctorProbes`
// wires the real implementations for the runner edge.
//
// The real cmux (S13) and wrapper adapters DO NOT EXIST YET, so their real probes
// default to reporting "absent" — doctor's arming checks therefore block until
// those adapters land, which is the intended pre-arming guard. `gh` is a real CLI,
// so its probe really runs `gh auth status` (fixed argv, shell:false); tests drive
// it with an injected stub or a PATH stub (`tests/stubs/gh`).
//
// The §2.8 workflow-config validity check REUSES the S10 manifest validator
// (runner/src/validate.ts) — doctor never re-implements the rule logic; it runs
// the validator and keeps only the workflow-scoped errors.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  EXIT_FAILURE,
  EXIT_OK,
} from './types.ts';
import { CorruptStateError, parseFrontMatter } from './front-matter.ts';
import { computeDivergence, splitPlanningFile } from './recover.ts';
import { SEAT_MAP, TRANSITION_TABLE } from './transitions.ts';
import type { RunGit } from './trailers.ts';
import { validate } from '../../runner/src/validate.ts';
import { probeCmux } from './cmux-adapter.ts';

// ── Result + probe seams ─────────────────────────────────────────────────────

// One diagnosis line. `blocking` distinguishes a check that fails the run (a
// non-zero exit) from a warn-only check (notify-env): a non-blocking failure is
// reported but never changes the exit code.
export interface DoctorCheck {
  name: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean; // every BLOCKING check passed
  exitCode: number; // EXIT_OK (0) when ok, else EXIT_FAILURE (1)
  transitionTable: string; // the printed §2.2 transition table
}

// A probe outcome: success, or absence/failure with a human detail.
export interface ProbeResult {
  ok: boolean;
  detail: string;
}

// The injected effect edge. fs existence/writability, env reads, and the three
// async-capability probes (cmux, per-runtime wrapper, gh auth) live here so each
// check is deterministically green or failing in tests. The runner edge supplies
// `realDoctorProbes()`.
export interface DoctorProbes {
  fileExists: (filePath: string) => boolean;
  dirWritable: (dirPath: string) => boolean;
  getEnv: (name: string) => string | undefined;
  probeCmux: () => ProbeResult; // arming-only: cmux session reachability (S13 adapter)
  probeWrapper: (runtime: 'claude' | 'codex') => ProbeResult; // arming-only: wrapper presence
  probeGhAuth: () => ProbeResult; // enabled-only: `gh` present + authenticated (S14 adapter)
}

// The inputs doctor needs, all resolved by the caller (the CLI edge). `arming` is
// the explicit conditional that gates the cmux + wrapper checks; `repoRoot` roots
// the review-guide / project-facts existence checks.
export interface DoctorDeps {
  planningFile: string;
  worktree: string;
  manifestPath: string; // quality.json
  repoRoot: string; // base for resolving review guides + project-facts
  projectFactsPath: string; // resolved path to the project-facts doc
  arming: boolean; // run the cmux + wrapper "when arming" checks
  readFile: (filePath: string) => string;
  run: RunGit;
  probes: DoctorProbes;
}

// ── Check names (pinned so call sites + tests reference by name) ──────────────

export const CHECK_SCHEMA_PARSE = 'schema-parse';
export const CHECK_DIVERGENCE = 'divergence';
export const CHECK_CONFIG = 'config';
export const CHECK_REVIEW_GUIDES = 'review-guides';
export const CHECK_WORKTREE_PARENT = 'worktree-parent-writable';
export const CHECK_CMUX = 'cmux-probe';
export const CHECK_WRAPPER = 'wrapper-presence';
export const CHECK_GH_AUTH = 'gh-auth';
export const CHECK_NOTIFY_ENV = 'notify-env';

// ── Manifest workflow-block extraction (pure) ────────────────────────────────

// A read of the workflow block from the parsed manifest, separating "could not
// load/parse the manifest" from "no workflow block" from "present".
interface WorkflowConfigView {
  loadError: string | null; // set when quality.json is unreadable/unparseable
  present: boolean; // the `workflow` key exists
  workflow: Record<string, unknown> | null; // the raw workflow object when present
  manifest: unknown; // the parsed manifest (for the §2.8 validator)
}

function loadWorkflowConfig(deps: DoctorDeps): WorkflowConfigView {
  let raw: string;
  try {
    raw = deps.readFile(deps.manifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { loadError: `cannot read ${deps.manifestPath}: ${detail}`, present: false, workflow: null, manifest: null };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { loadError: `${deps.manifestPath} is not valid JSON: ${detail}`, present: false, workflow: null, manifest: null };
  }
  const present = isRecord(manifest) && Object.hasOwn(manifest, 'workflow');
  const workflowVal = isRecord(manifest) ? manifest['workflow'] : undefined;
  const workflow = isRecord(workflowVal) ? workflowVal : null;
  return { loadError: null, present, workflow, manifest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ── Individual checks ────────────────────────────────────────────────────────

// (1) The planning file parses as a valid front-matter document.
function checkSchemaParse(deps: DoctorDeps): DoctorCheck {
  try {
    const { frontMatterText } = splitPlanningFile(deps.readFile(deps.planningFile));
    parseFrontMatter(frontMatterText);
    return ok(CHECK_SCHEMA_PARSE, `planning file at ${deps.planningFile} parses`);
  } catch (error) {
    if (error instanceof CorruptStateError) {
      return fail(CHECK_SCHEMA_PARSE, `planning file is corrupt: ${error.message}`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return fail(CHECK_SCHEMA_PARSE, `cannot read planning file: ${detail}`);
  }
}

// (2) The runtime front-matter state does NOT diverge from HEAD's durable trailer.
function checkDivergence(deps: DoctorDeps): DoctorCheck {
  try {
    const diverged = computeDivergence({
      planningFile: deps.planningFile,
      worktree: deps.worktree,
      readFile: deps.readFile,
      run: deps.run,
    });
    return diverged
      ? fail(CHECK_DIVERGENCE, 'front matter diverges from the HEAD Workflow-Phase trailer; run `workflow recover`')
      : ok(CHECK_DIVERGENCE, 'front matter matches the HEAD Workflow-Phase trailer');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(CHECK_DIVERGENCE, `cannot evaluate divergence: ${detail}`);
  }
}

// (3) The §2.8 workflow config is present AND valid (reusing the S10 validator).
function checkConfig(deps: DoctorDeps, cfg: WorkflowConfigView): DoctorCheck {
  if (cfg.loadError !== null) {
    return fail(CHECK_CONFIG, cfg.loadError);
  }
  if (!cfg.present) {
    return fail(CHECK_CONFIG, `no workflow block (§2.8) in ${deps.manifestPath}`);
  }
  // Reuse the S10 manifest validator; keep only the workflow-scoped errors.
  const errors = validate(cfg.manifest).errors.filter(
    (e) => e.path === 'workflow' || e.path.startsWith('workflow.'),
  );
  if (errors.length > 0) {
    const first = errors[0];
    const summary = first === undefined ? '' : `${first.path}: ${first.message}`;
    return fail(CHECK_CONFIG, `workflow config invalid (§2.8): ${summary}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
  }
  return ok(CHECK_CONFIG, 'workflow config present and §2.8-valid');
}

// (4) Every required review guide AND the project-facts doc exist on disk.
function checkReviewGuides(deps: DoctorDeps, cfg: WorkflowConfigView): DoctorCheck {
  const guidesVal = cfg.workflow?.['required_review_guides'];
  if (cfg.workflow === null) {
    return fail(CHECK_REVIEW_GUIDES, 'cannot check review guides: workflow config is absent/invalid');
  }
  if (!isStringArray(guidesVal)) {
    return fail(CHECK_REVIEW_GUIDES, 'workflow.required_review_guides is missing or not a string array');
  }
  const missing: string[] = [];
  for (const rel of guidesVal) {
    if (!deps.probes.fileExists(resolveUnder(deps.repoRoot, rel))) missing.push(rel);
  }
  if (!deps.probes.fileExists(deps.projectFactsPath)) {
    missing.push(deps.projectFactsPath);
  }
  return missing.length === 0
    ? ok(CHECK_REVIEW_GUIDES, `all ${guidesVal.length} review guide(s) + project-facts exist`)
    : fail(CHECK_REVIEW_GUIDES, `missing: ${missing.join(', ')}`);
}

// (5) The configured worktree parent directory is writable (new worktrees land there).
function checkWorktreeParent(deps: DoctorDeps, cfg: WorkflowConfigView): DoctorCheck {
  const parentVal = cfg.workflow?.['worktree_parent'];
  if (typeof parentVal !== 'string' || parentVal.length === 0) {
    return fail(CHECK_WORKTREE_PARENT, 'workflow.worktree_parent is missing or not a non-empty string');
  }
  const resolved = resolveUnder(deps.repoRoot, parentVal);
  return deps.probes.dirWritable(resolved)
    ? ok(CHECK_WORKTREE_PARENT, `worktree parent "${parentVal}" is writable`)
    : fail(CHECK_WORKTREE_PARENT, `worktree parent "${parentVal}" (${resolved}) is not writable`);
}

// (6) ARMING-ONLY: the cmux session is reachable (the real adapter lands in S13).
function checkCmux(deps: DoctorDeps): DoctorCheck {
  const probe = deps.probes.probeCmux();
  return probe.ok
    ? ok(CHECK_CMUX, `cmux probe: ${probe.detail}`)
    : fail(CHECK_CMUX, `cmux probe failed: ${probe.detail}`);
}

// (7) ARMING-ONLY: a wrapper is present for BOTH runtimes before arming any pane.
function checkWrappers(deps: DoctorDeps): DoctorCheck {
  const claude = deps.probes.probeWrapper('claude');
  const codex = deps.probes.probeWrapper('codex');
  if (claude.ok && codex.ok) {
    return ok(CHECK_WRAPPER, 'claude + codex wrappers present');
  }
  const parts: string[] = [];
  if (!claude.ok) parts.push(`claude: ${claude.detail}`);
  if (!codex.ok) parts.push(`codex: ${codex.detail}`);
  return fail(CHECK_WRAPPER, `wrapper missing — ${parts.join('; ')}`);
}

// (8) ENABLED-ONLY: `gh` is present and authenticated (`gh auth status`).
function checkGhAuth(deps: DoctorDeps): DoctorCheck {
  const probe = deps.probes.probeGhAuth();
  return probe.ok
    ? ok(CHECK_GH_AUTH, `gh authenticated: ${probe.detail}`)
    : fail(CHECK_GH_AUTH, `gh not usable: ${probe.detail}`);
}

// (9) WARN-ONLY: the notify webhook env var is set (never blocks the diagnosis).
function checkNotifyEnv(deps: DoctorDeps, cfg: WorkflowConfigView): DoctorCheck {
  const notifyVal = cfg.workflow?.['notify'];
  const webhookEnv = isRecord(notifyVal) ? notifyVal['webhook_env'] : undefined;
  if (typeof webhookEnv !== 'string' || webhookEnv.length === 0) {
    return warn(CHECK_NOTIFY_ENV, 'workflow.notify.webhook_env is not configured');
  }
  const value = deps.probes.getEnv(webhookEnv);
  return value !== undefined && value.length > 0
    ? warnOk(CHECK_NOTIFY_ENV, `notify env ${webhookEnv} is set`)
    : warn(CHECK_NOTIFY_ENV, `notify env ${webhookEnv} is not set (notifications will be skipped)`);
}

// ── Runner ───────────────────────────────────────────────────────────────────

// Runs every check, then folds them into the result. The "when arming" checks
// (cmux, wrappers) run ONLY when arming; the gh check runs ONLY when the workflow
// is enabled. The exit code is driven by the BLOCKING checks alone.
export function runDoctor(deps: DoctorDeps): DoctorResult {
  const cfg = loadWorkflowConfig(deps);
  const enabled = cfg.workflow?.['enabled'] === true;

  const checks: DoctorCheck[] = [
    checkSchemaParse(deps),
    checkDivergence(deps),
    checkConfig(deps, cfg),
    checkReviewGuides(deps, cfg),
    checkWorktreeParent(deps, cfg),
  ];
  if (deps.arming) {
    checks.push(checkCmux(deps));
    checks.push(checkWrappers(deps));
  }
  if (enabled) {
    checks.push(checkGhAuth(deps));
  }
  checks.push(checkNotifyEnv(deps, cfg));

  const blockingOk = checks.every((c) => !c.blocking || c.ok);
  return {
    checks,
    ok: blockingOk,
    exitCode: blockingOk ? EXIT_OK : EXIT_FAILURE,
    transitionTable: formatTransitionTable(),
  };
}

// ── Transition-table rendering (pure, from the frozen table + seat map) ───────

// Renders the §2.2 transition table + §2.3 seats as a fixed-width text block.
export function formatTransitionTable(): string {
  const lines: string[] = ['transition table (§2.2 / §2.3 seats):'];
  for (const row of TRANSITION_TABLE) {
    const seat = SEAT_MAP[row.phase];
    const pre = row.preconditions.length === 0 ? '(none)' : row.preconditions.join(' | ');
    const start = row.start === null ? '(no in-progress)' : row.start;
    const loop = row.changes_requested === null ? '' : ` changes->${row.changes_requested}`;
    lines.push(
      `  ${row.order} ${row.phase} [${seat}]: ${pre} -> start:${start} -> success:${row.success}${loop} (fail:${row.failure})`,
    );
  }
  return lines.join('\n');
}

// ── Small builders ───────────────────────────────────────────────────────────

function ok(name: string, detail: string): DoctorCheck {
  return { name, ok: true, blocking: true, detail };
}

function fail(name: string, detail: string): DoctorCheck {
  return { name, ok: false, blocking: true, detail };
}

// Warn-only check helpers: never blocking, so a failure is reported but never
// changes the exit code.
function warnOk(name: string, detail: string): DoctorCheck {
  return { name, ok: true, blocking: false, detail };
}

function warn(name: string, detail: string): DoctorCheck {
  return { name, ok: false, blocking: false, detail };
}

// Resolves a manifest-relative path under the repo root. Absolute paths are kept
// as-is; relative ones are joined onto the root (no path traversal normalization
// beyond join — the manifest is trusted config, validated by the §2.8 check).
function resolveUnder(root: string, rel: string): string {
  if (rel.startsWith('/')) return rel;
  return `${root}/${rel}`;
}

// ── Real edge (the runner wires these; tests inject stubs) ────────────────────

// Real probes for the runner edge. The cmux adapter probes its fixed required
// verbs; wrappers do not exist until the skill-wrapper generator lands, so they
// still report "absent" and block arming. `gh` is a real CLI, so its probe runs
// `gh auth status` with a fixed argv.
export function realDoctorProbes(): DoctorProbes {
  return {
    fileExists: (filePath) => fs.existsSync(filePath),
    dirWritable: (dirPath) => {
      try {
        fs.accessSync(dirPath, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    getEnv: (name) => process.env[name],
    probeCmux,
    probeWrapper: (runtime) => ({
      ok: false,
      detail: `${runtime} wrapper adapter not yet available (skill-wrapper generator); cannot verify presence`,
    }),
    probeGhAuth: realGhAuthProbe,
  };
}

// Real `gh auth status` probe: fixed-argv spawnSync (shell:false; untrusted state
// never reaches a shell). A missing binary (ENOENT) reports "gh not found"; a
// non-zero status reports "not authenticated"; status 0 is authenticated.
export function realGhAuthProbe(): ProbeResult {
  const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', shell: false });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, detail: 'gh not found on PATH' };
    return { ok: false, detail: `gh probe failed: ${result.error.message}` };
  }
  if (result.status === 0) {
    return { ok: true, detail: 'gh auth status reports an authenticated account' };
  }
  const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || 'gh auth status reported a non-zero status';
  return { ok: false, detail: `gh not authenticated: ${detail.split('\n')[0] ?? detail}` };
}
