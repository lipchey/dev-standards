/*
 * Static contract for the committed skill wrappers. Replaces the retired
 * generate-skill-wrappers drift check (Phase 2): the single surviving skill
 * (deep-review-refactor for Claude and deep-review-refactor-codex for Codex)
 * ships hand-written per-runtime wrappers, so this
 * guards the invariants the generator used to enforce — name/description match
 * the canonical body, the pointer is actionable and equals canonical_source,
 * the body is not duplicated, and no orphan wrapper appears. Adversarial
 * hardening (Gate C): CRLF-safe, rejects duplicate keys, requires the
 * instruction and the sole pointer fence to form one block, forbids any inlined
 * canonical section, and counts symlinked orphans.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLAUDE_SKILL = 'deep-review-refactor';
const CODEX_SKILL = 'deep-review-refactor-codex';
const CLAUDE_CANONICAL_SOURCE = path.posix.join('agents', 'skill-sources', `${CLAUDE_SKILL}.md`);
const CODEX_CANONICAL_SOURCE = path.posix.join('agents', 'skill-sources', `${CODEX_SKILL}.md`);
const CONSUMER_CLAUDE_CANONICAL_SOURCE = path.posix.join('vendor', 'dev-standards', CLAUDE_CANONICAL_SOURCE);
const CONSUMER_CODEX_PACKAGE_SOURCE = path.posix.join('vendor', 'dev-standards', CODEX_CANONICAL_SOURCE);
const CONSUMER_CODEX_CANONICAL_SOURCE = path.posix.join('..', '..', '..', CONSUMER_CODEX_PACKAGE_SOURCE);
const CONSUMER_CODEX_WRAPPER = path.posix.join(
  'templates',
  'consumer',
  'agents-skills',
  CODEX_SKILL,
  'SKILL.md',
);
const CONSUMER_CLAUDE_WRAPPER = path.posix.join(
  'templates',
  'consumer',
  'claude-skills',
  CLAUDE_SKILL,
  'SKILL.md',
);
const CONSUMER_CODEX_UI = path.posix.join(
  'templates',
  'consumer',
  'agents-skills',
  CODEX_SKILL,
  'agents',
  'openai.yaml',
);
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/* Runtime dir → the runtime id its wrapper must declare (explicit tuple, not a
 * membership check, so a wrapper can't silently claim the wrong runtime). */
const RUNTIMES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['.agents/skills', CODEX_SKILL, 'codex', CODEX_CANONICAL_SOURCE, path.posix.join('..', '..', '..', CODEX_CANONICAL_SOURCE)],
  ['.claude/skills', CLAUDE_SKILL, 'claude', CLAUDE_CANONICAL_SOURCE, CLAUDE_CANONICAL_SOURCE],
];

/* Read as text, normalized to LF so a CRLF checkout doesn't fail the contract. */
function readLF(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/* Parse a leading `---`…`---` YAML block of flat `key: value` scalars; a
 * duplicate key is invalid frontmatter (the retired parser rejected it too). */
function parseFrontmatter(raw: string): Record<string, string> {
  const lines = raw.split('\n');
  assert.equal(lines[0], '---', 'wrapper must open with a frontmatter fence');
  const out: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line === '---') return out;
    const idx = line.indexOf(':');
    assert.ok(idx > 0, `malformed frontmatter line: ${line}`);
    const key = line.slice(0, idx).trim();
    assert.ok(!(key in out), `duplicate frontmatter key: ${key}`);
    out[key] = line.slice(idx + 1).trim();
  }
  throw new Error('frontmatter fence never closed');
}

/* Walk every path component from just below repoRoot down to and including
 * absPath: a symlinked ANCESTOR dir (not just the leaf file) can redirect a
 * wrapper's SKILL.md to attacker-controlled content while the leaf lstat
 * still sees a regular file. */
function assertNoSymlinkedComponent(absPath: string, repoRoot: string): void {
  const rel = path.relative(repoRoot, absPath);
  let current = repoRoot;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    assert.equal(lstatSync(current).isSymbolicLink(), false, `path component must not be a symlink: ${current}`);
  }
}

const claudeCanonical = parseFrontmatter(readLF(path.join(repoRoot, CLAUDE_CANONICAL_SOURCE)));
const codexCanonical = parseFrontmatter(readLF(path.join(repoRoot, CODEX_CANONICAL_SOURCE)));

