// The deep-review CLI dispatch. `runCli` parses argv into a subcommand and routes
// it through a dispatch table with one entry per command. Every command is a STUB
// in E0 (returns EXIT_USAGE) — the later tasks (no-touch matcher, classifier,
// slice engine, report writer, worktree/handoff/verify) replace the stub bodies.
// An unknown or missing subcommand prints usage to stderr and returns EXIT_USAGE.
// Logic stays behind the injected `deps` seam (process streams) so it is testable
// without touching the real process, mirroring the runner CLI edge style.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { EXIT_OK, EXIT_USAGE, EXIT_FAILURE, EXIT_PREFLIGHT, EXIT_DESCRIPTOR_MISMATCH } from './types.ts';
import type { MachineError, FindingsFileV2 } from './types.ts';
import { loadConfig } from './config.ts';
import type { DeepReviewConfig } from './config.ts';
import { buildNoTouchSet, isNoTouch, NoTouchSourceError, policyProtectedPaths, selfProtectedPaths } from './no-touch.ts';
import { assertSafeRepoPath, readFindings, FindingsValidationError, FindingsConflictError } from './findings-io.ts';
import { classifyAndBind } from './classify.ts';
import { commitSlice, realSliceDeps } from './slice.ts';
import { writeReport, renderReport } from './report.ts';
import { selectWorktree, realWorktreeDeps } from './worktree.ts';
import { decideHandoff, realHandoffDeps } from './handoff.ts';
import { runFinalVerify, realVerifyDeps } from './verify.ts';
import { SlugError, sanitizeFeatureSlug } from './feature-slug.ts';
import { runPreflight } from './preflight.ts';
import { createDeadline } from './deadline.ts';
import type { Deadline } from './deadline.ts';
import { createSecretScanner } from './secret-scan.ts';
import { readDescriptor, verifyDescriptor } from './descriptor.ts';
import type { DescriptorVerdict, RunDescriptor, DeepReviewContext } from './descriptor.ts';
import { evaluateGuidesRead } from './guides-read.ts';
import type { GuidesReadDecision } from './guides-read.ts';
import { REVIEW_GUIDE_TEMPLATES_DIR } from './guides.ts';

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Environment seams (added in E1; reused by E2–E4). The entrypoint
  // (deep-review-runner.ts) supplies only the stream sinks above; these default
  // to the real process/fs when omitted, so the edge stays minimal. Tests inject
  // all of them to keep command logic off the real process and disk.
  cwd?: () => string;
  readFile?: (filePath: string) => string;
  warn?: (message: string) => void;
  // The git-side run-identity gate (Phase 5 §5.2), injected so the fix verbs' CLI
  // identity check is unit-testable without a real run-worktree; defaults to the real
  // descriptor gate. §F7: the run deadline is threaded so its git spawns are bounded.
  verifyDescriptor?: (cwd: string, deadline: Deadline) => DescriptorVerdict;
  // realpath for the fix-mode no-touch-ref confinement (commit-slice); defaults to
  // fs.realpathSync.
  realpath?: (p: string) => string;
  /* The guides-read hook edge (Stop/SubagentStop). Injected so the gate is unit-testable
     without a real hook envelope on fd 0, the real environment, or the real marker file. */
  readStdin?: () => string;
  getEnv?: (name: string) => string | undefined;
  fileExists?: (filePath: string) => boolean;
  /* The linked worktrees of the repo at a cwd (approved roots for a guide read). Injected
     so the gate is testable without a real git checkout; defaults to `git worktree list`. */
  worktreeRoots?: (cwd: string) => string[];
}

// The full command surface. Each lands in its own later task; all are stubbed now.
const COMMANDS = [
  'check-path',
  'classify',
  'commit-slice',
  'report',
  'select-worktree',
  'handoff',
  'verify',
  'guides-read',
] as const;

type Command = (typeof COMMANDS)[number];

type CommandHandler = (rest: string[], deps: CliDeps) => number;

const USAGE = `usage: deep-review <command> [options]\ncommands: ${COMMANDS.join(', ')}\n`;

// The optional env seams, resolved to concrete functions.
interface ResolvedEnv {
  cwd: string;
  readFile: (filePath: string) => string;
  warn: (message: string) => void;
  verifyDescriptor: (cwd: string, deadline: Deadline) => DescriptorVerdict;
  realpath: (p: string) => string;
}

