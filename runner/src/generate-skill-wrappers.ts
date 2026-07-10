import {
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';
import { isMainModule } from './manifest-cli.ts';

// Skill-wrapper generator (spec §13, three layers). The canonical phase bodies
// in agents/skill-sources/<name>.md carry YAML frontmatter (name, description)
// as the single metadata source (ADR-010). This module turns each body into a
// deterministic, byte-stable thin wrapper per runtime - frontmatter + a pointer
// at the canonical body, never a copy of the body (ADR-003). Generation must be
// byte-stable so `standards-sync --check` can detect drift by exact compare.
//
// source-root vs target-root (core-fix #1): the SOURCE root holds the canonical
// bodies (agents/skill-sources/*.md); the TARGET root is where the per-runtime
// wrappers are written. Same root (the historic single --repo-root case) keeps
// byte-identical output. Cross-root renders canonical_source as a clone-stable,
// POSIX, target-root-relative pointer so the target repo can resolve the body.
//
// Zero runtime deps (ADR-006): the frontmatter reader below is hand-rolled.

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
// Generation/check faults (unreadable source, bad frontmatter, drift, symlink
// escape) reuse the validator's exit 1 so the shim surfaces a single non-zero
// "needs attention".
export const EXIT_FAIL = 1;

export interface GenResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

// The two runtimes spec §13 point 2 names, each with its skills root and the
// per-runtime wrapper field spec §13 point 3 implies (slash surfacing is a
// per-runtime field; we record the runtime so the two wrappers differ
// meaningfully and the pointer text is runtime-specific).
export interface Runtime {
  id: 'codex' | 'claude';
  skillsDir: string;
}

export const RUNTIMES: readonly Runtime[] = [
  { id: 'codex', skillsDir: '.agents/skills' },
  { id: 'claude', skillsDir: '.claude/skills' },
];

const SOURCE_DIR = path.join('agents', 'skill-sources');

// The marker every generated wrapper carries (also the LEGACY marker already in
// shipped wrappers). Orphan/stale detection (RUN-05) matches on this substring,
// and generate-mode deletes ONLY files that carry it.
const GENERATED_MARKER = 'GENERATED FILE - do not edit';

export interface Frontmatter {
  name: string;
  description: string;
}

export type FrontmatterResult =
  | { ok: true; frontmatter: Frontmatter }
  | { ok: false; message: string };

// Kebab-case allowlist for the wrapper `name` (ADR-010 metadata). The name is
// already required to equal the source filename stem, and it is interpolated
// into on-disk wrapper paths (`<skillsDir>/<name>/SKILL.md`); restricting it to
// lower-case letters/digits/hyphens starting with a letter makes that safety
// explicit and rules out path-significant stems (e.g. "..") at parse time.
export const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// Minimal, deterministic frontmatter reader: a leading `---` line, scalar
// `key: value` lines, a closing `---`. Only `name` and `description` are read;
// values are single-line (the canonical bodies use single-line scalars). This
// is intentionally tiny - not a general YAML parser - to keep the zero-dep
// contract (ADR-006).
export function parseFrontmatter(raw: string): FrontmatterResult {
  // Normalize CRLF so generation is byte-identical regardless of checkout EOL.
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return { ok: false, message: 'missing YAML frontmatter (file must start with "---")' };
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    return { ok: false, message: 'unterminated YAML frontmatter (no closing "---")' };
  }
  const block = text.slice(4, end);

  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    if (line.trim() === '') continue;
    const sep = line.indexOf(':');
    if (sep === -1) {
      return { ok: false, message: `malformed frontmatter line (expected "key: value"): ${line}` };
    }
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    // Decode quoted scalars without pulling in a YAML dep (RUN-08). Double
    // quotes → JSON.parse (handles \" \n \\ etc.); single quotes → YAML literal
    // semantics ('' escapes a quote). A malformed double-quoted scalar is a
    // structured error, not a silent pass.
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        return { ok: false, message: `invalid double-quoted scalar for "${key}": ${value}` };
      }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    // Reject duplicate frontmatter keys (RUN-08): last-write-wins hides a
    // conflicting metadata line.
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      return { ok: false, message: `duplicate frontmatter key: "${key}"` };
    }
    fields[key] = value;
  }

  const name = fields['name'];
  const description = fields['description'];
  if (name === undefined || name === '') {
    return { ok: false, message: 'frontmatter is missing a non-empty "name"' };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: `frontmatter "name" must be kebab-case (${NAME_PATTERN.source}): "${name}"`,
    };
  }
  if (description === undefined || description === '') {
    return { ok: false, message: 'frontmatter is missing a non-empty "description"' };
  }
  // ponytail: unknown-key rejection deferred - extra keys are ignored, not
  // rejected. Add a known-key allowlist here if bodies start carrying typo'd
  // metadata that must fail loudly.
  return { ok: true, frontmatter: { name, description } };
}

