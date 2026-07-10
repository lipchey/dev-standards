// Unit tests for the skill-wrapper generator's pure parse/validate path
// (generate-skill-wrappers.ts). The end-to-end --generate/--check behaviour is
// exercised through the shim in standards-sync.test.ts; these cover the
// frontmatter contract directly: kebab-case name allowlist (FIX 2), name ==
// filename, and non-empty name/description (FIX 4 additive coverage).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseFrontmatter,
  collectPhases,
  renderWrapper,
  canonicalSourceRel,
  generate,
  check,
  run,
  RUNTIMES,
  EXIT_OK,
  EXIT_FAIL,
  EXIT_USAGE,
  type Frontmatter,
} from '../../runner/src/generate-skill-wrappers.ts';

const SOURCE_DIR = path.join('agents', 'skill-sources');

// Write a single canonical body fixture under a fresh temp repo and return root.
function repoWithBody(filename: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-wrap-'));
  fs.mkdirSync(path.join(dir, SOURCE_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, SOURCE_DIR, filename), body);
  return dir;
}

function fm(name: string, description = 'a valid description'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# body\n`;
}

// ── FIX 2: kebab-case name allowlist ──────────────────────────────────────────

test('parseFrontmatter rejects a name with "..": not kebab-case', () => {
  const result = parseFrontmatter(fm('..'));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /kebab-case/i);
    assert.match(result.message, /\.\./, 'the message should name the offending value');
  }
});

test('parseFrontmatter rejects a name with capitals/underscores', () => {
  const result = parseFrontmatter(fm('Name_With_Caps'));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /kebab-case/i);
  }
});

test('parseFrontmatter rejects a name that does not start with a letter', () => {
  const leadingDigit = parseFrontmatter(fm('1phase'));
  assert.equal(leadingDigit.ok, false);
  const leadingDash = parseFrontmatter(fm('-phase'));
  assert.equal(leadingDash.ok, false);
});

test('parseFrontmatter accepts a valid kebab-case name', () => {
  const result = parseFrontmatter(fm('review-plan'));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.frontmatter.name, 'review-plan');
    assert.equal(result.frontmatter.description, 'a valid description');
  }
});

