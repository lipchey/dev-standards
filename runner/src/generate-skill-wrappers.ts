import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './manifest-cli.ts';

// Skill-wrapper generator (spec §13, three layers). The canonical phase bodies
// in agents/skill-sources/<name>.md carry YAML frontmatter (name, description)
// as the single metadata source (ADR-010). This module turns each body into a
// deterministic, byte-stable thin wrapper per runtime - frontmatter + a pointer
// at the canonical body, never a copy of the body (ADR-003). Generation must be
// byte-stable so `standards-sync --check` can detect drift by exact compare.
//
// Zero runtime deps (ADR-006): the frontmatter reader below is hand-rolled.

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
// Generation/check faults (unreadable source, bad frontmatter, drift) reuse the
// validator's exit 1 so the shim surfaces a single non-zero "needs attention".
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
    // Tolerate quoted scalars without pulling in a YAML dep.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
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
  return { ok: true, frontmatter: { name, description } };
}

// The committed wrapper path for a phase under a runtime, relative to repoRoot.
export function wrapperPath(repoRoot: string, runtime: Runtime, name: string): string {
  return path.join(repoRoot, runtime.skillsDir, name, 'SKILL.md');
}

// Does this repo HOST generated wrappers? A repo "hosts" wrappers when any
// runtime's skills root (.agents/skills or .claude/skills) exists. The source
// repo (dev-standards) authors the bodies but hosts no wrappers, so neither dir
// exists and the wrapper-drift check is skipped (option C). Adopting repos and
// the fixtures DO create these dirs, so drift/missing-wrapper detection stays
// fully active there.
export function hostsWrappers(repoRoot: string): boolean {
  return RUNTIMES.some((runtime) => existsSync(path.join(repoRoot, runtime.skillsDir)));
}