// Resolves the optional CliDeps env seams (cwd/readFile/warn/verifyDescriptor/
// realpath) to concrete functions, defaulting to the real process/fs. Shared by
// every handler that touches the repo edge so the defaulting lives in one place.
function resolveEnv(deps: CliDeps): ResolvedEnv {
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const readFile = deps.readFile ?? ((p: string): string => readFileSync(p, 'utf8'));
  const warn = deps.warn ?? ((message: string): void => deps.stderr(`${message}\n`));
  const verifyDescriptorFn =
    deps.verifyDescriptor ?? ((c: string, deadline: Deadline): DescriptorVerdict => verifyDescriptor(c, { deadline }));
  const realpath = deps.realpath ?? ((p: string): string => realpathSync(p));
  return { cwd, readFile, warn, verifyDescriptor: verifyDescriptorFn, realpath };
}

// ── Fix-verb identity gate (Phase 5 §5.2) ──────────────────────────────────────

// The verified-run handle a fix verb needs after the identity gate passes.
interface IdentityOk {
  ok: true;
  descriptor: RunDescriptor;
  findingsFile: FindingsFileV2;
}
interface IdentityFail {
  ok: false;
  exitCode: number;
  machineError: MachineError;
}

// The §5.2 identity gate every fix verb (commit-slice / verify / handoff) runs BEFORE
// any mutation: (1) the git-side descriptor gate (worktree matches the run it was
// created for), then (2) the findings are BOUND and their run_id + base_sha match the
// descriptor. Any divergence (including an unbound draft) -> EXIT_DESCRIPTOR_MISMATCH
// with nothing mutated. readFindings may throw on a malformed file -> the runCli
// boundary turns it into a §2.4 machine error.
function identityGate(env: ResolvedEnv, verb: string, findingsPath: string, deadline: Deadline): IdentityOk | IdentityFail {
  const verdict = env.verifyDescriptor(env.cwd, deadline);
  if (!verdict.ok) {
    return {
      ok: false,
      exitCode: EXIT_DESCRIPTOR_MISMATCH,
      machineError: { command: `deep-review ${verb}`, message: `run identity mismatch: ${verdict.reason}`, stderr_tail: '' },
    };
  }
  const findingsFile = readFindings(findingsPath, { readFile: env.readFile });
  const d = verdict.descriptor;
  if (
    findingsFile.run_id === null ||
    findingsFile.base_sha === null ||
    findingsFile.run_id !== d.run_id ||
    findingsFile.base_sha !== d.base_sha
  ) {
    const message =
      findingsFile.run_id === null
        ? 'findings are unbound (run deep-review classify inside the run worktree to bind them)'
        : `findings identity mismatch: findings are bound to ${findingsFile.run_id}/${findingsFile.base_sha}, descriptor is ${d.run_id}/${d.base_sha}`;
    return {
      ok: false,
      exitCode: EXIT_DESCRIPTOR_MISMATCH,
      machineError: { command: `deep-review ${verb}`, message, stderr_tail: '' },
    };
  }
  return { ok: true, descriptor: d, findingsFile };
}

// Builds the ONE whole-run context (§0) the fix verbs thread down: the reports
// confinement root, the single monotonic deadline (created at the CLI edge and REUSED
// here, §F7, so identity/preflight and the engine share one budget), and the verified
// descriptor.
function buildContext(
  env: ResolvedEnv,
  config: DeepReviewConfig,
  descriptor: RunDescriptor,
  deadline: Deadline,
): DeepReviewContext {
  return {
    canonicalRoot: descriptor.canonical_root,
    reportsRootAbs: resolve(env.cwd, config.reportsDir),
    deadline,
    descriptor,
    verifyEntry: config.verifyEntry,
  };
}

// Builds the §2.5 no-touch set (BASELINE ∪ the repo's project-facts extensions) from an
// already-loaded config, wiring the resolved env seams. Shared by `check-path` and
// `classify`. §F11: even in review-only mode the ref is confined under the realpath'd
// repo root, so an ESCAPING `no_touch_globs_ref` (a `../` operand or a symlinked ancestor)
// is rejected here too — the warn+baseline fallback survives ONLY for an in-root
// missing/unreadable ref, never for one that resolves outside the repo.
function buildSet(env: ResolvedEnv, config: DeepReviewConfig): string[] {
  return buildNoTouchSet({
    noTouchGlobsRef: config.noTouchGlobsRef,
    verifyEntry: config.verifyEntry,
    readFile: (p: string): string => env.readFile(resolve(env.cwd, p)),
    warn: env.warn,
    mode: 'review-only',
    repoRootAbs: env.realpath(env.cwd),
    realpath: env.realpath,
  });
}

