import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_TOUCH_BASELINE,
  parseNoTouchAdditions,
  buildNoTouchSet,
  isNoTouch,
  NoTouchSourceError,
  selfProtectedPaths,
  policyProtectedPaths,
} from '../../deep-review/src/no-touch.ts';

// ── Test doubles ─────────────────────────────────────────────────────────────

// In-memory readFile seam + captured warn sink so set-building never touches disk.
function harness(files: Record<string, string> = {}): {
  readFile: (p: string) => string;
  warn: (m: string) => void;
  warnings: string[];
} {
  const store = new Map<string, string>(Object.entries(files));
  const warnings: string[] = [];
  return {
    readFile: (p: string): string => {
      const value = store.get(p);
      if (value === undefined) throw new Error(`ENOENT: ${p}`);
      return value;
    },
    warn: (m: string): void => {
      warnings.push(m);
    },
    warnings,
  };
}

const DEFAULT_REF = '.claude/project-facts.md';

// A project-facts body whose No-Touch Zones section lists ONE addition and omits
// every baseline glob; prose (and a bullet under a LATER heading) must be ignored.
const PROJECT_FACTS = `# Project Facts

Intro prose mentioning \`runner/**\` which must NOT be parsed (it is prose).

## No-Touch Zones

- \`.agents/**\` — agent-owned knowledge, never auto-edited

## Other Section

- \`unrelated/**\` should not count
`;

// ── Tests ────────────────────────────────────────────────────────────────────

test('NO_TOUCH_BASELINE matches a baseline path (e.g. tools/x.sh, auth/keys/a, .github/workflows/ci.yml, verify) -> no-touch', () => {
  assert.deepEqual(
    [...NO_TOUCH_BASELINE],
    [
      '.githooks/**',
      '.github/workflows/**',
      'verify',
      'tools/**',
      'auth/**',
      'credentials/**',
      '.claude/settings.json',
      '.claude/hooks/**',
      'scripts/deep-review',
      'vendor/**',
    ],
  );
  const set = [...NO_TOUCH_BASELINE];
  for (const p of [
    'tools/x.sh',
    'auth/keys/a',
    '.github/workflows/ci.yml',
    'verify',
    '.githooks/pre-commit',
    'credentials/token',
    // The guides-read enforcement mechanism (ADR-016): a fix slice must never disarm it.
    '.claude/settings.json',
    '.claude/hooks/deep-review-guard.mjs',
    'scripts/deep-review',
    // The vendored dev-standards tree (ADR-016): guide templates + the gitlink pin.
    'vendor/dev-standards/agents/review-guide-templates/security-review.md',
    'vendor/dev-standards',
  ]) {
    assert.equal(isNoTouch(p, set), true, `${p} should be no-touch`);
  }
});

test('a path under no baseline and no repo addition (e.g. runner/src/glob.ts) -> editable', () => {
  const set = [...NO_TOUCH_BASELINE];
  assert.equal(isNoTouch('runner/src/glob.ts', set), false);
});

test('policyProtectedPaths (ADR-016) protects every required_read + the whole guides overlay dir', () => {
  const set = policyProtectedPaths(['.claude/CHECKLIST.md', './.claude/code-conventions.md'], '.claude/review-guides');
  // A fix slice targeting a required guide or any overlay file is no-touch; canonicalized so
  // a `./`-spelled required_read still matches its canonical slice path.
  assert.equal(isNoTouch('.claude/CHECKLIST.md', set), true);
  assert.equal(isNoTouch('.claude/code-conventions.md', set), true);
  assert.equal(isNoTouch('.claude/review-guides/repo-extra.md', set), true);
  // R2-4b: the BARE overlay dir is protected too (a gitlink/symlink AT that path that
  // `<dir>/**` alone would not match), so a slice cannot repoint it.
  assert.equal(isNoTouch('.claude/review-guides', set), true);
  // An unrelated source file stays editable.
  assert.equal(isNoTouch('src/logic.ts', set), false);
});

