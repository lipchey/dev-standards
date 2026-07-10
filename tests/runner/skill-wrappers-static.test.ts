/*
 * Static contract for the committed skill wrappers. Replaces the retired
 * generate-skill-wrappers drift check (Phase 2): the single surviving skill
 * (deep-review-refactor) ships hand-written per-runtime wrappers, so this
 * guards the invariants the generator used to enforce — name/description match
 * the canonical body, the pointer is actionable and equals canonical_source,
 * the body is not duplicated, and no orphan wrapper appears. Adversarial
 * hardening (Gate C): CRLF-safe, rejects duplicate keys, requires the
 * instruction and the sole pointer fence to form one block, forbids any inlined
 * canonical section, and counts symlinked orphans.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = 'deep-review-refactor';
const CANONICAL_SOURCE = path.posix.join('agents', 'skill-sources', `${SKILL}.md`);
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/* Runtime dir → the runtime id its wrapper must declare (explicit tuple, not a
 * membership check, so a wrapper can't silently claim the wrong runtime). */
const RUNTIMES: ReadonlyArray<readonly [string, string]> = [
  ['.agents/skills', 'codex'],
  ['.claude/skills', 'claude'],
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

const canonical = parseFrontmatter(readLF(path.join(repoRoot, CANONICAL_SOURCE)));

test('canonical body declares the expected skill name', () => {
  assert.equal(canonical.name, SKILL);
  assert.ok(canonical.description && canonical.description.length > 0);
});

for (const [dir, expectedRuntime] of RUNTIMES) {
  test(`static wrapper ${dir}/${SKILL} matches the canonical body`, () => {
    const raw = readLF(path.join(repoRoot, dir, SKILL, 'SKILL.md'));
    const fm = parseFrontmatter(raw);

    assert.equal(fm.name, SKILL, 'name must equal the canonical name');
    assert.match(fm.name, NAME_PATTERN, 'name must be kebab-case');
    assert.equal(fm.description, canonical.description, 'description drifted from the canonical body');
    assert.equal(fm.runtime, expectedRuntime, `${dir} must declare runtime ${expectedRuntime}`);
    assert.equal(fm.canonical_source, CANONICAL_SOURCE, 'canonical_source must point at the body');
    assert.ok(existsSync(path.join(repoRoot, fm.canonical_source)), 'canonical_source must resolve to a file');

    /* Actionable pointer: exactly one ```text fence, and the positive read
     * instruction must be immediately followed by it (a negated or detached
     * instruction, or a decoy fence before the real one, must not pass). */
    const fenceCount = (raw.match(/```text\n/g) ?? []).length;
    assert.equal(fenceCount, 1, 'wrapper must contain exactly one pointer fence');
    const block = raw.match(
      new RegExp('(?:^|\\n)Read and follow the canonical `' + SKILL + '` skill body:\\n\\n```text\\n([^\\n]*)\\n```'),
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
  for (const [dir] of RUNTIMES) {
    const abs = path.join(repoRoot, dir);
    /* Count symlinked dirs too — a symlinked orphan must not escape the guard. */
    const withSkill = readdirSync(abs, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(path.join(abs, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
    assert.deepEqual(withSkill, [SKILL], `${dir} must contain only the ${SKILL} wrapper`);
    assert.ok(
      lstatSync(path.join(abs, SKILL, 'SKILL.md')).isFile(),
      `${dir}/${SKILL}/SKILL.md must be a regular file, not a symlink`,
    );
  }
});