// The FIX-mode no-touch set for commit-slice (the only mutating verb). Unlike the
// review-only `buildSet`, this is FAIL-CLOSED: a missing/unreadable/unparseable or
// escaping project-facts ref throws `NoTouchSourceError` (never a silent baseline —
// the engine is about to edit the repo on the strength of this set). The ref is
// confined under the realpath'd repo root in both directions. §F4: the engine's own
// policy inputs (`quality.json` + the resolved no-touch source file) are UNIONED in as
// no-touch, so a slice can never edit the files that define what is protected. (The verify
// shim is protected in every mode via buildNoTouchSet's verifyEntry, above.)
function buildFixSet(env: ResolvedEnv, config: DeepReviewConfig): string[] {
  const set = buildNoTouchSet({
    noTouchGlobsRef: config.noTouchGlobsRef,
    verifyEntry: config.verifyEntry,
    readFile: (p: string): string => env.readFile(resolve(env.cwd, p)),
    warn: env.warn,
    mode: 'fix',
    repoRootAbs: env.realpath(env.cwd),
    realpath: env.realpath,
  });
  /* The package guide-templates dir relative to the worktree root: `vendor/dev-standards/
     agents/review-guide-templates` in a consumer (already under the vendor/** baseline),
     `agents/review-guide-templates` in dev-standards itself. An escaping relative (templates
     outside the worktree — not a real deployment) is dropped by policyProtectedPaths. */
  const templatesRel = relative(env.cwd, REVIEW_GUIDE_TEMPLATES_DIR);
  return [
    ...new Set([
      ...set,
      ...selfProtectedPaths(config.noTouchGlobsRef),
      ...policyProtectedPaths(config.requiredReads, config.guidesDir, templatesRel),
    ]),
  ];
}

/* Preflight loads package guides plus the optional repo overlay before fix-mode verbs. */
function preflightFail(
  config: DeepReviewConfig,
  env: ResolvedEnv,
  verb: string,
  deps: CliDeps,
): number | undefined {
  const overlayDirectory = resolve(env.cwd, config.guidesDir);
  const outcome = runPreflight(config, verb, overlayDirectory);
  if (outcome.ok) return undefined;
  deps.stderr(`${JSON.stringify({ error: outcome.machineError })}\n`);
  return outcome.exitCode;
}

// Pulls the value of a `--findings <path>` / `--findings=<path>` flag from argv,
// or undefined when absent (or the flag is the trailing token).
function parseFindingsFlag(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--findings') return rest[i + 1];
    if (arg.startsWith('--findings=')) return arg.slice('--findings='.length);
  }
  return undefined;
}

// Pulls the value of a `--slug <slug>` / `--slug=<slug>` flag from argv, or
// undefined when absent (or the flag is the trailing token). Mirrors
// parseFindingsFlag; the value is validated downstream by sanitizeFeatureSlug.
function parseSlugFlag(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--slug') return rest[i + 1];
    if (arg.startsWith('--slug=')) return arg.slice('--slug='.length);
  }
  return undefined;
}

// Parses a `--scope <--fast|--full>` / `--scope=<…>` flag, returning whether the
// flag was PRESENT and its value. verifyCmd uses `present` to distinguish an ABSENT
// flag (fall back to the config default) from a PRESENT-but-valueless one (a trailing
// `--scope`, or `--scope=`), which is a malformed invocation -> EXIT_USAGE per §2.2 —
// NOT a request for the default. Mirrors parseSlugFlag's scan.
function parseScopeFlag(rest: string[]): { present: boolean; value: string | undefined } {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--scope') return { present: true, value: rest[i + 1] };
    if (arg.startsWith('--scope=')) return { present: true, value: arg.slice('--scope='.length) };
  }
  return { present: false, value: undefined };
}