test('collectPhases rejects a body whose frontmatter name is not kebab-case', () => {
  const dir = repoWithBody('phase.md', fm('Bad_Name'));
  try {
    const result = collectPhases(dir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /kebab-case/i);
      assert.match(result.message, /phase\.md/, 'the message should name the offending file');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── FIX 4 additive: name == filename, and non-empty name/description ───────────

test('collectPhases rejects a body whose frontmatter name != filename', () => {
  // Valid kebab-case name, but it disagrees with the filename stem.
  const dir = repoWithBody('plan.md', fm('review-plan'));
  try {
    const result = collectPhases(dir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /must match filename/i);
      assert.match(result.message, /plan/, 'the message should name the file/expected stem');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseFrontmatter rejects a blank name', () => {
  const result = parseFrontmatter('---\nname: \ndescription: ok\n---\n\n# body\n');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /name/i);
});

test('parseFrontmatter rejects a blank description', () => {
  const result = parseFrontmatter('---\nname: plan\ndescription: \n---\n\n# body\n');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /description/i);
});

// ── Shared helpers for the hardening tests ────────────────────────────────────

function bodyFor(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name} - canonical skill body\n`;
}

// A source root carrying one or more canonical bodies (name -> description).
function sourceRepo(bodies: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-src-'));
  fs.mkdirSync(path.join(dir, SOURCE_DIR), { recursive: true });
  for (const [name, description] of Object.entries(bodies)) {
    fs.writeFileSync(path.join(dir, SOURCE_DIR, `${name}.md`), bodyFor(name, description));
  }
  return dir;
}

function emptyRoot(prefix = 'gw-tgt-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// Extract the frontmatter block AND the fenced human-instruction pointer from a
// generated wrapper. canonical_source appears in BOTH; this returns both raw.
function readWrapperPointers(text: string): { frontmatter: string; fenced: string } {
  const fmMatch = text.match(/^([\s\S]*?)^canonical_source: (.*)$/m);
  const frontmatter = fmMatch ? (fmMatch[2] as string) : '';
  const fenceMatch = text.match(/```text\n(.*)\n```/);
  const fenced = fenceMatch ? (fenceMatch[1] as string) : '';
  return { frontmatter, fenced };
}

// ── RUN-08: robust YAML scalar rendering + decode ─────────────────────────────

test('RUN-08: parseFrontmatter decodes a double-quoted description with JSON escapes', () => {
  // A description that is unsafe bare (colon, brackets, quotes) authored quoted.
  const raw = '---\nname: plan\ndescription: "Use: safely [danger] say \\"hi\\""\n---\n\n# body\n';
  const result = parseFrontmatter(raw);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.frontmatter.description, 'Use: safely [danger] say "hi"');
});

test('RUN-08: parseFrontmatter decodes a single-quoted scalar (doubled-quote escape)', () => {
  const raw = "---\nname: plan\ndescription: 'it''s fine'\n---\n\n# body\n";
  const result = parseFrontmatter(raw);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.frontmatter.description, "it's fine");
});

test('RUN-08: parseFrontmatter rejects a balanced-but-invalid double-quoted scalar', () => {
  // Balanced quotes, but an invalid JSON escape (\q) inside.
  const bad = parseFrontmatter('---\nname: plan\ndescription: "a\\q"\n---\n\n# body\n');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.message, /double-quoted/i);
});

test('RUN-08: parseFrontmatter rejects a duplicate frontmatter key', () => {
  const raw = '---\nname: plan\ndescription: one\ndescription: two\n---\n\n# body\n';
  const result = parseFrontmatter(raw);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /duplicate frontmatter key/i);
});

test('RUN-08: renderWrapper quotes dangerous scalars into valid, round-tripping YAML', () => {
  const runtime = RUNTIMES[0]!;
  for (const description of [
    'Use: safely',
    '[danger]',
    ' leading space',
    'trailing space ',
    'has a # hash',
    'quote " inside',
    'true',
  ]) {
    const fmIn: Frontmatter = { name: 'plan', description };
    const wrapper = renderWrapper(fmIn, runtime, 'agents/skill-sources/plan.md');
    // The rendered frontmatter must parse (valid YAML), and the description must
    // survive the round trip byte-for-byte.
    const parsed = parseFrontmatter(wrapper);
    assert.equal(parsed.ok, true, `wrapper for ${JSON.stringify(description)} must parse`);
    if (parsed.ok) {
      assert.equal(parsed.frontmatter.description, description, `round-trip for ${JSON.stringify(description)}`);
    }
    // A dangerous scalar must actually be quoted (not emitted bare).
    assert.match(wrapper, new RegExp(`^description: ".*"$`, 'm'), `${JSON.stringify(description)} must be quoted`);
  }
});

test('RUN-08: renderWrapper leaves plain scalars bare (byte-identity guard)', () => {
  const runtime = RUNTIMES[0]!;
  const fmIn: Frontmatter = { name: 'review-plan', description: 'Use when the workflow reaches the review-plan phase.' };
  const wrapper = renderWrapper(fmIn, runtime, 'agents/skill-sources/review-plan.md');
  assert.match(wrapper, /^name: review-plan$/m, 'plain name must be bare');
  assert.match(wrapper, /^description: Use when the workflow reaches the review-plan phase\.$/m, 'plain description must be bare');
  assert.match(wrapper, /^canonical_source: agents\/skill-sources\/review-plan\.md$/m, 'plain path must be bare');
});

// ── core-fix #1: canonical_source (2 locations, clone-stable POSIX pointer) ────

test('core-fix #1: same-root canonical_source is the historic literal in BOTH locations', () => {
  const runtime = RUNTIMES[0]!;
  const wrapper = renderWrapper({ name: 'plan', description: 'd' }, runtime, canonicalSourceRel('/repo', '/repo', 'plan'));
  const { frontmatter, fenced } = readWrapperPointers(wrapper);
  assert.equal(frontmatter, 'agents/skill-sources/plan.md');
  assert.equal(fenced, 'agents/skill-sources/plan.md');
  assert.equal(frontmatter, fenced, 'both occurrences must be identical');
});

test('core-fix #1: cross-root canonical_source is a POSIX relative pointer in BOTH locations, and resolves to the source file', () => {
  const src = sourceRepo({ plan: 'A plain description' });
  const tgt = emptyRoot();
  try {
    const gen = generate(src, tgt);
    assert.equal(gen.code, EXIT_OK, `cross-root generate should succeed; got ${gen.stderr.join('\n')}`);

    const wrapperPath = path.join(tgt, '.agents', 'skills', 'plan', 'SKILL.md');
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');
    const { frontmatter, fenced } = readWrapperPointers(wrapper);

    // Same pointer in both places, POSIX separators, target-root-relative.
    assert.equal(frontmatter, fenced, 'both occurrences must match');
    assert.ok(!frontmatter.includes('\\'), 'pointer must use POSIX separators');
    assert.notEqual(frontmatter, 'agents/skill-sources/plan.md', 'cross-root pointer must not be the same-root literal');
    assert.match(frontmatter, /\.\.\//, 'sibling cross-root pointer contains "../"');

    // Both occurrences resolve (from the target root) to the real source file.
    const realSource = fs.realpathSync(path.join(src, SOURCE_DIR, 'plan.md'));
    for (const pointer of [frontmatter, fenced]) {
      const resolved = fs.realpathSync(path.resolve(tgt, pointer));
      assert.equal(resolved, realSource, `pointer ${pointer} must resolve to the source body`);
    }
  } finally {
    cleanup(src, tgt);
  }
});

test('core-fix #1: canonicalSourceRel is byte-identical to the historic literal at same root', () => {
  assert.equal(canonicalSourceRel('/a/b', '/a/b', 'plan'), 'agents/skill-sources/plan.md');
  assert.equal(canonicalSourceRel('/x', '/x', 'deep-review-refactor'), 'agents/skill-sources/deep-review-refactor.md');
});

// ── core-fix #1: CLI flag design (repo-root alias + source/target split) ───────

test('CLI: --repo-root is a back-compat alias that sets both roots', () => {
  const src = sourceRepo({ plan: 'd' });
  try {
    const result = run(['--generate', '--repo-root', src]);
    assert.equal(result.code, EXIT_OK, result.stderr.join('\n'));
    assert.ok(fs.existsSync(path.join(src, '.agents', 'skills', 'plan', 'SKILL.md')), 'wrote wrappers into the single root');
  } finally {
    cleanup(src);
  }
});

test('CLI: --source-root + --target-root generates cross-root', () => {
  const src = sourceRepo({ plan: 'd' });
  const tgt = emptyRoot();
  try {
    const result = run(['--generate', '--source-root', src, '--target-root', tgt]);
    assert.equal(result.code, EXIT_OK, result.stderr.join('\n'));
    assert.ok(fs.existsSync(path.join(tgt, '.agents', 'skills', 'plan', 'SKILL.md')), 'wrote wrappers into the target root');
    assert.ok(!fs.existsSync(path.join(src, '.agents', 'skills')), 'must NOT write into the source root');
  } finally {
    cleanup(src, tgt);
  }
});

test('CLI: --source-root alone defaults target to source', () => {
  const src = sourceRepo({ plan: 'd' });
  try {
    const result = run(['--generate', '--source-root', src]);
    assert.equal(result.code, EXIT_OK, result.stderr.join('\n'));
    assert.ok(fs.existsSync(path.join(src, '.agents', 'skills', 'plan', 'SKILL.md')));
  } finally {
    cleanup(src);
  }
});

test('CLI: mixing --repo-root with --source-root is a usage error', () => {
  const result = run(['--generate', '--repo-root', '/a', '--source-root', '/b']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr.join('\n'), /cannot be combined/i);
});

test('CLI: duplicate --repo-root is a usage error', () => {
  const result = run(['--check', '--repo-root', '/a', '--repo-root', '/b']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr.join('\n'), /given twice/i);
});

test('CLI: --target-root without --source-root is a usage error', () => {
  const result = run(['--generate', '--target-root', '/t']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr.join('\n'), /source-root is required/i);
});

test('CLI: two modes is a usage error', () => {
  const result = run(['--generate', '--check', '--repo-root', '/a']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr.join('\n'), /exactly one mode/i);
});

// ── RUN-03: target-side symlink confinement (discovery, write, deletion) ───────

test('RUN-03: generate refuses a symlinked skills-dir parent and does NOT overwrite the external file', () => {
  const src = sourceRepo({ plan: 'd' });
  const tgt = emptyRoot();
  const external = emptyRoot('gw-ext-');
  const externalFile = path.join(external, 'SKILL.md');
  fs.writeFileSync(externalFile, 'EXTERNAL - do not touch\n');
  try {
    // .agents/skills -> external dir. A naive generator would write
    // .agents/skills/plan/SKILL.md THROUGH the symlink into `external`.
    fs.mkdirSync(path.join(tgt, '.agents'), { recursive: true });
    fs.symlinkSync(external, path.join(tgt, '.agents', 'skills'));

    const result = generate(src, tgt);
    assert.equal(result.code, EXIT_FAIL, 'a symlinked skills dir must fail generation');
    assert.match(result.stderr.join('\n'), /symlink/i);
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'EXTERNAL - do not touch\n', 'external file must be untouched');
  } finally {
    cleanup(src, tgt, external);
  }
});

test('RUN-03: generate refuses a symlinked leaf (SKILL.md -> external file)', () => {
  const src = sourceRepo({ plan: 'd' });
  const tgt = emptyRoot();
  const external = emptyRoot('gw-ext-');
  const externalFile = path.join(external, 'target.md');
  fs.writeFileSync(externalFile, 'EXTERNAL\n');
  try {
    const leafDir = path.join(tgt, '.agents', 'skills', 'plan');
    fs.mkdirSync(leafDir, { recursive: true });
    fs.symlinkSync(externalFile, path.join(leafDir, 'SKILL.md'));

    const result = generate(src, tgt);
    assert.equal(result.code, EXIT_FAIL, 'a symlinked leaf must fail generation');
    assert.match(result.stderr.join('\n'), /symlink/i);
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'EXTERNAL\n', 'external target must be untouched');
  } finally {
    cleanup(src, tgt, external);
  }
});

test('RUN-03/05: the orphan-cleanup discovery path refuses a symlinked wrapper subdir (dangerous deletion path)', () => {
  const src = sourceRepo({ plan: 'd' });
  const tgt = emptyRoot();
  const external = emptyRoot('gw-ext-');
  // An external dir that LOOKS like a generated wrapper (carries the marker).
  fs.writeFileSync(path.join(external, 'SKILL.md'), 'GENERATED FILE - do not edit. external\n');
  try {
    // Real planned dirs are fine; but an extra `evil` subdir is a symlink to
    // the external dir. Discovery (orphan scan) must refuse to follow it.
    fs.mkdirSync(path.join(tgt, '.agents', 'skills'), { recursive: true });
    fs.symlinkSync(external, path.join(tgt, '.agents', 'skills', 'evil'));

    const result = generate(src, tgt);
    assert.equal(result.code, EXIT_FAIL, 'a symlinked orphan subdir must fail generation, not delete through it');
    assert.match(result.stderr.join('\n'), /symlink/i);
    assert.ok(fs.existsSync(path.join(external, 'SKILL.md')), 'external file behind the symlink must survive');
  } finally {
    cleanup(src, tgt, external);
  }
});

// ── RUN-05: stale/orphan detection + generated-only deletion ──────────────────

test('RUN-05: check FAILS on a pre-change orphan (generated-marked wrapper with no source)', () => {
  const src = sourceRepo({ plan: 'd' });
  try {
    // Generate same-root, then remove the `plan` source so the wrapper is stale.
    const gen = generate(src, src);
    assert.equal(gen.code, EXIT_OK, gen.stderr.join('\n'));
    // Add a body so collectPhases still finds >=1 source (drop `plan`).
    fs.writeFileSync(path.join(src, SOURCE_DIR, 'keep.md'), bodyFor('keep', 'd'));
    fs.rmSync(path.join(src, SOURCE_DIR, 'plan.md'));

    const result = check(src, src, true);
    assert.equal(result.code, EXIT_FAIL, 'a stale generated wrapper must fail --check');
    assert.match(result.stderr.join('\n'), /stale wrapper/i);
    assert.match(result.stderr.join('\n'), /plan/, 'the message should name the orphan');
  } finally {
    cleanup(src);
  }
});

test('RUN-05: generate deletes a generated-marked orphan but keeps a non-generated stray', () => {
  const src = sourceRepo({ plan: 'd' });
  try {
    generate(src, src);
    // A stale generated-marked orphan (no matching source).
    const orphanDir = path.join(src, '.agents', 'skills', 'gone');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'SKILL.md'), 'GENERATED FILE - do not edit. old\n');
    // A hand-authored file WITHOUT the marker must be left alone.
    const keepDir = path.join(src, '.agents', 'skills', 'keepme');
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(path.join(keepDir, 'SKILL.md'), 'hand-authored, not generated\n');

    const result = generate(src, src);
    assert.equal(result.code, EXIT_OK, result.stderr.join('\n'));
    assert.ok(!fs.existsSync(path.join(orphanDir, 'SKILL.md')), 'the generated orphan must be removed');
    assert.match(result.stdout.join('\n'), /removed orphan/i);
    assert.ok(fs.existsSync(path.join(keepDir, 'SKILL.md')), 'a non-generated stray must be kept');
  } finally {
    cleanup(src);
  }
});

// ── RUN-07: only-ENOENT-is-absent + cross-root check-before-generate ──────────

test('RUN-07: SOURCE_DIR being a regular file is a structured failure, not a silent skip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-badsrc-'));
  try {
    // agents/ exists but skill-sources is a FILE, so readdir throws ENOTDIR.
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, SOURCE_DIR), 'not a directory\n');

    const result = check(dir, dir, true);
    assert.equal(result.code, EXIT_FAIL, 'ENOTDIR on the source dir must fail, not skip to exit 0');
    assert.match(result.stderr.join('\n'), /skill sources/i);
  } finally {
    cleanup(dir);
  }
});

test('RUN-07: cross-root check-before-generate FAILS (planned wrappers required)', () => {
  const src = sourceRepo({ plan: 'd', 'review-plan': 'd' });
  const tgt = emptyRoot();
  try {
    // Target has no wrappers yet. A cross-root check must NOT skip drift; it must
    // require the planned wrappers and fail on their absence.
    const result = check(src, tgt, false);
    assert.equal(result.code, EXIT_FAIL, 'cross-root check with no wrappers must fail');
    assert.match(result.stderr.join('\n'), /missing wrapper/i);
    assert.doesNotMatch(result.stdout.join('\n'), /drift check skipped/i, 'cross-root must not take the skip path');
  } finally {
    cleanup(src, tgt);
  }
});

test('RUN-07: cross-root check passes after a matching generate', () => {
  const src = sourceRepo({ plan: 'd' });
  const tgt = emptyRoot();
  try {
    assert.equal(generate(src, tgt).code, EXIT_OK);
    const result = check(src, tgt, false);
    assert.equal(result.code, EXIT_OK, `cross-root check after generate should pass; got ${result.stderr.join('\n')}`);
    assert.match(result.stdout.join('\n'), /in sync/i);
  } finally {
    cleanup(src, tgt);
  }
});
