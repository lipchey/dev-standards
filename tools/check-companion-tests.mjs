#!/usr/bin/env node
/* Companion-test gate: a commit that stages source must also stage a test.
   Pure list-processor — the runner passes an already ACMR-filtered file list on argv, so this
   tool does no git or filesystem I/O and has no operational-failure path (a git error here would
   otherwise exit nonzero and, on a bypassable check, be silently bypassed). It also inherits the
   runner's ACMR diff-filter for free: a deleted test file never reaches argv. */

import { pathToFileURL } from 'node:url';

const DECL_SUFFIX = '.d.ts';
const DEFAULT_TEST_GLOBS = ['**/*.test.ts', '**/*.spec.ts'];
const UNSUPPORTED_GLOB_SYNTAX = /[?[{]/;

export function evaluate(files, { testGlobs }) {
  const testsStaged = files.filter((file) => testGlobs.some((glob) => matches(file, glob)));
  const testSet = new Set(testsStaged);
  const srcNeedingTests = files.filter((file) => !testSet.has(file) && !file.endsWith(DECL_SUFFIX));
  const ok = srcNeedingTests.length === 0 || testsStaged.length > 0;
  const message = ok
    ? ''
    : `staged source without any staged test: ${srcNeedingTests.join(', ')} — add a test, or set DS_BYPASS_REASON=<why> to bypass`;
  return { ok, srcNeedingTests, testsStaged, message };
}

/* Restricted dialect: "**" (any depth, incl. zero segments), "*" (one segment, never crosses "/"),
   and literal segments. Mirrors runner/src/validate.ts's UNSUPPORTED_GLOB_SYNTAX. Path segments are
   always literal subjects — only `pattern` is interpreted. */
export function matches(path, pattern) {
  assertSupportedGlob(pattern);
  return matchSegments(path.split('/'), pattern.split('/'));
}

function assertSupportedGlob(pattern) {
  if (UNSUPPORTED_GLOB_SYNTAX.test(pattern)) {
    throw new Error(
      `pattern "${pattern}" uses unsupported glob syntax ("?", "[", or "{"); the restricted dialect allows "**", "*", and literal segments`,
    );
  }
}

/* ponytail: recursive globstar match — O(2^k) worst case for k `**` segments
   against a non-matching path. Bounded in practice because patterns here are
   static config with a single `**`; upgrade to DP over (path,pattern) indices if
   multi-`**` patterns are ever accepted from untrusted input. */
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

/* Classic two-pointer "*" wildcard match within one segment — linear, no regex backtracking risk. */
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
  const testGlobs = [];
  let i = 0;
  while (i < argv.length && argv[i] !== '--') {
    if (argv[i] !== '--tests') {
      throw new Error(`unrecognized argument: ${argv[i]}`);
    }
    const glob = argv[i + 1];
    if (glob === undefined) throw new Error('--tests requires a glob argument');
    assertSupportedGlob(glob);
    testGlobs.push(glob);
    i += 2;
  }
  const files = i < argv.length ? argv.slice(i + 1) : [];
  return { testGlobs: testGlobs.length > 0 ? testGlobs : DEFAULT_TEST_GLOBS, files };
}

export function main(argv) {
  const { testGlobs, files } = parseArgs(argv);
  const result = evaluate(files, { testGlobs });
  if (result.ok) {
    process.stdout.write('companion-tests: ok\n');
    return 0;
  }
  process.stderr.write(`${result.message}\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
