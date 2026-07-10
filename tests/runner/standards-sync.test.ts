// standards-sync --check validates the root manifest via the built bundle and requires the schema.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shimPath = path.join(repoRoot, 'tools', 'standards-sync');
const bundleRel = path.join('runner', 'dist', 'validate-quality-manifest.mjs');
const skillsBundleRel = path.join('runner', 'dist', 'generate-skill-wrappers.mjs');
const sourcesRel = path.join('agents', 'skill-sources');

// Use bash so the suite never depends on the file's executable bit.
function runShim(args: string[], cwd: string = repoRoot): SpawnSyncReturns<string> {
  return spawnSync('bash', [shimPath, ...args], { cwd, encoding: 'utf8' });
}

function combined(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

before(() => {
  // The full --check path now spans both the validator and the skill-wrapper
  // generator bundles, so build both before exercising the shim.
  const build = spawnSync(
    'npx',
    [
      'esbuild',
      'runner/src/validate-quality-manifest.ts',
      'runner/src/generate-skill-wrappers.ts',
      '--bundle',
      '--platform=node',
      '--target=node20',
      '--format=esm',
      '--sourcemap=external',
      '--outdir=runner/dist',
      '--out-extension:.js=.mjs',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  assert.equal(build.status, 0, 'esbuild build of the standards-sync bundles must succeed');
});

// Build a self-contained fixture repo: the shim, both bundles, quality.json +
// schema, and the canonical skill sources. Wrappers are NOT copied so each test
// generates them fresh.
function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sync-'));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runner', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'schemas'), { recursive: true });
  fs.mkdirSync(path.join(dir, sourcesRel), { recursive: true });

  fs.copyFileSync(shimPath, path.join(dir, 'tools', 'standards-sync'));
  fs.copyFileSync(path.join(repoRoot, bundleRel), path.join(dir, bundleRel));
  fs.copyFileSync(path.join(repoRoot, skillsBundleRel), path.join(dir, skillsBundleRel));
  fs.copyFileSync(path.join(repoRoot, 'quality.json'), path.join(dir, 'quality.json'));
  fs.copyFileSync(
    path.join(repoRoot, 'schemas', 'quality.schema.json'),
    path.join(dir, 'schemas', 'quality.schema.json'),
  );
  for (const file of fs.readdirSync(path.join(repoRoot, sourcesRel))) {
    if (file.endsWith('.md')) {
      fs.copyFileSync(path.join(repoRoot, sourcesRel, file), path.join(dir, sourcesRel, file));
    }
  }
  return dir;
}

// The phases generated, derived from the canonical sources (filename == name).
function phaseNames(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, sourcesRel))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

test('standards-sync: no args prints usage on stderr and exits 2', () => {
  const result = runShim([]);
  assert.equal(result.status, 2, `expected exit 2; got ${result.status}`);
  assert.ok(
    /usage/i.test(result.stderr ?? ''),
    `expected a usage message on stderr; got ${JSON.stringify(result.stderr)}`,
  );
});

test('standards-sync: an unknown flag exits 2', () => {
  const result = runShim(['--frobnicate']);
  assert.equal(result.status, 2, `expected exit 2; got ${result.status}`);
  assert.ok((result.stderr ?? '').length > 0, 'expected a usage message on stderr');
});

test('standards-sync: an extra arg after --check exits 2', () => {
  const result = runShim(['--check', 'extra']);
  assert.equal(result.status, 2, `expected exit 2; got ${result.status}`);
  assert.ok((result.stderr ?? '').length > 0, 'expected a usage message on stderr');
});

test('standards-sync: --check against the real repo root exits 0 and prints both phrases', () => {
  const result = runShim(['--check']);
  assert.equal(result.status, 0, `expected exit 0; got ${result.status}: ${combined(result)}`);
  const blob = combined(result);
  assert.match(blob, /valid quality manifest/, `expected the validator phrase; got ${blob}`);
  assert.match(blob, /standards-sync check passed/, `expected the success phrase; got ${blob}`);
});