// `check-path <path>` — classify a single repo-relative path as `no-touch` or
// `editable` against the §2.5 floor (BASELINE ∪ the repo's project-facts
// extensions). Pure matching lives in ./no-touch.ts; this handler only resolves
// the manifest + ref and wires the injected env seams.
function checkPath(rest: string[], deps: CliDeps): number {
  const operand = rest[0];
  if (operand === undefined) {
    deps.stderr('deep-review check-path: missing <path> operand\n');
    return EXIT_USAGE;
  }
  /* Reject an operand that escapes the repo / is absolute / carries glob or magic-pathspec
     metacharacters as EXIT_USAGE, argv-first (before config) like the select-worktree slug gate.
     Without this the matcher printed a misleading `editable` for an out-of-repo path the fix verbs
     later refuse (DR-16); the same `assertSafeRepoPath` floor governs finding paths in the engine. */
  try {
    assertSafeRepoPath(operand);
  } catch (error) {
    if (error instanceof FindingsValidationError) {
      deps.stderr(`deep-review check-path: invalid <path> operand ${JSON.stringify(operand)}: ${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  const env = resolveEnv(deps);
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  const set = buildSet(env, config);
  deps.stdout(`${isNoTouch(operand, set) ? 'no-touch' : 'editable'}\n`);
  return EXIT_OK;
}

// `classify --findings <path>` — assign each finding its `classification` +
// lifecycle `status` (precedence: no-touch → needs-plan → fixable-now) and persist via the sole
// mutator. Analysis, not a base mutation, so it runs in EITHER mode (§2.3 — no mode gate, no
// preflight). Pure rules live in ./classify.ts; the no-touch set reuses the same wiring as
// `check-path`. classifyAndBind also performs the unbound→bound transition when cwd is a run
// worktree (the descriptor, read here, supplies run_id/base_sha); review-only stays unbound.
function classify(rest: string[], deps: CliDeps): number {
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review classify: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  const set = buildSet(env, config);
  // Schema-v2 integration (W1 API): classify + bind in one CAS write through the sole mutator.
  // The unbound->bound transition needs the run descriptor when cwd is a run worktree (review-only
  // outside a worktree stays unbound). W4 (Wave 2) layers the full DeepReviewContext/identity gate.
  const descriptor = readDescriptor(env.cwd);
  const ctx = {
    reportsRootAbs: resolve(env.cwd, config.reportsDir),
    descriptor: descriptor === null ? null : { run_id: descriptor.run_id, base_sha: descriptor.base_sha },
  };
  classifyAndBind(findingsPath, ctx, set);
  return EXIT_OK;
}

// Pulls the first positional operand (the `<finding-id>`) from argv, skipping the
// `--findings <path>` flag (and its value) and any other `--flag`. Returns
// undefined when no positional is present.
function parseFindingId(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--findings') {
      i += 1; // skip the flag's value too
      continue;
    }
    if (arg.startsWith('--')) continue;
    return arg;
  }
  return undefined;
}

// `commit-slice <finding-id> --findings <path>` — the atomic slice engine (§5.1).
// The contract (reconcile → mode/eligibility/path/no-touch/scope gates → validate the
// slice in a one-shot worktree → green-commit-with-trailer | fix-failed | infra-blocked)
// lives in ./slice.ts; this handler parses the operands, runs the preflight + §5.2
// identity gate, builds the fail-closed fix-mode no-touch set + the run context, and
// renders any machine-readable error as the LAST line of stderr.
function commitSliceCmd(rest: string[], deps: CliDeps): number {
  const findingId = parseFindingId(rest);
  if (findingId === undefined || findingId === '') {
    deps.stderr('deep-review commit-slice: missing <finding-id> operand\n');
    return EXIT_USAGE;
  }
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review commit-slice: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  // §5.0: fix-mode preflight AFTER argv/usage validation, BEFORE the engine. Refuses (EXIT_PREFLIGHT)
  // unless fix-mode is enabled + allowed + the guides are available.
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  // §F7 the ONE run deadline, created right after argv/config validation (before preflight/identity)
  // and reused by the engine context, so identity + engine git spawns share one bounded budget.
  const deadline = createDeadline(config.budget.seconds);
  const pfExit = preflightFail(config, env, 'commit-slice', deps);
  if (pfExit !== undefined) return pfExit;
  // §5.2 identity gate BEFORE any mutation: the worktree matches the run + findings are bound to it.
  const identity = identityGate(env, 'commit-slice', findingsPath, deadline);
  if (!identity.ok) {
    deps.stderr(`${JSON.stringify({ error: identity.machineError })}\n`);
    return identity.exitCode;
  }
  // Build the FAIL-CLOSED fix-mode no-touch set (BASELINE ∪ the repo's project-facts extensions) and
  // hand it to the engine, which re-enforces the floor against the untrusted findings file (a slice
  // may name a no-touch path even when finding.file is editable). A missing/unreadable/escaping
  // project-facts ref throws NoTouchSourceError -> EXIT_PREFLIGHT (never a silent baseline).
  let noTouchSet: string[];
  try {
    noTouchSet = buildFixSet(env, config);
  } catch (error) {
    if (error instanceof NoTouchSourceError) {
      deps.stderr(`${JSON.stringify({ error: { command: 'deep-review commit-slice', message: error.message, stderr_tail: '' } })}\n`);
      return EXIT_PREFLIGHT;
    }
    throw error;
  }
  const ctx = buildContext(env, config, identity.descriptor, deadline);
  const result = commitSlice(findingId, findingsPath, realSliceDeps(env.cwd, ctx, noTouchSet));
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  }
  return result.exitCode;
}

// `report --findings <path>` — render + write the metadata-only deep-review
// report to <reportsDir>/deep-review-<date>.md. Construction is the primary
// safety guarantee (metadata only, single-line-per-field). Runs in EITHER mode
// (§2.3 — no mode gate, no preflight): it summarizes the run regardless of review-only vs
// review-and-refactor. The untrusted findings file goes through readFindings
// (real-fs default), which re-validates path safety. reportsDir comes from the
// manifest (paths.reports), resolved against the repo root. The rendered body is scanned at the
// cli edge (createSecretScanner, wrapper resolved under this root) and the SecretScanResult is
// handed to writeReport, which fails closed on `unavailable` (EXIT_SCANNER_UNAVAILABLE), aborts on
// `hit` (EXIT_FAILURE) with the §2.4 machine error as the LAST stderr line, and on `clean` writes +
// prints the path to stdout.
function report(rest: string[], deps: CliDeps): number {
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review report: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  const findingsFile = readFindings(findingsPath);
  // Schema-v2 integration (W1 API): render the body, run the secret scan at the cli edge, then hand
  // the SecretScanResult to writeReport (which fails closed on `unavailable`, aborts on `hit`, and
  // writes only on `clean`). The scanner resolves its wrapper under this repo/worktree root.
  const body = renderReport(findingsFile);
  const scanResult = createSecretScanner({ cwd: () => env.cwd })(body);
  const result = writeReport(findingsFile, {
    reportsDir: resolve(env.cwd, config.reportsDir),
    scanResult,
  });
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  } else if (result.path !== undefined) {
    deps.stdout(`${result.path}\n`);
  }
  return result.exitCode;
}

// `select-worktree --slug <slug>` — create an engine-local `deep-review/<slug>`
// worktree under `../worktrees` off the captured base SHA (E5 + §5.2). The §2 contract (sanitize
// gate, base resolution, confinement guard, collision/idempotency gate, run descriptor) lives in
// ./worktree.ts; this handler validates the --slug (SlugError -> EXIT_USAGE) FIRST, runs the §5.0
// fix-mode preflight, builds the run deadline, then delegates. A git failure renders the §2.4
// machine error as the LAST stderr line.
function selectWorktreeCmd(rest: string[], deps: CliDeps): number {
  const slug = parseSlugFlag(rest);
  if (slug === undefined || slug === '') {
    deps.stderr('deep-review select-worktree: missing --slug <slug>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  // §5.0 ORDER: argv/usage validation of the verb FIRST. An unsafe --slug is an argv-level usage
  // error, so sanitize it here (mapping SlugError -> EXIT_USAGE) BEFORE the config-reading preflight
  // — a bad operand must not be masked by a fix-mode-disabled EXIT_PREFLIGHT.
  try {
    sanitizeFeatureSlug(slug);
  } catch (error) {
    if (error instanceof SlugError) {
      deps.stderr(`deep-review select-worktree: invalid --slug operand ${JSON.stringify(slug)}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  // select-worktree is a fix-mode entry point (unlike E5, it now requires fix-mode configured).
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  const pfExit = preflightFail(config, env, 'select-worktree', deps);
  if (pfExit !== undefined) return pfExit;
  // The ONE monotonic run deadline (§0) — bounds every git spawn inside the selector.
  const deadline = createDeadline(config.budget.seconds);
  // The slug was already sanitized above, so selectWorktree's re-sanitize cannot throw here.
  const result = selectWorktree(slug, { ...realWorktreeDeps(env.cwd), deadline });
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  } else if (result.mode !== undefined && result.worktree !== undefined) {
    const branch = result.branch !== undefined ? ` ${result.branch}` : '';
    deps.stdout(`${result.mode} ${result.worktree}${branch}\n`);
  }
  return result.exitCode;
}

// `handoff --findings <path>` — emit the ADR-012 standalone landing instruction
// (E6). The engine is an instruction emitter ONLY: it lands nothing, names no merge
// verb, and never suggests any automated landing. The §2.3 mode gate means a
// `review-only` findings file returns
// EXIT_WRONG_STATE. handoff reads NO config — only cwd + the (untrusted) findings
// file, which goes through readFindings (real-fs default; a FindingsValidationError
// flows through runCli's toMachineError path). The chosen instruction is printed to
// stdout; on a branch-read failure the §2.4 machine error is the LAST stderr line.
function handoffCmd(rest: string[], deps: CliDeps): number {
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review handoff: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const env = resolveEnv(deps);
  // §5.0 fix-mode preflight lives at the cli edge ONLY — handoff.ts itself still reads NO config
  // (that invariant is preserved by keeping this gate out of the module).
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  // §F7 the ONE run deadline, bounding the identity gate + the read-only handoff git spawns.
  const deadline = createDeadline(config.budget.seconds);
  const pfExit = preflightFail(config, env, 'handoff', deps);
  if (pfExit !== undefined) return pfExit;
  // §5.2 identity gate BEFORE the completeness decision; the gate reads the findings once and hands
  // the validated file straight to decideHandoff (no double read).
  const identity = identityGate(env, 'handoff', findingsPath, deadline);
  if (!identity.ok) {
    deps.stderr(`${JSON.stringify({ error: identity.machineError })}\n`);
    return identity.exitCode;
  }
  const result = decideHandoff(identity.findingsFile, realHandoffDeps(env.cwd, deadline));
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  } else if (result.instruction !== undefined) {
    deps.stdout(`${result.instruction}\n`);
  }
  return result.exitCode;
}

// `verify --findings <path> [--scope <--fast|--full>]` — the final verify gate (E7).
// The deep-review runtime calls this AFTER all slices and BEFORE handoff: a GREEN
// verify (exit 0) records the verification stamp and clears the refactor to proceed;
// a RED verify is EXIT_NEEDS_HUMAN (13) and nothing lands. Scope is `--scope` ??
// deep_review.verify_after_fix ?? --full, validated here (an invalid operand is an
// argv-level usage error -> EXIT_USAGE before any spawn). The §2 contract (absolute
// fixed-argv shim spawn, exit mapping) lives in ./verify.ts; on a spawn failure the
// §2.4 machine error is the LAST stderr line, else a one-line status is printed.
function verifyCmd(rest: string[], deps: CliDeps): number {
  const env = resolveEnv(deps);
  // Argv/usage validation FIRST (before config / preflight / identity). A PRESENT but
  // valueless --scope (a trailing `--scope`, or `--scope=`) is a bad operand, NOT a
  // request for the default -> EXIT_USAGE; an ABSENT flag falls back to the config
  // default below.
  const scopeFlag = parseScopeFlag(rest);
  if (scopeFlag.present && (scopeFlag.value === undefined || scopeFlag.value === '')) {
    deps.stderr('deep-review verify: --scope requires a value (--fast or --full)\n');
    return EXIT_USAGE;
  }
  const findingsPath = parseFindingsFlag(rest);
  if (findingsPath === undefined || findingsPath === '') {
    deps.stderr('deep-review verify: missing --findings <path>\n');
    return EXIT_USAGE;
  }
  const config = loadConfig(resolve(env.cwd, 'quality.json'));
  const scope = scopeFlag.value ?? config.verifyAfterFix ?? '--full';
  if (scope !== '--fast' && scope !== '--full') {
    deps.stderr(
      `deep-review verify: invalid --scope operand ${JSON.stringify(scope)} (expected --fast or --full)\n`,
    );
    return EXIT_USAGE;
  }
  // §F7 the ONE run deadline, created after all argv/usage validation, before preflight/identity.
  const deadline = createDeadline(config.budget.seconds);
  // §5.0 fix-mode preflight AFTER all argv/usage validation (valueless + invalid scope), BEFORE the
  // §5.2 identity gate and the spawn.
  const pfExit = preflightFail(config, env, 'verify', deps);
  if (pfExit !== undefined) return pfExit;
  const identity = identityGate(env, 'verify', findingsPath, deadline);
  if (!identity.ok) {
    deps.stderr(`${JSON.stringify({ error: identity.machineError })}\n`);
    return identity.exitCode;
  }
  const ctx = buildContext(env, config, identity.descriptor, deadline);
  const result = runFinalVerify(realVerifyDeps(env.cwd, scope, findingsPath, ctx));
  if (result.machineError !== undefined) {
    deps.stderr(`${JSON.stringify({ error: result.machineError })}\n`);
  } else {
    deps.stdout(`verify ${scope}: ${result.exitCode === EXIT_OK ? 'ok' : 'needs-human'}\n`);
  }
  return result.exitCode;
}

// ── guides-read gate (ADR-016) ──────────────────────────────────────────────────

/* The deterministic activation marker written by PreToolUse[Skill], keyed by session id
   so parallel sessions do not collide and a review's marker survives across its turns. */
function markerPath(cwd: string, sessionId: string): string {
  return join(cwd, '.artifacts', 'deep-review', `active-${sessionId}`);
}

/* The repo's linked worktrees (their absolute roots), via `git worktree list --porcelain -z`.
   A failure (not a git repo, git absent, timeout) degrades to [] — the cwd alone is then the
   only approved root, which still evaluates. Bounded by a short timeout so a wedged git can
   never hang session shutdown. `-z` is REQUIRED: `--porcelain` alone is line-delimited, so a
   worktree whose path contains a newline (`…\nworktree /tmp/decoy`) would parse as a second,
   attacker-chosen approved root — a fail-open. NUL records preserve the path bytes verbatim
   (no trim, which would corrupt a path with trailing whitespace). */
function realWorktreeRoots(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return out
      .split('\0')
      .filter((record) => record.startsWith('worktree '))
      .map((record) => record.slice('worktree '.length))
      .filter((worktreePath) => worktreePath !== '');
  } catch {
    return [];
  }
}