test('a repo project-facts.md ## No-Touch Zones bullet (e.g. .agents/**) extends the set -> .agents/x is no-touch', () => {
  const h = harness({ [DEFAULT_REF]: PROJECT_FACTS });
  const set = buildNoTouchSet({ readFile: h.readFile, warn: h.warn });

  assert.equal(isNoTouch('.agents/x', set), true, '.agents/x should become no-touch');
  // Prose-mentioned and post-heading bullets must NOT enter the set.
  assert.equal(isNoTouch('runner/foo.ts', set), false, 'prose glob must not count');
  assert.equal(isNoTouch('unrelated/foo', set), false, 'bullet under a later heading must not count');
  assert.deepEqual(h.warnings, []);
});

test('project-facts.md that OMITS a baseline glob still treats that baseline path as no-touch (extend-only, never shrink)', () => {
  const h = harness({ [DEFAULT_REF]: PROJECT_FACTS });
  const set = buildNoTouchSet({ readFile: h.readFile, warn: h.warn });

  // The ref lists only `.agents/**` and omits every baseline glob; the baseline
  // floor must survive untouched (union-only).
  assert.equal(isNoTouch('tools/x.sh', set), true, 'omitted baseline tools/** must remain no-touch');
  assert.equal(isNoTouch('auth/keys/a', set), true, 'omitted baseline auth/** must remain no-touch');
  for (const g of NO_TOUCH_BASELINE) assert.ok(set.includes(g), `${g} must remain in the set`);
});

test('a no_touch_globs_ref value carrying a #fragment (e.g. project-facts.md#no-touch-zones) resolves to the file and still parses the additions', () => {
  const h = harness({ [DEFAULT_REF]: PROJECT_FACTS });
  const set = buildNoTouchSet({
    noTouchGlobsRef: `${DEFAULT_REF}#no-touch-zones`,
    readFile: h.readFile,
    warn: h.warn,
  });

  assert.equal(isNoTouch('.agents/x', set), true, 'fragment must be stripped and the file read');
  assert.deepEqual(h.warnings, []);
});

test('a missing / unreadable no_touch_globs_ref file falls back to the baseline alone (warn, not crash)', () => {
  const h = harness({}); // empty store -> readFile throws
  let set: string[] = [];
  assert.doesNotThrow(() => {
    set = buildNoTouchSet({ readFile: h.readFile, warn: h.warn });
  });

  assert.deepEqual(set, [...NO_TOUCH_BASELINE], 'set must be exactly the baseline');
  assert.equal(h.warnings.length, 1, 'exactly one warning emitted');
});

test('only "- " list-item bullets under the heading are parsed; a prose sentence containing backticked globs is NOT added as a repo addition', () => {
  const withProse = `## No-Touch Zones

Sensitive globs like \`secret/**\` and \`private/**\` must never be auto-edited.

- \`.agents/**\`
`;
  assert.deepEqual(parseNoTouchAdditions(withProse), ['.agents/**']);
});

// ── mode + repoRootAbs confinement (fix-mode hardening) ─────────────────────

const REPO_ROOT = '/repo';
const identityRealpath = (p: string): string => p;

test('fix mode + missing no_touch_globs_ref -> throws NoTouchSourceError (never warns)', () => {
  const h = harness({}); // empty store -> readFile throws ENOENT
  assert.throws(
    () =>
      buildNoTouchSet({
        readFile: h.readFile,
        warn: h.warn,
        mode: 'fix',
        repoRootAbs: REPO_ROOT,
        realpath: identityRealpath,
      }),
    NoTouchSourceError,
  );
  assert.deepEqual(h.warnings, [], 'fix mode must throw instead of warning');
});

test('fix mode + unparseable no_touch_globs_ref (readFile throws a non-ENOENT read error) -> throws NoTouchSourceError', () => {
  const warnings: string[] = [];
  const readFile = (_p: string): string => {
    throw new Error('invalid encoding: not valid UTF-8');
  };
  assert.throws(
    () =>
      buildNoTouchSet({
        readFile,
        warn: (m) => warnings.push(m),
        mode: 'fix',
        repoRootAbs: REPO_ROOT,
        realpath: identityRealpath,
      }),
    NoTouchSourceError,
  );
  assert.deepEqual(warnings, []);
});

test('review-only mode (explicit) + missing no_touch_globs_ref -> baseline, warns, never throws', () => {
  const h = harness({});
  let set: string[] = [];
  assert.doesNotThrow(() => {
    set = buildNoTouchSet({
      readFile: h.readFile,
      warn: h.warn,
      mode: 'review-only',
      repoRootAbs: REPO_ROOT,
      realpath: identityRealpath,
    });
  });
  assert.deepEqual(set, [...NO_TOUCH_BASELINE]);
  assert.equal(h.warnings.length, 1);
});