test('standards-sync: a missing schema exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sync-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'runner', 'dist'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'quality.json'), path.join(dir, 'quality.json'));
    fs.copyFileSync(path.join(repoRoot, bundleRel), path.join(dir, bundleRel));
    fs.copyFileSync(shimPath, path.join(dir, 'tools', 'standards-sync'));

    const result = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `expected exit 1; got ${result.status}: ${combined(result)}`);
    // The validator must actually run before the schema check fails.
    assert.match(combined(result), /valid quality manifest/, 'validator must actually run on the valid manifest');
    assert.match(result.stderr ?? '', /schema/i, 'expected the missing-schema message on stderr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: an invalid manifest propagates the validator exit 1 with a validation error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sync-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'runner', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'schemas'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, bundleRel), path.join(dir, bundleRel));
    fs.copyFileSync(
      path.join(repoRoot, 'schemas', 'quality.schema.json'),
      path.join(dir, 'schemas', 'quality.schema.json'),
    );
    fs.copyFileSync(shimPath, path.join(dir, 'tools', 'standards-sync'));

    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'quality.json'), 'utf8'));
    manifest.stack = 'not-a-real-stack';
    fs.writeFileSync(path.join(dir, 'quality.json'), JSON.stringify(manifest, null, 2));

    const result = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `expected exit 1; got ${result.status}: ${combined(result)}`);
    assert.match(result.stderr ?? '', /^stack: must be one of/m, `expected a validation error line; got ${JSON.stringify(result.stderr)}`);
    assert.doesNotMatch(combined(result), /standards-sync check passed/, 'the shim must not report success on an invalid manifest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: a missing bundle exits 127 with a build hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sync-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'schemas'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'quality.json'), path.join(dir, 'quality.json'));
    fs.copyFileSync(
      path.join(repoRoot, 'schemas', 'quality.schema.json'),
      path.join(dir, 'schemas', 'quality.schema.json'),
    );
    fs.copyFileSync(shimPath, path.join(dir, 'tools', 'standards-sync'));

    const result = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 127, `expected exit 127; got ${result.status}: ${combined(result)}`);
    assert.match(result.stderr ?? '', /npm run build/, 'expected a "run npm run build" hint on stderr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- skill-wrapper generation + drift (spec §13) --------------------------

test('standards-sync: both-runtimes-generated', () => {
  const dir = makeFixtureRepo();
  try {
    const gen = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(gen.status, 0, `generate should exit 0; got ${gen.status}: ${combined(gen)}`);

    for (const name of phaseNames()) {
      for (const runtimeDir of ['.agents/skills', '.claude/skills']) {
        const wrapper = path.join(dir, runtimeDir, name, 'SKILL.md');
        assert.ok(fs.existsSync(wrapper), `expected a generated wrapper at ${runtimeDir}/${name}/SKILL.md`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: wrappers-are-metadata-plus-pointer-no-duplicated-body', () => {
  const dir = makeFixtureRepo();
  try {
    spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], { cwd: dir, encoding: 'utf8' });

    for (const name of phaseNames()) {
      const sourceBody = fs.readFileSync(path.join(dir, sourcesRel, `${name}.md`), 'utf8');
      // A distinctive line from each canonical body: its H1 heading.
      const bodyHeading = `# ${name} - canonical skill body`;
      assert.ok(sourceBody.includes(bodyHeading), `sanity: source ${name}.md should contain "${bodyHeading}"`);

      for (const runtimeDir of ['.agents/skills', '.claude/skills']) {
        const wrapper = fs.readFileSync(path.join(dir, runtimeDir, name, 'SKILL.md'), 'utf8');
        // Metadata is present...
        assert.match(wrapper, new RegExp(`^name: ${name}$`, 'm'), `wrapper ${runtimeDir}/${name} must carry the name`);
        assert.match(wrapper, /^description: /m, `wrapper ${runtimeDir}/${name} must carry a description`);
        // ...and a pointer naming the canonical source...
        assert.ok(
          wrapper.includes(`agents/skill-sources/${name}.md`),
          `wrapper ${runtimeDir}/${name} must point at the canonical source path`,
        );
        // ...but the canonical body prose is NOT duplicated.
        assert.ok(
          !wrapper.includes(bodyHeading),
          `wrapper ${runtimeDir}/${name} must NOT duplicate the canonical body`,
        );
        assert.ok(
          !wrapper.includes('## Judgment steps') && !wrapper.includes('## Contract block'),
          `wrapper ${runtimeDir}/${name} must NOT duplicate body sections`,
        );
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: a clean generate then --check round-trips to exit 0', () => {
  const dir = makeFixtureRepo();
  try {
    const gen = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(gen.status, 0, `generate should exit 0; got ${combined(gen)}`);

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, `--check after a clean generate should exit 0; got ${combined(check)}`);
    assert.match(combined(check), /skill wrappers in sync/, 'expected the in-sync phrase');
    assert.match(combined(check), /standards-sync check passed/, 'expected overall success');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: drift-fails-check', () => {
  const dir = makeFixtureRepo();
  try {
    spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], { cwd: dir, encoding: 'utf8' });

    // Mutate one committed wrapper to introduce drift.
    const [first] = phaseNames();
    assert.ok(first, 'at least one phase must exist');
    const mutated = path.join(dir, '.claude', 'skills', first as string, 'SKILL.md');
    fs.appendFileSync(mutated, '\nhand-edited drift line\n');

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.notEqual(check.status, 0, 'a drifted wrapper must fail --check');
    assert.match(check.stderr ?? '', /drift/i, `expected a drift message; got ${JSON.stringify(check.stderr)}`);
    assert.match(check.stderr ?? '', new RegExp(first as string), 'the drift message should name the offending wrapper');
    assert.doesNotMatch(combined(check), /standards-sync check passed/, 'must not report success on drift');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: a pre-change generated orphan fails --check as stale and is removed by --generate-skills (RUN-05)', () => {
  const dir = makeFixtureRepo();
  try {
    // Generate a clean tree, then plant a stale generated-marked wrapper whose
    // canonical source does not exist (e.g. a renamed/deleted skill).
    spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], { cwd: dir, encoding: 'utf8' });
    const orphanDir = path.join(dir, '.agents', 'skills', 'ghost-phase');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'SKILL.md'), 'GENERATED FILE - do not edit. stale wrapper\n');

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(check.status, 0, 'a stale generated orphan must fail --check');
    assert.match(check.stderr ?? '', /stale wrapper/i, `expected a stale-wrapper message; got ${JSON.stringify(check.stderr)}`);
    assert.match(check.stderr ?? '', /ghost-phase/, 'the stale message should name the orphan');

    // Regenerating removes the generated-marked orphan and the tree is in sync.
    const regen = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], { cwd: dir, encoding: 'utf8' });
    assert.equal(regen.status, 0, `regenerate should exit 0; got ${combined(regen)}`);
    assert.ok(!fs.existsSync(path.join(orphanDir, 'SKILL.md')), 'the generated orphan must be removed by --generate-skills');

    const recheck = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], { cwd: dir, encoding: 'utf8' });
    assert.equal(recheck.status, 0, `--check after cleanup should exit 0; got ${combined(recheck)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: a missing wrapper fails --check as drift', () => {
  const dir = makeFixtureRepo();
  try {
    spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], { cwd: dir, encoding: 'utf8' });

    const [first] = phaseNames();
    fs.rmSync(path.join(dir, '.agents', 'skills', first as string, 'SKILL.md'), { force: true });

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.notEqual(check.status, 0, 'a missing wrapper must fail --check');
    assert.match(check.stderr ?? '', /missing wrapper/i, `expected a missing-wrapper message; got ${JSON.stringify(check.stderr)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: check-skips-wrapper-drift-when-no-skills-tree', () => {
  // Mirrors dev-standards as a SOURCE repo: it has the canonical bodies and a
  // valid quality.json, but hosts NO .agents/skills or .claude/skills tree.
  // --check must validate the manifest, SKIP wrapper drift, and still pass.
  const dir = makeFixtureRepo();
  try {
    // Sanity: the fixture has the bodies but no wrappers yet (none generated).
    assert.ok(!fs.existsSync(path.join(dir, '.agents', 'skills')), 'fixture must not host .agents/skills');
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills')), 'fixture must not host .claude/skills');

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, `--check on a source repo must exit 0; got ${check.status}: ${combined(check)}`);
    const blob = combined(check);
    assert.match(blob, /valid quality manifest/, 'the manifest validator must still run');
    assert.match(blob, /wrapper drift check skipped/, 'wrapper-drift must report it was skipped');
    assert.match(blob, /standards-sync check passed/, 'overall check must still pass');
    // No drift comparison ran, so it must not claim wrappers are in sync.
    assert.doesNotMatch(blob, /skill wrappers in sync/, 'must not claim in-sync when no wrappers exist');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: --check on a source repo (bodies, no skills tree) FAILS on a malformed body', () => {
  // FIX 1: even with NO .agents/skills or .claude/skills tree, --check must
  // validate the canonical bodies themselves. A body with broken frontmatter
  // must fail (exit 1) and name the offending body, NOT pass via the old early
  // hostsWrappers return. (The wrapper-drift COMPARISON is still skipped.)
  const dir = makeFixtureRepo();
  try {
    assert.ok(!fs.existsSync(path.join(dir, '.agents', 'skills')), 'fixture must not host .agents/skills');
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills')), 'fixture must not host .claude/skills');

    // Corrupt one canonical body's frontmatter (drop the closing "---").
    const [first] = phaseNames();
    assert.ok(first, 'at least one phase must exist');
    const srcPath = path.join(dir, sourcesRel, `${first as string}.md`);
    const raw = fs.readFileSync(srcPath, 'utf8');
    const broken = raw.replace(/^---\n([\s\S]*?)\n---\n/, '---\n$1\n');
    assert.notEqual(broken, raw, 'sanity: the closing --- should have been removed');
    fs.writeFileSync(srcPath, broken);

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(check.status, 1, `a malformed body must fail --check; got ${check.status}: ${combined(check)}`);
    assert.match(check.stderr ?? '', /frontmatter/i, 'expected a frontmatter error on stderr');
    assert.match(check.stderr ?? '', new RegExp(first as string), 'the error should name the offending body');
    assert.doesNotMatch(combined(check), /standards-sync check passed/, 'must not report success on a malformed body');
    assert.doesNotMatch(check.stderr ?? '', /at Object\.|node:internal/, 'must be a clean error, not a stack trace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: --check on a source repo FAILS when a body name is not kebab-case', () => {
  // FIX 1 + FIX 2 together: the body-parse path runs on a source repo, so a
  // non-kebab-case name in a canonical body is caught even with no skills tree.
  const dir = makeFixtureRepo();
  try {
    const [first] = phaseNames();
    assert.ok(first, 'at least one phase must exist');
    const srcPath = path.join(dir, sourcesRel, `${first as string}.md`);
    const raw = fs.readFileSync(srcPath, 'utf8');
    // Rewrite the name line to a non-kebab value (and rename the file to match,
    // so the failure is the kebab check, not the name!=filename check).
    const badName = 'Bad_Name';
    const rewritten = raw.replace(/^name: .*$/m, `name: ${badName}`);
    assert.notEqual(rewritten, raw, 'sanity: the name line should have changed');
    fs.rmSync(srcPath, { force: true });
    fs.writeFileSync(path.join(dir, sourcesRel, `${badName}.md`), rewritten);

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(check.status, 1, `a non-kebab body name must fail --check; got ${check.status}: ${combined(check)}`);
    assert.match(check.stderr ?? '', /kebab-case/i, 'expected a kebab-case error on stderr');
    assert.doesNotMatch(combined(check), /standards-sync check passed/, 'must not report success');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: a source with missing frontmatter fails sanely (exit 1, no crash)', () => {
  const dir = makeFixtureRepo();
  try {
    // Strip the frontmatter from one canonical source.
    const [first] = phaseNames();
    const srcPath = path.join(dir, sourcesRel, `${first as string}.md`);
    const raw = fs.readFileSync(srcPath, 'utf8');
    const stripped = raw.replace(/^---\n[\s\S]*?\n---\n\n/, '');
    assert.notEqual(stripped, raw, 'sanity: frontmatter should have been removed');
    fs.writeFileSync(srcPath, stripped);

    const gen = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(gen.status, 1, `missing frontmatter should exit 1; got ${gen.status}: ${combined(gen)}`);
    assert.match(gen.stderr ?? '', /frontmatter/i, 'expected a frontmatter error message');
    assert.doesNotMatch(gen.stderr ?? '', /at Object\.|node:internal/, 'must be a clean error, not a stack trace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: --generate-skills with a missing generator bundle exits 127', () => {
  const dir = makeFixtureRepo();
  try {
    fs.rmSync(path.join(dir, skillsBundleRel), { force: true });
    const gen = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(gen.status, 127, `expected exit 127; got ${gen.status}: ${combined(gen)}`);
    assert.match(gen.stderr ?? '', /npm run build/, 'expected a build hint on stderr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- S19 D4 + D5: the 7th body (deep-review-refactor) end-to-end -----------
// The body already ships in agents/skill-sources, so the generator auto-discovers
// it by directory scan. These cases are regression guards: immediate green is the
// expected, correct outcome (not red-first TDD).

test('standards-sync: the deep-review-refactor body generates both runtime wrappers pointing at the canonical source', () => {
  const dir = makeFixtureRepo();
  try {
    const gen = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(gen.status, 0, `generate should exit 0; got ${gen.status}: ${combined(gen)}`);

    const codexWrapper = path.join(dir, '.agents', 'skills', 'deep-review-refactor', 'SKILL.md');
    const claudeWrapper = path.join(dir, '.claude', 'skills', 'deep-review-refactor', 'SKILL.md');
    assert.ok(fs.existsSync(codexWrapper), 'expected the codex deep-review wrapper at .agents/skills/deep-review-refactor/SKILL.md');
    assert.ok(fs.existsSync(claudeWrapper), 'expected the claude deep-review wrapper at .claude/skills/deep-review-refactor/SKILL.md');

    for (const wrapperPath of [codexWrapper, claudeWrapper]) {
      const wrapper = fs.readFileSync(wrapperPath, 'utf8');
      assert.ok(
        wrapper.includes('canonical_source: agents/skill-sources/deep-review-refactor.md'),
        `${wrapperPath} must point at the canonical deep-review source`,
      );
      // Deep-Review-Slice lives only in the canonical body; a thin wrapper must not duplicate it.
      assert.ok(
        !wrapper.includes('Deep-Review-Slice'),
        `${wrapperPath} must NOT duplicate the canonical body (found Deep-Review-Slice)`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: the deep-review-refactor wrapper round-trips byte-identically through --check', () => {
  const dir = makeFixtureRepo();
  try {
    const gen = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(gen.status, 0, `generate should exit 0; got ${gen.status}: ${combined(gen)}`);

    const codexWrapper = path.join(dir, '.agents', 'skills', 'deep-review-refactor', 'SKILL.md');
    assert.ok(fs.existsSync(codexWrapper), 'the deep-review wrapper must exist before --check');

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    // --check regenerates and byte-compares, so exit 0 IS the byte-identity proof.
    assert.equal(check.status, 0, `--check after a clean generate should exit 0; got ${combined(check)}`);
    assert.match(combined(check), /skill wrappers in sync/, 'expected the in-sync phrase');
    assert.match(combined(check), /standards-sync check passed/, 'expected overall success');
    assert.ok(fs.existsSync(codexWrapper), 'the deep-review wrapper must still exist at check time');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: a drifted deep-review-refactor codex wrapper fails --check and is named', () => {
  const dir = makeFixtureRepo();
  try {
    spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--generate-skills'], { cwd: dir, encoding: 'utf8' });

    // Mutate the generated codex deep-review wrapper to introduce drift.
    const relWrapper = '.agents/skills/deep-review-refactor/SKILL.md';
    const mutated = path.join(dir, '.agents', 'skills', 'deep-review-refactor', 'SKILL.md');
    fs.appendFileSync(mutated, '\nhand-edited drift line\n');

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.notEqual(check.status, 0, 'a drifted deep-review wrapper must fail --check');
    assert.match(check.stderr ?? '', /drift/i, `expected a drift message; got ${JSON.stringify(check.stderr)}`);
    assert.ok(
      (check.stderr ?? '').includes(relWrapper),
      `the drift message should name ${relWrapper}; got ${JSON.stringify(check.stderr)}`,
    );
    assert.doesNotMatch(combined(check), /standards-sync check passed/, 'must not report success on drift');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standards-sync: --check on a source repo validates the deep-review-refactor body and skips wrapper drift', () => {
  const dir = makeFixtureRepo();
  try {
    // The fixture carries the deep-review body but hosts no generated skills tree.
    assert.ok(
      fs.existsSync(path.join(dir, sourcesRel, 'deep-review-refactor.md')),
      'fixture must carry the deep-review-refactor canonical body',
    );
    assert.ok(!fs.existsSync(path.join(dir, '.agents', 'skills')), 'fixture must not host .agents/skills');
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills')), 'fixture must not host .claude/skills');

    const check = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, `--check on a source repo must exit 0; got ${check.status}: ${combined(check)}`);
    const blob = combined(check);
    assert.match(blob, /valid quality manifest/, 'the manifest validator must still run');
    assert.match(blob, /wrapper drift check skipped/, 'wrapper-drift must report it was skipped');
    assert.match(blob, /standards-sync check passed/, 'overall check must still pass');
    // No drift comparison ran, so it must not claim wrappers are in sync.
    assert.doesNotMatch(blob, /skill wrappers in sync/, 'must not claim in-sync when no wrappers exist');

    // Prove the deep-review body is actually VALIDATED on a source repo (not just
    // that wrapper-drift is skipped): corrupt its frontmatter (drop the closing
    // "---") and --check must fail, naming the deep-review-refactor body. This makes
    // the "validates the body" claim self-evidencing rather than leaning on the
    // generic malformed-body test, which corrupts a different (alphabetically first) body.
    const bodyPath = path.join(dir, sourcesRel, 'deep-review-refactor.md');
    const raw = fs.readFileSync(bodyPath, 'utf8');
    const broken = raw.replace(/^---\n([\s\S]*?)\n---\n/, '---\n$1\n');
    assert.notEqual(broken, raw, 'sanity: the closing --- should have been removed');
    fs.writeFileSync(bodyPath, broken);

    const recheck = spawnSync('bash', [path.join(dir, 'tools', 'standards-sync'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(
      recheck.status,
      1,
      `a malformed deep-review body must fail --check; got ${recheck.status}: ${combined(recheck)}`,
    );
    assert.match(recheck.stderr ?? '', /frontmatter/i, 'expected a frontmatter error on stderr');
    assert.match(recheck.stderr ?? '', /deep-review-refactor/, 'the error should name the deep-review-refactor body');
    assert.doesNotMatch(combined(recheck), /standards-sync check passed/, 'must not report success on a malformed body');
    assert.doesNotMatch(recheck.stderr ?? '', /at Object\.|node:internal/, 'must be a clean error, not a stack trace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