/* The repo checkouts a guide read may legitimately live under: the pass cwd plus every linked
   worktree of the same repo. A review runs in its own worktree while the guide it Reads may
   sit under the main checkout (or another worktree) — both must count. Realpath'd + deduped so
   the segment-suffix match in computeMissing cannot be satisfied by a same-named file OUTSIDE
   the repo. */
function resolveApprovedRoots(deps: CliDeps, env: ResolvedEnv, cwd: string): string[] {
  const worktreeRoots = deps.worktreeRoots ?? realWorktreeRoots;
  const resolved = [cwd, ...worktreeRoots(cwd)].map((root) => {
    try {
      return env.realpath(root);
    } catch {
      return root;
    }
  });
  return [...new Set(resolved)];
}

/* Value of a `--name <value>` / `--name=<value>` flag, or undefined when absent (or the
   flag is the trailing token). Generic sibling of parseFindingsFlag/parseSlugFlag. */
function parseNamedFlag(rest: string[], name: string): string | undefined {
  const inline = `${name}=`;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === name) return rest[i + 1];
    if (arg.startsWith(inline)) return arg.slice(inline.length);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* Reads the transcript file named by a hook-envelope field; undefined when the field is
   absent/empty or unreadable — an op-failure the gate turns into a block only once the
   pass is active. */