test('a no_touch_globs_ref that resolves outside repoRootAbs -> throws NoTouchSourceError in EITHER mode', () => {
  const h = harness({ [DEFAULT_REF]: PROJECT_FACTS });
  const escapingRealpath = (_p: string): string => '/outside/etc/passwd';

  for (const mode of ['review-only', 'fix'] as const) {
    assert.throws(
      () =>
        buildNoTouchSet({
          readFile: h.readFile,
          warn: h.warn,
          mode,
          repoRootAbs: REPO_ROOT,
          realpath: escapingRealpath,
        }),
      NoTouchSourceError,
      `mode ${mode} must throw on escape`,
    );
  }
});

test('a realpath dep that throws (ref target does not exist) is NOT treated as an escape -- falls through to missing/unreadable handling', () => {
  const h = harness({}); // empty store -> readFile also throws
  const throwingRealpath = (_p: string): string => {
    throw new Error('ENOENT: no such file or directory');
  };
  let set: string[] = [];
  assert.doesNotThrow(() => {
    set = buildNoTouchSet({
      readFile: h.readFile,
      warn: h.warn,
      mode: 'review-only',
      repoRootAbs: REPO_ROOT,
      realpath: throwingRealpath,
    });
  });
  assert.deepEqual(set, [...NO_TOUCH_BASELINE]);
});

// ── §G7 lexical escape precedes realpath; symlinked-ancestor escape ──────────────

test('G7: a lexical ../ escape with a NONEXISTENT target throws NoTouchSourceError in BOTH modes (existence-independent)', () => {
  const h = harness({}); // empty store: the target does not exist
  const missingRealpath = (_p: string): string => {
    throw new Error('ENOENT: no such file or directory');
  };
  for (const mode of ['review-only', 'fix'] as const) {
    assert.throws(
      () =>
        buildNoTouchSet({
          noTouchGlobsRef: '../escape.md',
          readFile: h.readFile,
          warn: h.warn,
          mode,
          repoRootAbs: REPO_ROOT,
          realpath: missingRealpath,
        }),
      NoTouchSourceError,
      `mode ${mode} must reject a lexical ../ escape even when the target is missing`,
    );
  }
  assert.deepEqual(h.warnings, [], 'a lexical escape throws, never warns');
});

test('G7: a ref whose deepest EXISTING ancestor realpaths OUTSIDE the repo (symlinked dir) throws, even with a missing leaf', () => {
  const h = harness({}); // the leaf itself does not exist
  // The leaf is missing (realpath throws), but its parent `.agents` is a symlink resolving out of
  // the repo; the deepest-existing-ancestor realpath must catch the escape.
  const realpath = (p: string): string => {
    if (p === REPO_ROOT) return REPO_ROOT;
    if (p === `${REPO_ROOT}/.agents`) return '/outside/agents';
    throw new Error('ENOENT');
  };
  assert.throws(
    () =>
      buildNoTouchSet({
        noTouchGlobsRef: '.agents/project-facts.md',
        readFile: h.readFile,
        warn: h.warn,
        mode: 'review-only',
        repoRootAbs: REPO_ROOT,
        realpath,
      }),
    NoTouchSourceError,
  );
});

test('G7: a legitimate MISSING in-root ref (no escape) falls through to the mode-gated fallback (warn / throw could-not-read)', () => {
  const h = harness({}); // in-root ref, but the file is missing
  const realpath = (p: string): string => {
    if (p === REPO_ROOT) return REPO_ROOT; // the root resolves; the leaf and `.agents` do not
    throw new Error('ENOENT');
  };
  // review-only: warn + baseline (never throws for a missing in-root ref).
  let set: string[] = [];
  assert.doesNotThrow(() => {
    set = buildNoTouchSet({
      readFile: h.readFile,
      warn: h.warn,
      mode: 'review-only',
      repoRootAbs: REPO_ROOT,
      realpath,
    });
  });
  assert.deepEqual(set, [...NO_TOUCH_BASELINE]);
  assert.equal(h.warnings.length, 1);
  // fix: the same missing in-root ref throws could-not-read (NOT an escape).
  assert.throws(
    () =>
      buildNoTouchSet({
        readFile: h.readFile,
        warn: h.warn,
        mode: 'fix',
        repoRootAbs: REPO_ROOT,
        realpath,
      }),
    NoTouchSourceError,
  );
});