// The committed wrapper path for a phase under a target root.
export function wrapperPath(targetRoot: string, runtime: Runtime, name: string): string {
  return path.join(targetRoot, runtime.skillsDir, name, 'SKILL.md');
}

// Would a bare (unquoted) YAML plain scalar round-trip to exactly `v`? Only then
// do we emit it bare - preserving byte-identical output for the shipped bodies,
// whose name/description/path values are all plain-safe. Anything else is
// JSON-quoted below (RUN-08).
//
// ponytail: conditional quoting, NOT "quote every scalar". Two authoritative
// requirements collide - RUN-08 wants every scalar quoted, but core-fix #1
// requires same-root output byte-identical to today (bare `name:` /
// `canonical_source:`). Conditional quoting satisfies both: every dangerous
// value IS quoted (valid YAML 1.2), and plain values stay bare (byte-identical).
// The predicate is conservative - when unsure, quote.
function isPlainSafe(v: string): boolean {
  if (v === '') return false;
  // A control char/newline/tab can't survive as a one-line bare scalar - it would
  // inject an extra YAML line (a bare `description: a\nb` is invalid).
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  if (/^\s|\s$/.test(v)) return false; // leading/trailing whitespace
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return false; // indicator as first char
  if (v.includes('"')) return false; // a double quote anywhere - quote defensively
  if (/:(\s|$)/.test(v)) return false; // ": " or a trailing ":" (mapping-like)
  if (/\s#/.test(v)) return false; // " #" starts a YAML comment
  // Anchored (^...$) YAML 1.2 implicit types: a value that FULL-matches one would
  // be decoded to a bool/number/timestamp, so it must be quoted to stay a string.
  // Anchoring keeps a plain string that merely STARTS numeric (e.g. "2026 migration") bare.
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(v)) return false; // bool/null (+ YAML 1.1 words)
  if (/^[-+]?\.(inf|nan)$/i.test(v)) return false; // .inf / .nan / .Inf
  if (/^[-+]?[0-9]+$/.test(v)) return false; // int
  if (/^[-+]?0x[0-9a-fA-F]+$/.test(v)) return false; // hex int (YAML 1.2 core)
  if (/^[-+]?0o[0-7]+$/.test(v)) return false; // octal int (YAML 1.2 core)
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(v)) return false; // float / scientific
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9:.+Zz-]*)?$/.test(v)) return false; // timestamp
  return true;
}

function yamlScalar(v: string): string {
  return isPlainSafe(v) ? v : JSON.stringify(v);
}

// The clone-stable, POSIX, target-root-relative pointer to a canonical body.
// Same root → the historic literal `agents/skill-sources/<name>.md` (byte for
// byte). Cross root → a relative path (may contain `..` for a sibling source
// repo), computed with POSIX separators explicitly (never path.relative's
// platform separators). An absolute result (Windows cross-device) is not
// clone-stable and is rejected by validateRoots before we get here.
export function canonicalSourceRel(sourceRoot: string, targetRoot: string, name: string): string {
  const sourceFile = path.resolve(sourceRoot, SOURCE_DIR, `${name}.md`);
  const rel = path.relative(path.resolve(targetRoot), sourceFile);
  return rel.split(path.sep).join(path.posix.sep);
}

// Reject a root pair that cannot yield a clone-stable (relative) pointer.
function validateRoots(sourceRoot: string, targetRoot: string): { ok: true } | { ok: false; message: string } {
  const rel = path.relative(path.resolve(targetRoot), path.resolve(sourceRoot, SOURCE_DIR));
  if (rel === '' || path.isAbsolute(rel)) {
    return {
      ok: false,
      message: `cannot render a clone-stable canonical_source: source ${sourceRoot} is not relative to target ${targetRoot}`,
    };
  }
  return { ok: true };
}