function readTranscript(env: ResolvedEnv, field: unknown): string | undefined {
  if (typeof field !== 'string' || field === '') return undefined;
  try {
    return env.readFile(field);
  } catch {
    return undefined;
  }
}

/* Serializes a decision for the direct `--transcript` mode (tests/manual inspection). */
function describeDecision(decision: GuidesReadDecision): Record<string, unknown> {
  if (decision.kind === 'skip') return { skipped: true, ok: true };
  if (decision.kind === 'allow') return { skipped: false, ok: true };
  return { skipped: false, ok: false, reason: decision.reason };
}

/* `guides-read --hook-stdin` (Stop/SubagentStop hook) | `guides-read --transcript <path>
   [--cwd <path>]` (direct). The gate BLOCKS a deep-review pass from concluding until every
   mandated guide has a successful Read in the transcript. DEEP_REVIEW_GUARD_OFF=1 disables
   it unconditionally, so a gate bug can never brick a consumer's sessions. */
function guidesReadCmd(rest: string[], deps: CliDeps): number {
  const getEnv = deps.getEnv ?? ((name: string): string | undefined => process.env[name]);
  if (getEnv('DEEP_REVIEW_GUARD_OFF') === '1') return EXIT_OK;
  const env = resolveEnv(deps);
  if (rest.includes('--hook-stdin')) return guidesReadHook(deps, env);
  const transcriptPath = parseNamedFlag(rest, '--transcript');
  if (transcriptPath === undefined || transcriptPath === '') {
    deps.stderr('deep-review guides-read: requires --hook-stdin or --transcript <path>\n');
    return EXIT_USAGE;
  }
  const cwd = parseNamedFlag(rest, '--cwd') ?? env.cwd;
  const decision = evaluateGuidesRead({
    transcriptText: readTranscript(env, transcriptPath),
    markerPresent: false,
    cwd,
    loadConfig: (): DeepReviewConfig => loadConfig(resolve(cwd, 'quality.json')),
    deps: { realpath: env.realpath, approvedRoots: resolveApprovedRoots(deps, env, cwd) },
  });
  deps.stdout(`${JSON.stringify(describeDecision(decision))}\n`);
  return EXIT_OK;
}

