#!/usr/bin/env node
/* Test-to-source placement gate (REPORT-ONLY): every test file must sit at the
   location its subject's SOURCE path dictates — replicating every intermediate
   subfolder — under a configured (testRoot, sourceRoot, sourceExt) mapping, so a
   reader can map any test to its source and back without searching. Complements
   check-companion-tests (which owns whether a test EXISTS): this owns whether the
   test that exists is in the mirrored place. The review-guide lens
   (profile-tests-quality.md §Test-to-source traceability and placement) owns the
   judgment cases a path-map can't express.

   Pure list-processor — the runner passes the tracked file list via a single
   {files:<fileset>} token on argv; the tool does NO filesystem or git I/O (the
   in-memory tree snapshot is enough to test that a computed mirror path is a
   tracked file). Wired report-only so a placement finding (exit 1) surfaces drift
   without blocking; only an internal error (exit 2, bad args / unsupported glob)
   blocks, via the runner's operational_exit_codes. */

import { pathToFileURL } from 'node:url';

const DEFAULT_TEST_GLOBS = ['**/*.test.ts', '**/*.test.mjs', '**/*.spec.ts'];
const UNSUPPORTED_GLOB_SYNTAX = /[?[{]/;
/* A test filename ends in <name>.(test|spec).<ext>; capture only <name>, the subject stem. */
const TEST_SUFFIX = /^(.+)\.(?:test|spec)\.(?:ts|mts|cts|tsx|mjs|cjs|js|jsx)$/;

/* A test is misplaced when its computed mirror source path is not a tracked file.
   `maps` may hold several rows sharing a testRoot (a `tests/tools` test whose
   subject lives in `tools/*.mjs` OR `scripts/*.sh`): the test passes if ANY
   (map, candidate) resolves. */
export function evaluate(files, { maps, testGlobs, ignoreGlobs }) {
  const fileSet = new Set(files);
  const tests = files.filter(
    (file) =>
      testGlobs.some((glob) => matches(file, glob)) &&
      !ignoreGlobs.some((glob) => matches(file, glob)),
  );
  const misplaced = [];
  for (const test of tests) {
    const rows = maps.filter((map) => test.startsWith(`${map.testRoot}/`));
    /* outside every mapped root — not this gate's concern (the profile lens owns flat-root placement) */
    if (rows.length === 0) continue;
    /* Resolve the subject INDEPENDENTLY per matching map: rel/relDir/stem depend on that map's own
       testRoot, so overlapping roots (tests/runner vs tests) never cross-contaminate candidates. The
       test is placed correctly if ANY matching map resolves it. */
    let expected;
    const found = rows.some((map) => {
      const rel = test.slice(map.testRoot.length + 1);
      const slash = rel.lastIndexOf('/');
      const relDir = slash === -1 ? '' : rel.slice(0, slash);
      const base = slash === -1 ? rel : rel.slice(slash + 1);
      const suffix = TEST_SUFFIX.exec(base);
      /* matched a test-glob but not the <name>.test.<ext> shape under this map — unresolvable here */
      if (!suffix) return false;
      const stem = suffix[1];
      if (expected === undefined) expected = joinPath(map.sourceRoot, relDir, stem + map.sourceExt);
      return dotStripCandidates(stem).some((cand) =>
        fileSet.has(joinPath(map.sourceRoot, relDir, cand + map.sourceExt)),
      );
    });
    /* expected stays undefined only when no matching map yielded a resolvable stem — nothing to flag. */
    if (!found && expected !== undefined) misplaced.push({ test, expected });
  }
  const ok = misplaced.length === 0;
  const message = ok
    ? ''
    : `tests not mirrored to their source path:\n${misplaced
        .map((m) => `  ${m.test} — no source at ${m.expected} (or a dot-stripped variant)`)
        .join('\n')}\nMove each test to the path that mirrors its subject, or add it to --ignore if it has no 1:1 subject.`;
  return { ok, misplaced, message };
}

/* Progressive dot-strip: `exec.bypass` -> ["exec.bypass","exec"]; `validate` -> ["validate"].
   Lets one source own several test variants (exec.test.ts, exec.bypass.test.ts) without config. */
function dotStripCandidates(stem) {
  const out = [stem];
  let cur = stem;
  let dot = cur.lastIndexOf('.');
  while (dot > 0) {
    cur = cur.slice(0, dot);
    out.push(cur);
    dot = cur.lastIndexOf('.');
  }
  return out;
}

function joinPath(...parts) {
  return parts.filter((p) => p !== '').join('/');
}

/* --map testRoot:sourceRoot:sourceExt — three colon-separated fields; sourceExt starts with a dot.
   Roots must be clean repo-relative paths: a stray leading/trailing/double slash would make prefix
   matching or path joining silently match nothing (a gate that checks nothing) — reject it, exit 2. */
function parseMap(spec) {
  const parts = spec.split(':');
  if (parts.length !== 3 || parts.some((p) => p === '')) {
    throw new Error(`--map expects testRoot:sourceRoot:sourceExt, got "${spec}"`);
  }
  const [testRoot, sourceRoot, sourceExt] = parts;
  for (const root of [testRoot, sourceRoot]) {
    if (root.startsWith('/') || root.endsWith('/') || root.includes('//')) {
      throw new Error(`--map root must be a clean repo-relative path (no leading/trailing/double slash), got "${root}"`);
    }
  }
  if (!sourceExt.startsWith('.')) throw new Error(`--map sourceExt must start with ".", got "${sourceExt}"`);
  return { testRoot, sourceRoot, sourceExt };
}

/* Restricted dialect: "**" (any depth, incl. zero segments), "*" (one segment, never crosses "/"),
   and literal segments. Copied from check-companion-tests.mjs — the runner keeps tools as standalone
   processors, each carrying its own matcher.
   ponytail: ~40 LOC duplicated with check-companion-tests by the standalone-tool convention; extract
   a shared tools/lib module only if a third tool needs the same matcher. */
export function matches(path, pattern) {
  assertSupportedGlob(pattern);
  return matchSegments(path.split('/'), pattern.split('/'));
}

function assertSupportedGlob(pattern) {
  /* An empty pattern matches nothing — as a --test-glob it silently disables the check, so reject it. */
  if (pattern === '') throw new Error('glob pattern must be non-empty');
  if (UNSUPPORTED_GLOB_SYNTAX.test(pattern)) {
    throw new Error(
      `pattern "${pattern}" uses unsupported glob syntax ("?", "[", or "{"); the restricted dialect allows "**", "*", and literal segments`,
    );
  }
}

function matchSegments(pathSegs, patSegs) {
  if (patSegs.length === 0) return pathSegs.length === 0;
  const [patHead, ...patRest] = patSegs;
  if (patHead === '**') {
    for (let i = 0; i <= pathSegs.length; i += 1) {
      if (matchSegments(pathSegs.slice(i), patRest)) return true;
    }
    return false;
  }
  if (pathSegs.length === 0) return false;
  const [pathHead, ...pathRest] = pathSegs;
  return matchSegment(pathHead, patHead) && matchSegments(pathRest, patRest);
}

function matchSegment(segment, pattern) {
  let si = 0;
  let pi = 0;
  let starAt = -1;
  let matchFrom = 0;
  while (si < segment.length) {
    if (pi < pattern.length && pattern[pi] === segment[si]) {
      si += 1;
      pi += 1;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starAt = pi;
      matchFrom = si;
      pi += 1;
    } else if (starAt !== -1) {
      pi = starAt + 1;
      matchFrom += 1;
      si = matchFrom;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') pi += 1;
  return pi === pattern.length;
}

function parseArgs(argv) {
  const maps = [];
  const testGlobs = [];
  const ignoreGlobs = [];
  let i = 0;
  while (i < argv.length && argv[i] !== '--') {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} requires an argument`);
    if (flag === '--map') maps.push(parseMap(value));
    else if (flag === '--test-glob') {
      assertSupportedGlob(value);
      testGlobs.push(value);
    } else if (flag === '--ignore') {
      assertSupportedGlob(value);
      ignoreGlobs.push(value);
    } else throw new Error(`unrecognized argument: ${flag}`);
    i += 2;
  }
  if (maps.length === 0) throw new Error('at least one --map testRoot:sourceRoot:sourceExt is required');
  const files = i < argv.length ? argv.slice(i + 1) : [];
  return { maps, testGlobs: testGlobs.length > 0 ? testGlobs : DEFAULT_TEST_GLOBS, ignoreGlobs, files };
}

/* Exit codes: 0 = ok, 1 = genuine finding (a misplaced test), 2 = operational failure (an internal
   throw — bad args, unsupported glob). The distinct code 2 lets the runner classify a throw as an
   'error' via operational_exit_codes instead of a bypassable finding. */
export function main(argv) {
  try {
    const { maps, testGlobs, ignoreGlobs, files } = parseArgs(argv);
    const result = evaluate(files, { maps, testGlobs, ignoreGlobs });
    if (result.ok) {
      process.stdout.write('test-placement: ok\n');
      return 0;
    }
    process.stderr.write(`${result.message}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`test-placement: ${error?.message ?? error}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
