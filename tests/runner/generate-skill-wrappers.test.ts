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