/* The Stop/SubagentStop path: the transcript comes from the harness envelope on stdin
   (agent_transcript_path for a SubagentStop, transcript_path otherwise), cwd + session id
   locate the marker, and a `block` decision prints its {decision,reason} JSON (exit 0 is
   the hook block protocol). An unparseable envelope is a harness-provided, not
   model-controlled, input: never block a possibly-non-review session on our own parse
   failure. */
function guidesReadHook(deps: CliDeps, env: ResolvedEnv): number {
  const readStdin = deps.readStdin ?? ((): string => readFileSync(0, 'utf8'));
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readStdin());
    if (!isRecord(parsed)) return EXIT_OK;
    envelope = parsed;
  } catch {
    return EXIT_OK;
  }
  const eventName = typeof envelope.hook_event_name === 'string' ? envelope.hook_event_name : '';
  const transcriptField =
    eventName === 'SubagentStop' ? envelope.agent_transcript_path : envelope.transcript_path;
  const cwd = typeof envelope.cwd === 'string' && envelope.cwd !== '' ? envelope.cwd : env.cwd;
  const sessionId = typeof envelope.session_id === 'string' ? envelope.session_id : '';
  const fileExists = deps.fileExists ?? existsSync;
  const decision = evaluateGuidesRead({
    transcriptText: readTranscript(env, transcriptField),
    markerPresent: sessionId !== '' && fileExists(markerPath(cwd, sessionId)),
    cwd,
    loadConfig: (): DeepReviewConfig => loadConfig(resolve(cwd, 'quality.json')),
    deps: { realpath: env.realpath, approvedRoots: resolveApprovedRoots(deps, env, cwd) },
  });
  if (decision.kind === 'block') {
    deps.stdout(`${JSON.stringify({ decision: 'block', reason: decision.reason })}\n`);
  }
  return EXIT_OK;
}