// Render a deterministic wrapper. Output is fully determined by (frontmatter,
// runtime, canonicalSource) so re-generation is byte-stable. The body is NEVER
// included: only metadata + a pointer at the canonical source.
export function renderWrapper(fm: Frontmatter, runtime: Runtime, canonicalSource: string): string {
  return [
    '---',
    `name: ${yamlScalar(fm.name)}`,
    `description: ${yamlScalar(fm.description)}`,
    `runtime: ${yamlScalar(runtime.id)}`,
    `canonical_source: ${yamlScalar(canonicalSource)}`,
    '---',
    '',
    `# ${fm.name} (generated wrapper)`,
    '',
    'GENERATED FILE - do not edit. `standards-sync --check` fails on drift.',
    'Regenerate with `standards-sync --generate-skills`.',
    '',
    'This is a thin per-runtime wrapper (spec §13 layer 2): metadata plus a',
    'pointer. The phase behavior - judgment steps and the contract block - lives',
    'once in the canonical body and is NOT duplicated here (ADR-003 / ADR-010).',
    '',
    '## Canonical body',
    '',
    `Read and follow the canonical \`${fm.name}\` skill body:`,
    '',
    '```text',
    canonicalSource,
    '```',
    '',
  ].join('\n');
}

export interface PhaseSource {
  name: string;
  frontmatter: Frontmatter;
}

export type CollectResult =
  | { ok: true; phases: PhaseSource[] }
  | { ok: false; message: string };

// Read every canonical body in <sourceRoot>/agents/skill-sources/, parse its
// frontmatter, and return them sorted by name so generation order is
// deterministic.
export function collectPhases(sourceRoot: string): CollectResult {
  const dir = path.join(sourceRoot, SOURCE_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `cannot read skill sources at ${SOURCE_DIR}: ${detail}` };
  }

  const files = entries.filter((f) => f.endsWith('.md')).sort();
  const phases: PhaseSource[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(path.join(dir, file), 'utf8');
    } catch (error) {
      // A dangling/unreadable body is a structured failure, not an uncaught
      // throw (RUN-07): ENOENT here means a listed entry vanished/was dangling.
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `cannot read ${SOURCE_DIR}/${file}: ${detail}` };
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed.ok) {
      return { ok: false, message: `${SOURCE_DIR}/${file}: ${parsed.message}` };
    }
    const expected = file.replace(/\.md$/, '');
    if (parsed.frontmatter.name !== expected) {
      return {
        ok: false,
        message: `${SOURCE_DIR}/${file}: frontmatter name "${parsed.frontmatter.name}" must match filename "${expected}"`,
      };
    }
    phases.push({ name: expected, frontmatter: parsed.frontmatter });
  }

  if (phases.length === 0) {
    return { ok: false, message: `no canonical skill bodies found in ${SOURCE_DIR}` };
  }
  return { ok: true, phases };
}

export interface Roots {
  sourceRoot: string;
  targetRoot: string;
}

export interface PlannedWrapper {
  runtime: Runtime;
  name: string;
  relPath: string;
  content: string;
}

// The full set of wrappers that SHOULD exist under the target root, in
// deterministic order. Each carries a target-resolvable canonical_source.
export function planWrappers(phases: PhaseSource[], roots: Roots): PlannedWrapper[] {
  const planned: PlannedWrapper[] = [];
  for (const runtime of RUNTIMES) {
    for (const phase of phases) {
      const canonicalSource = canonicalSourceRel(roots.sourceRoot, roots.targetRoot, phase.name);
      planned.push({
        runtime,
        name: phase.name,
        relPath: path.join(runtime.skillsDir, phase.name, 'SKILL.md'),
        content: renderWrapper(phase.frontmatter, runtime, canonicalSource),
      });
    }
  }
  return planned;
}

// ── Target-side confinement (RUN-03) ─────────────────────────────────────────
// Walk each EXISTING component of `relPath` beneath `root`; refuse if any is a
// symlink (no-follow). ENOENT stops the walk - deeper components don't exist
// yet, which is safe. Any other errno (EACCES/ENOTDIR/ELOOP) is a structured
// failure, never silent absence (RUN-07). Used for discovery, marker-reads AND
// deletion - the orphan-cleanup path is the dangerous one.
type Confine = { ok: true } | { ok: false; message: string };
function assertConfined(root: string, relPath: string): Confine {
  const parts = relPath.split(path.sep).filter((p) => p !== '');
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return { ok: true };
      return { ok: false, message: `cannot stat ${cur}: ${e.message}` };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, message: `refusing to follow symlink at ${cur} (target-confinement guard)` };
    }
  }
  return { ok: true };
}

