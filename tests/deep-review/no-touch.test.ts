import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_TOUCH_BASELINE,
  parseNoTouchAdditions,
  buildNoTouchSet,
  isNoTouch,
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

const DEFAULT_REF = '.agents/project-facts.md';

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
    ['.githooks/**', '.github/workflows/**', 'verify', 'tools/**', 'auth/**', 'credentials/**'],
  );
  const set = [...NO_TOUCH_BASELINE];
  for (const p of [
    'tools/x.sh',
    'auth/keys/a',
    '.github/workflows/ci.yml',
    'verify',
    '.githooks/pre-commit',
    'credentials/token',
  ]) {
    assert.equal(isNoTouch(p, set), true, `${p} should be no-touch`);
  }
});

test('a path under no baseline and no repo addition (e.g. runner/src/glob.ts) -> editable', () => {
  const set = [...NO_TOUCH_BASELINE];
  assert.equal(isNoTouch('runner/src/glob.ts', set), false);
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