const DISPATCH: Record<Command, CommandHandler> = {
  'check-path': checkPath,
  classify,
  'commit-slice': commitSliceCmd,
  report,
  'select-worktree': selectWorktreeCmd,
  handoff: handoffCmd,
  verify: verifyCmd,
  'guides-read': guidesReadCmd,
};

function isCommand(value: string): value is Command {
  return Object.hasOwn(DISPATCH, value);
}

// Builds a §2.4 machine-readable error for an UNCAUGHT io/validation failure
// (untrusted findings file, missing/invalid quality.json). A FindingsValidationError
// carries its rule + JSON path into the message so the cause is legible; `step` is
// omitted (no failing sub-step) and `stderr_tail` is empty (no captured child
// stderr at this layer). Mirrors the slice/report machine-error emission pattern.
function toMachineError(subcommand: string, error: unknown): MachineError {
  if (error instanceof FindingsValidationError) {
    const where = error.path === '' ? '<root>' : error.path;
    return {
      command: `deep-review ${subcommand}`,
      message: `findings validation failed (${error.rule}) at ${where}: ${error.message}`,
      stderr_tail: '',
    };
  }
  return {
    command: `deep-review ${subcommand}`,
    message: error instanceof Error ? error.message : String(error),
    stderr_tail: '',
  };
}

export function runCli(argv: string[], deps: CliDeps): number {
  const subcommand = argv[0];
  if (subcommand === undefined) {
    deps.stderr(USAGE);
    return EXIT_USAGE;
  }
  if (!isCommand(subcommand)) {
    deps.stderr(`deep-review: unknown command "${subcommand}"\n${USAGE}`);
    return EXIT_USAGE;
  }
  // Fail-safe boundary (§2.4): an untrusted findings file or a missing/invalid
  // quality.json must never escape as a raw stack trace. Any throw out of the
  // handler becomes a §2.4 machine error as the LAST stderr line + EXIT_FAILURE.
  try {
    return DISPATCH[subcommand](argv.slice(1), deps);
  } catch (error) {
    // A live findings-lock contention carries its OWN exit code (EXIT_FINDINGS_CONFLICT);
    // map it there rather than collapsing to EXIT_FAILURE.
    if (error instanceof FindingsConflictError) {
      deps.stderr(`${JSON.stringify({ error: { command: `deep-review ${subcommand}`, message: error.message, stderr_tail: '' } })}\n`);
      return error.exitCode;
    }
    deps.stderr(`${JSON.stringify({ error: toMachineError(subcommand, error) })}\n`);
    return EXIT_FAILURE;
  }
}