let tmpCounter = 0;

// Per-file atomic write (RUN-07, narrow): stage to a same-directory temp with
// O_EXCL (`wx` = no-follow create) then rename over the destination. rename
// replaces a pre-existing leaf symlink/file WITHOUT following it, so a symlinked
// SKILL.md never redirects the write. NOT a multi-file transaction: a mid-loop
// crash can leave earlier leaves written (each leaf is individually atomic).
//
// ponytail: STATIC symlink attacks are defended (the lstat-walk assertConfined
// preflight + the `wx` no-follow leaf). The CONCURRENT-SWAP TOCTOU is NOT defended:
// a local process that swaps `dir` (or an ancestor) for a symlink between the
// assertConfined preflight and this mkdir/write/rename can still redirect it.
// ACCEPTABLE for this trusted single-user pilot (needs a local adversary running
// during generation). Upgrade path = descriptor-relative openat/no-follow ops under
// verified directory handles (see BACKLOG: descriptor-relative confinement).
function writeWrapperFile(abs: string, content: string): void {
  const dir = path.dirname(abs);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${tmpCounter++}`);
  writeFileSync(tmp, content, { flag: 'wx' });
  renameSync(tmp, abs);
}

type FoundResult = { ok: true; wrappers: { relPath: string }[] } | { ok: false; message: string };

// Enumerate on-disk generated wrappers under the target root (RUN-05). Discovery
// is confined: the skills root and each candidate leaf are symlink-checked
// before we read them, so a symlinked skills tree cannot lure us into reading /
// (later) deleting files outside the target. Only files carrying GENERATED_MARKER
// are returned. Only ENOENT means "no wrapper here"; every other errno (EISDIR when
// SKILL.md is a directory, ENOTDIR after a race, EACCES, ...) is a structured
// failure - a malformed orphan must never be silently skipped (RUN-07).
function findGeneratedWrappers(targetRoot: string): FoundResult {
  const wrappers: { relPath: string }[] = [];
  for (const runtime of RUNTIMES) {
    const rootConfine = assertConfined(targetRoot, runtime.skillsDir);
    if (!rootConfine.ok) return { ok: false, message: rootConfine.message };
    const skillsAbs = path.join(targetRoot, runtime.skillsDir);
    let names: string[];
    try {
      names = readdirSync(skillsAbs);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') continue; // no skills tree for this runtime - fine
      return { ok: false, message: `cannot read skills dir ${runtime.skillsDir}: ${e.message}` };
    }
    for (const name of names.sort()) {
      const relPath = path.join(runtime.skillsDir, name, 'SKILL.md');
      const confine = assertConfined(targetRoot, relPath);
      if (!confine.ok) return { ok: false, message: confine.message };
      let content: string;
      try {
        content = readFileSync(path.join(targetRoot, relPath), 'utf8');
      } catch (error) {
        const e = error as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') continue; // no wrapper here; anything else surfaces
        return { ok: false, message: `cannot read ${relPath}: ${e.message}` };
      }
      if (content.includes(GENERATED_MARKER)) wrappers.push({ relPath });
    }
  }
  return { ok: true, wrappers };
}

type BodiesProbe = { ok: true; authors: boolean } | { ok: false; message: string };
// Does the SOURCE root author canonical bodies? Only ENOENT means "no sources";
// SOURCE_DIR being a regular file (ENOTDIR) or unreadable (EACCES) is a
// structured failure, not a silent "no bodies" (RUN-07).
function probeBodies(sourceRoot: string): BodiesProbe {
  try {
    const entries = readdirSync(path.join(sourceRoot, SOURCE_DIR));
    return { ok: true, authors: entries.some((f) => f.endsWith('.md')) };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { ok: true, authors: false };
    return { ok: false, message: `cannot read skill sources at ${SOURCE_DIR}: ${e.message}` };
  }
}

type HostsProbe = { ok: true; hosts: boolean } | { ok: false; message: string };
// Does the TARGET root host a wrappers tree? lstat (no-follow); only ENOENT is
// absence, other errno is a structured failure (RUN-07). A symlinked skills root
// counts as "hosts" here and is caught later by findGeneratedWrappers.
function probeHosts(targetRoot: string): HostsProbe {
  let hosts = false;
  for (const runtime of RUNTIMES) {
    try {
      lstatSync(path.join(targetRoot, runtime.skillsDir));
      hosts = true;
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') continue;
      return { ok: false, message: `cannot stat skills dir ${runtime.skillsDir}: ${e.message}` };
    }
  }
  return { ok: true, hosts };
}

function fail(message: string, stdout: string[] = []): GenResult {
  return { code: EXIT_FAIL, stdout, stderr: [message] };
}

// generate mode: (re)write every planned wrapper, then delete generated-marked
// orphans. Preflight (roots + collect + plan + confinement) runs BEFORE any
// write so a bad destination aborts without partial generation (RUN-07).
export function generate(sourceRoot: string, targetRoot: string): GenResult {
  const stdout: string[] = [];

  const rootsCheck = validateRoots(sourceRoot, targetRoot);
  if (!rootsCheck.ok) return fail(rootsCheck.message);

  const collected = collectPhases(sourceRoot);
  if (!collected.ok) return fail(collected.message);

  const planned = planWrappers(collected.phases, { sourceRoot, targetRoot });

  // Preflight confinement for every destination (no partial writes on a bad path).
  for (const w of planned) {
    const c = assertConfined(targetRoot, w.relPath);
    if (!c.ok) return fail(c.message);
  }

  // Discover pre-existing generated wrappers (confined) for orphan cleanup,
  // before we write the new ones.
  const found = findGeneratedWrappers(targetRoot);
  if (!found.ok) return fail(found.message);

  for (const w of planned) {
    writeWrapperFile(path.join(targetRoot, w.relPath), w.content);
    stdout.push(`generated ${w.relPath}`);
  }

  // Delete generated-marked orphans (not in the planned set), re-confining each
  // destination just before removal (RUN-05).
  const plannedRel = new Set(planned.map((w) => w.relPath));
  for (const g of found.wrappers) {
    if (plannedRel.has(g.relPath)) continue;
    const c = assertConfined(targetRoot, g.relPath);
    if (!c.ok) return fail(c.message, stdout);
    rmSync(path.join(targetRoot, g.relPath));
    stdout.push(`removed orphan ${g.relPath}`);
  }

  stdout.push(`generated ${planned.length} skill wrappers for ${RUNTIMES.length} runtimes`);
  return { code: EXIT_OK, stdout, stderr: [] };
}

// check mode: validate the canonical bodies, then (unless in legacy/same-root
// source-only mode) require the planned wrappers to exist and match, and fail on
// stale/orphan generated wrappers (RUN-05).
//
// Wrapper-drift is SKIPPED only when sameRoot AND the target hosts no wrappers
// tree - that is the source repo (dev-standards) checking itself. A cross-root
// check ALWAYS requires the planned wrappers (missing = failure), because the
// caller explicitly asked to generate into a separate target.
export function check(sourceRoot: string, targetRoot: string, sameRoot: boolean): GenResult {
  const stdout: string[] = [];

  const rootsCheck = validateRoots(sourceRoot, targetRoot);
  if (!rootsCheck.ok) return fail(rootsCheck.message);

  const bodiesProbe = probeBodies(sourceRoot);
  if (!bodiesProbe.ok) return fail(bodiesProbe.message);
  const authorsBodies = bodiesProbe.authors;

  const hostsProbe = probeHosts(targetRoot);
  if (!hostsProbe.ok) return fail(hostsProbe.message);
  const hosts = hostsProbe.hosts;

  // Validate bodies whenever they exist, or whenever we will need the plan
  // (cross-root always needs it). collectPhases is also the drift plan source.
  let phases: PhaseSource[] = [];
  if (authorsBodies || hosts || !sameRoot) {
    const collected = collectPhases(sourceRoot);
    if (!collected.ok) return fail(collected.message);
    phases = collected.phases;
  }

  // Legacy/same-root source-only mode: nothing to drift against - skip.
  if (sameRoot && !hosts) {
    stdout.push('no skill wrappers present (source repo) - wrapper drift check skipped');
    return { code: EXIT_OK, stdout, stderr: [] };
  }

  const planned = planWrappers(phases, { sourceRoot, targetRoot });
  const plannedRel = new Set(planned.map((w) => w.relPath));
  const drift: string[] = [];

  for (const w of planned) {
    const confine = assertConfined(targetRoot, w.relPath);
    if (!confine.ok) return fail(confine.message);
    let actual: string;
    try {
      actual = readFileSync(path.join(targetRoot, w.relPath), 'utf8').replace(/\r\n/g, '\n');
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        drift.push(`missing wrapper: ${w.relPath} (run: standards-sync --generate-skills)`);
        continue;
      }
      return fail(`cannot read wrapper ${w.relPath}: ${e.message}`); // EACCES/ENOTDIR/ELOOP
    }
    if (actual !== w.content) {
      drift.push(`drift: ${w.relPath} differs from the generated output (run: standards-sync --generate-skills)`);
    }
  }

  // Stale/orphan generated wrappers with no matching planned entry (RUN-05).
  const found = findGeneratedWrappers(targetRoot);
  if (!found.ok) return fail(found.message);
  for (const g of found.wrappers) {
    if (!plannedRel.has(g.relPath)) {
      drift.push(`stale wrapper: ${g.relPath} (no canonical source; run: standards-sync --generate-skills)`);
    }
  }

  if (drift.length > 0) {
    const stderr = ['skill wrapper drift detected:'];
    for (const line of drift) stderr.push(`  ${line}`);
    return { code: EXIT_FAIL, stdout, stderr };
  }

  stdout.push(`skill wrappers in sync (${planned.length} wrappers across ${RUNTIMES.length} runtimes)`);
  return { code: EXIT_OK, stdout, stderr: [] };
}

// CLI: exactly one of --generate | --check, plus the roots. Roots are either the
// back-compat alias `--repo-root <path>` (sets BOTH source and target), OR the
// split `--source-root <path> [--target-root <path>]` (target defaults to
// source). The two forms cannot be mixed and no flag may repeat.
// usage -> 2; generation/check fault or drift -> 1; ok -> 0.
export function run(argv: string[]): GenResult {
  const usage =
    'usage: --generate | --check (--repo-root <path> | --source-root <path> [--target-root <path>])';
  const usageErr = (detail: string): GenResult => ({
    code: EXIT_USAGE,
    stdout: [],
    stderr: [`${usage}${detail ? ` (${detail})` : ''}`],
  });

  let mode: 'generate' | 'check' | undefined;
  let repoRoot: string | undefined;
  let sourceRoot: string | undefined;
  let targetRoot: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--generate' || arg === '--check') {
      if (mode !== undefined) return usageErr('give exactly one mode');
      mode = arg === '--generate' ? 'generate' : 'check';
      continue;
    }
    if (arg === '--repo-root' || arg === '--source-root' || arg === '--target-root') {
      const value = argv[i + 1];
      if (value === undefined) return usageErr(`${arg} missing value`);
      if (arg === '--repo-root') {
        if (repoRoot !== undefined) return usageErr('--repo-root given twice');
        repoRoot = value;
      } else if (arg === '--source-root') {
        if (sourceRoot !== undefined) return usageErr('--source-root given twice');
        sourceRoot = value;
      } else {
        if (targetRoot !== undefined) return usageErr('--target-root given twice');
        targetRoot = value;
      }
      i += 1;
      continue;
    }
    return usageErr(`unexpected argument: ${arg}`);
  }

  if (mode === undefined) return usageErr('');

  if (repoRoot !== undefined) {
    if (sourceRoot !== undefined || targetRoot !== undefined) {
      return usageErr('--repo-root cannot be combined with --source-root/--target-root');
    }
    sourceRoot = repoRoot;
    targetRoot = repoRoot;
  } else {
    if (sourceRoot === undefined) return usageErr('--source-root is required (or use --repo-root)');
    if (targetRoot === undefined) targetRoot = sourceRoot;
  }

  const sameRoot = path.resolve(sourceRoot) === path.resolve(targetRoot);
  return mode === 'generate' ? generate(sourceRoot, targetRoot) : check(sourceRoot, targetRoot, sameRoot);
}

if (isMainModule(import.meta.url)) {
  const result = run(process.argv.slice(2));
  for (const line of result.stdout) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.exit(result.code);
}