test('omitting repoRootAbs/realpath (legacy call site) skips confinement entirely -- unchanged pre-existing behavior', () => {
  const h = harness({ [DEFAULT_REF]: PROJECT_FACTS });
  const set = buildNoTouchSet({ readFile: h.readFile, warn: h.warn });
  assert.equal(isNoTouch('.agents/x', set), true);
});

test('fix mode WITHOUT repoRootAbs/realpath -> throws NoTouchSourceError (confinement is mandatory when failing closed)', () => {
  const h = harness({ [DEFAULT_REF]: PROJECT_FACTS });
  assert.throws(
    () => buildNoTouchSet({ readFile: h.readFile, warn: h.warn, mode: 'fix' }),
    NoTouchSourceError,
  );
  assert.deepEqual(h.warnings, [], 'must throw, not warn');
});

// ── §F4 self-protected policy inputs (quality.json + the no-touch source file) ──

test('F4: selfProtectedPaths returns quality.json + the resolved no-touch source (default / custom / fragment-stripped)', () => {
  assert.deepEqual(selfProtectedPaths(), ['quality.json', DEFAULT_REF]);
  assert.deepEqual(selfProtectedPaths(''), ['quality.json', DEFAULT_REF]);
  assert.deepEqual(selfProtectedPaths('docs/facts.md'), ['quality.json', 'docs/facts.md']);
  assert.deepEqual(selfProtectedPaths('docs/facts.md#no-touch-zones'), ['quality.json', 'docs/facts.md']);
});

test('G2: selfProtectedPaths canonicalizes the ref (./ and docs/../ spellings) so it matches the canonical slice path', () => {
  assert.deepEqual(selfProtectedPaths('./.claude/project-facts.md'), ['quality.json', DEFAULT_REF]);
  assert.deepEqual(selfProtectedPaths('docs/../.claude/project-facts.md'), ['quality.json', DEFAULT_REF]);
  assert.deepEqual(selfProtectedPaths('./.claude/project-facts.md#no-touch-zones'), ['quality.json', DEFAULT_REF]);
  // The canonicalized ref actually matches a slice targeting it (a literal `./…` would not).
  const set = [...NO_TOUCH_BASELINE, ...selfProtectedPaths('./.claude/project-facts.md')];
  assert.equal(isNoTouch('.claude/project-facts.md', set), true, 'canonical ref matches the canonical slice path');
});

test('F4: the self-protected paths match as no-touch (a fix slice can never target quality.json or the project-facts source)', () => {
  const set = [...NO_TOUCH_BASELINE, ...selfProtectedPaths()];
  assert.equal(isNoTouch('quality.json', set), true, 'the manifest is no-touch in fix mode');
  assert.equal(isNoTouch('.claude/project-facts.md', set), true, 'the no-touch source file is no-touch in fix mode');
});

// ── verify_entry protection: the configured shim is baseline no-touch in EVERY mode ──

test('a relocated verify_entry (scripts/verify) is no-touch in BOTH modes — parity with the baseline `verify`, so classify defers it AND a fix slice cannot rewrite the gate to self-approve', () => {
  for (const mode of ['review-only', 'fix'] as const) {
    const set = buildNoTouchSet({
      verifyEntry: 'scripts/verify',
      readFile: () => '',
      warn: () => {},
      mode,
      repoRootAbs: '/repo',
      realpath: (p) => p,
    });
    assert.equal(isNoTouch('scripts/verify', set), true, `scripts/verify is no-touch in ${mode}`);
  }
});

test('verify_entry is canonicalized (a ./scripts/verify config value still matches the canonical slice path)', () => {
  const set = buildNoTouchSet({
    verifyEntry: './scripts/verify',
    readFile: () => '',
    warn: () => {},
    mode: 'review-only',
    repoRootAbs: '/repo',
    realpath: (p) => p,
  });
  assert.equal(isNoTouch('scripts/verify', set), true, 'the leading ./ is stripped so it matches');
});