// Does this repo AUTHOR canonical bodies? True when agents/skill-sources holds
// at least one `.md`. The source repo (dev-standards) does; an adopting repo
// that only vendors wrappers does not. `check()` uses this so it ALWAYS parses
// and validates its own bodies (catching broken frontmatter) regardless of
// whether a skills tree exists - only the wrapper-drift COMPARISON is gated on
// hostsWrappers. A repo with neither bodies nor a skills tree still passes.
export function hasCanonicalBodies(repoRoot: string): boolean {
  try {
    return readdirSync(path.join(repoRoot, SOURCE_DIR)).some((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
}

// Render a deterministic wrapper. Output is fully determined by (frontmatter,
// runtime) so re-generation is byte-stable. The body is NEVER included: only
// metadata + a pointer at the canonical source, named explicitly.
export function renderWrapper(fm: Frontmatter, runtime: Runtime): string {
  const sourceRel = `${SOURCE_DIR}/${fm.name}.md`;
  return [
    '---',
    `name: ${fm.name}`,
    `description: ${fm.description}`,
    `runtime: ${runtime.id}`,
    `canonical_source: ${sourceRel}`,
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
    sourceRel,
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

// Read every canonical body in agents/skill-sources/, parse its frontmatter,
// and return them sorted by name so generation order is deterministic.
export function collectPhases(repoRoot: string): CollectResult {
  const dir = path.join(repoRoot, SOURCE_DIR);
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
    const raw = readFileSync(path.join(dir, file), 'utf8');
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

export interface PlannedWrapper {
  runtime: Runtime;
  name: string;
  relPath: string;
  content: string;
}

// The full set of wrappers that SHOULD exist on disk, in deterministic order.
export function planWrappers(phases: PhaseSource[]): PlannedWrapper[] {
  const planned: PlannedWrapper[] = [];
  for (const runtime of RUNTIMES) {
    for (const phase of phases) {
      planned.push({
        runtime,
        name: phase.name,
        relPath: path.join(runtime.skillsDir, phase.name, 'SKILL.md'),
        content: renderWrapper(phase.frontmatter, runtime),
      });
    }
  }
  return planned;
}

// generate mode: (re)write every wrapper to disk.
export function generate(repoRoot: string): GenResult {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const collected = collectPhases(repoRoot);
  if (!collected.ok) {
    stderr.push(collected.message);
    return { code: EXIT_FAIL, stdout, stderr };
  }

  const planned = planWrappers(collected.phases);
  for (const w of planned) {
    const abs = path.join(repoRoot, w.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, w.content);
    stdout.push(`generated ${w.relPath}`);
  }
  stdout.push(`generated ${planned.length} skill wrappers for ${RUNTIMES.length} runtimes`);
  return { code: EXIT_OK, stdout, stderr };
}

// check mode: validate the canonical bodies, then (only where wrappers are
// hosted) regenerate in memory and compare against the committed files. Any
// missing, extra-content, or drifted wrapper is a failure with a clear message.
//
// TWO independent dimensions, decoupled (FIX 1):
//   1. Body validation. If this repo AUTHORS bodies (agents/skill-sources/*.md),
//      ALWAYS parse and validate them - even with no skills tree. This catches
//      broken/invalid frontmatter in the source repo's own bodies, which the
//      old hostsWrappers early-return let pass with exit 0.
//   2. Wrapper-drift COMPARISON. Only applies to repos that HOST wrappers; the
//      source repo (dev-standards) and any non-adopting repo host none, so there
//      is nothing to drift against - skip the comparison and pass (option C).
// A repo with neither bodies nor a skills tree still passes.
export function check(repoRoot: string): GenResult {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const authorsBodies = hasCanonicalBodies(repoRoot);
  const hosts = hostsWrappers(repoRoot);

  // Dimension 1: validate bodies whenever they exist. collectPhases is also the
  // source of the drift plan when wrappers are hosted, so collect once and reuse.
  let phases: PhaseSource[] = [];
  if (authorsBodies || hosts) {
    const collected = collectPhases(repoRoot);
    if (!collected.ok) {
      stderr.push(collected.message);
      return { code: EXIT_FAIL, stdout, stderr };
    }
    phases = collected.phases;
  }

  // Dimension 2: wrapper-drift comparison is gated on hosting wrappers.
  if (!hosts) {
    stdout.push('no skill wrappers present (source repo) - wrapper drift check skipped');
    return { code: EXIT_OK, stdout, stderr };
  }

  const planned = planWrappers(phases);
  const drift: string[] = [];
  for (const w of planned) {
    const abs = path.join(repoRoot, w.relPath);
    let actual: string | undefined;
    try {
      actual = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      drift.push(`missing wrapper: ${w.relPath} (run: standards-sync --generate-skills)`);
      continue;
    }
    if (actual !== w.content) {
      drift.push(`drift: ${w.relPath} differs from the generated output (run: standards-sync --generate-skills)`);
    }
  }

  if (drift.length > 0) {
    stderr.push('skill wrapper drift detected:');
    for (const line of drift) stderr.push(`  ${line}`);
    return { code: EXIT_FAIL, stdout, stderr };
  }

  stdout.push(`skill wrappers in sync (${planned.length} wrappers across ${RUNTIMES.length} runtimes)`);
  return { code: EXIT_OK, stdout, stderr };
}

// CLI: exactly one of --generate | --check, plus required --repo-root <path>.
// usage -> 2; generation/check fault or drift -> 1; ok -> 0.
export function run(argv: string[]): GenResult {
  let mode: 'generate' | 'check' | undefined;
  let repoRoot: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--generate' || arg === '--check') {
      const next: 'generate' | 'check' = arg === '--generate' ? 'generate' : 'check';
      if (mode !== undefined) {
        return { code: EXIT_USAGE, stdout: [], stderr: ['usage: --generate | --check --repo-root <path> (give exactly one mode)'] };
      }
      mode = next;
      continue;
    }
    if (arg === '--repo-root') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { code: EXIT_USAGE, stdout: [], stderr: ['usage: --repo-root <path> (missing value)'] };
      }
      repoRoot = value;
      i += 1;
      continue;
    }
    return { code: EXIT_USAGE, stdout: [], stderr: [`usage: --generate | --check --repo-root <path> (unexpected argument: ${arg})`] };
  }

  if (mode === undefined || repoRoot === undefined) {
    return { code: EXIT_USAGE, stdout: [], stderr: ['usage: --generate | --check --repo-root <path>'] };
  }

  return mode === 'generate' ? generate(repoRoot) : check(repoRoot);
}

if (isMainModule(import.meta.url)) {
  const result = run(process.argv.slice(2));
  for (const line of result.stdout) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.exit(result.code);
}