test('runtime-specific canonical bodies declare distinct expected skill names', () => {
  assert.equal(claudeCanonical.name, CLAUDE_SKILL);
  assert.equal(codexCanonical.name, CODEX_SKILL);
  assert.ok(claudeCanonical.description && claudeCanonical.description.length > 0);
  assert.ok(codexCanonical.description && codexCanonical.description.length > 0);
});

for (const [dir, skill, expectedRuntime, canonicalSource, pointerSource] of RUNTIMES) {
  test(`static wrapper ${dir}/${skill} matches its runtime-specific canonical body`, () => {
    const raw = readLF(path.join(repoRoot, dir, skill, 'SKILL.md'));
    const fm = parseFrontmatter(raw);
    const canonical = parseFrontmatter(readLF(path.join(repoRoot, canonicalSource)));

    assert.equal(fm.name, skill, 'name must equal the runtime-specific canonical name');
    assert.match(fm.name, NAME_PATTERN, 'name must be kebab-case');
    assert.equal(fm.description, canonical.description, 'description drifted from the canonical body');
    assert.equal(fm.runtime, expectedRuntime, `${dir} must declare runtime ${expectedRuntime}`);
    assert.equal(fm.canonical_source, pointerSource, 'canonical_source must carry the runtime-correct pointer');
    const resolvedCanonical = expectedRuntime === 'codex'
      ? path.resolve(repoRoot, dir, skill, fm.canonical_source)
      : path.resolve(repoRoot, fm.canonical_source);
    assert.equal(resolvedCanonical, path.join(repoRoot, canonicalSource));
    assert.ok(existsSync(resolvedCanonical), 'canonical_source must resolve to a file');

    /* Actionable pointer: exactly one ```text fence, and the positive read
     * instruction must be immediately followed by it (a negated or detached
     * instruction, or a decoy fence before the real one, must not pass). */
    const fenceCount = (raw.match(/```text\n/g) ?? []).length;
    assert.equal(fenceCount, 1, 'wrapper must contain exactly one pointer fence');
    const block = raw.match(
      new RegExp('(?:^|\\n)Read and follow the canonical `' + skill + '` skill body:\\n\\n```text\\n([^\\n]*)\\n```'),
    );
    const pointer = block?.[1];
    assert.ok(pointer !== undefined, 'the read instruction must be immediately followed by the pointer fence');
    assert.equal(pointer.trim(), fm.canonical_source, 'the fenced pointer must equal canonical_source');

    /* Pointer, not a copy: small, and the ONLY `## ` heading is the pointer
     * section — any inlined canonical section (e.g. `## Budget`) is rejected. */
    assert.ok(Buffer.byteLength(raw) < 1500, 'wrapper must stay a thin pointer (<1500 bytes)');
    assert.deepEqual(
      raw.match(/^## .*/gm) ?? [],
      ['## Canonical body'],
      'wrapper must not inline any canonical-body section',
    );
  });
}

test('no orphan wrappers: each runtime dir holds exactly the one expected wrapper', () => {
  for (const [dir, skill] of RUNTIMES) {
    const abs = path.join(repoRoot, dir);
    /* Count symlinked dirs too — a symlinked orphan must not escape the guard. */
    const withSkill = readdirSync(abs, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(path.join(abs, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
    assert.deepEqual(withSkill, [skill], `${dir} must contain only the ${skill} wrapper`);
    assert.ok(
      lstatSync(path.join(abs, skill, 'SKILL.md')).isFile(),
      `${dir}/${skill}/SKILL.md must be a regular file, not a symlink`,
    );
  }
});

test('consumer Codex wrapper is a discoverable thin pointer to the installed submodule', () => {
  const raw = readLF(path.join(repoRoot, CONSUMER_CODEX_WRAPPER));
  const fm = parseFrontmatter(raw);

  assert.deepEqual(
    Object.keys(fm).sort(),
    ['description', 'name'],
    'Codex consumer frontmatter must contain only the supported discovery fields',
  );
  assert.equal(fm.name, CODEX_SKILL);
  assert.equal(fm.description, codexCanonical.description);

  const fenceCount = (raw.match(/```text\n/g) ?? []).length;
  assert.equal(fenceCount, 1, 'consumer Codex wrapper must contain exactly one pointer fence');
  const block = raw.match(
    new RegExp('(?:^|\\n)Read and follow the canonical `' + CODEX_SKILL + '` skill body:\\n\\n```text\\n([^\\n]*)\\n```'),
  );
  assert.equal(block?.[1]?.trim(), CONSUMER_CODEX_CANONICAL_SOURCE);
  const installedWrapperDir = path.join(path.sep, 'consumer', '.agents', 'skills', CODEX_SKILL);
  assert.equal(
    path.normalize(path.join(installedWrapperDir, CONSUMER_CODEX_CANONICAL_SOURCE)),
    path.join(path.sep, 'consumer', CONSUMER_CODEX_PACKAGE_SOURCE),
    'consumer Codex pointer must resolve from the installed SKILL.md directory',
  );
  assert.ok(existsSync(path.join(repoRoot, CODEX_CANONICAL_SOURCE)), 'consumer pointer target must ship in the package');
  assert.ok(Buffer.byteLength(raw) < 1500, 'consumer Codex wrapper must stay thin (<1500 bytes)');
  assert.deepEqual(raw.match(/^## .*/gm) ?? [], ['## Canonical body']);
  assert.match(raw, /```text\n[^\n]+\n```\n$/u, 'consumer Codex pointer must be the final body block');
});

test('consumer Claude wrapper matches the shared canonical body', () => {
  const raw = readLF(path.join(repoRoot, CONSUMER_CLAUDE_WRAPPER));
  const fm = parseFrontmatter(raw);

  assert.equal(fm.name, CLAUDE_SKILL);
  assert.equal(fm.description, claudeCanonical.description);
  assert.equal(fm.runtime, 'claude');
  assert.equal(fm.canonical_source, CONSUMER_CLAUDE_CANONICAL_SOURCE);
  const block = raw.match(
    new RegExp('(?:^|\\n)Read and follow the canonical `' + CLAUDE_SKILL + '` skill body:\\n\\n```text\\n([^\\n]*)\\n```'),
  );
  assert.equal(block?.[1]?.trim(), CONSUMER_CLAUDE_CANONICAL_SOURCE);
  assert.ok(Buffer.byteLength(raw) < 1500, 'consumer Claude wrapper must stay thin (<1500 bytes)');
});

test('consumer Codex UI metadata invokes the skill and keeps implicit discovery enabled', () => {
  const raw = readLF(path.join(repoRoot, CONSUMER_CODEX_UI));
  assert.equal(
    raw,
    [
      'interface:',
      '  display_name: "Deep Review & Refactor — Codex"',
      '  short_description: "Worker-led deep review with safe fixes"',
      '  default_prompt: "Use $deep-review-refactor-codex to review the current branch diff and automatically fix every confirmed safe, behavior-preserving finding."',
      '',
      'policy:',
      '  allow_implicit_invocation: true',
      '',
    ].join('\n'),
    'consumer Codex metadata must stay a complete, package-owned discovery definition',
  );
});

test('wrapper path has no symlinked component', () => {
  for (const [dir, skill] of RUNTIMES) {
    assertNoSymlinkedComponent(path.join(repoRoot, dir, skill, 'SKILL.md'), repoRoot);
  }
});

/* Characterize the guard against each drift mode it replaces (testing.md): it must turn RED on a
   symlinked leaf AND on a symlinked ANCESTOR (the case a leaf-only lstat misses), and stay green on
   an all-real path. A temp tree keeps the mutations self-contained. */
test('assertNoSymlinkedComponent rejects a symlinked leaf or ancestor, accepts an all-real path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ds-wrapsym-'));
  try {
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'a', 'b', 'SKILL.md'), 'x');
    assertNoSymlinkedComponent(path.join(root, 'a', 'b', 'SKILL.md'), root);

    symlinkSync(path.join(root, 'a', 'b', 'SKILL.md'), path.join(root, 'a', 'b', 'link.md'));
    assert.throws(
      () => assertNoSymlinkedComponent(path.join(root, 'a', 'b', 'link.md'), root),
      /must not be a symlink/,
      'a symlinked leaf must be rejected',
    );

    /* A symlinked ancestor with a real leaf beneath it is the case a leaf-only lstat wrongly passes. */
    mkdirSync(path.join(root, 'real'), { recursive: true });
    writeFileSync(path.join(root, 'real', 'SKILL.md'), 'x');
    symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    assert.throws(
      () => assertNoSymlinkedComponent(path.join(root, 'alias', 'SKILL.md'), root),
      /must not be a symlink/,
      'a symlinked ancestor dir must be rejected even though the leaf is a real file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
