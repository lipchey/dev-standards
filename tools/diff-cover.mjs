#!/usr/bin/env node
/*
 * diff-cover: coverage of ONLY added/changed lines vs a base ref.
 *
 * A whole-repo coverage percentage hides untested new code behind a mass of
 * already-covered old code; this reports the number that actually gates a change.
 * The load-bearing edges — coverage-key path normalization (C7), an N/A rather
 * than invented denominator (C8), and a loud failure on an unresolvable base
 * (C9) — exist so the emitted percentage is never credible-but-false.
 *
 * Dep-free Node ESM (bare `node tools/diff-cover.mjs`). Pure fns
 * (parseUnifiedDiff / normalizeCoverageKeys / computeCoverage / loadCoverage)
 * carry the logic and are unit-tested; git + base-ref resolution is a thin
 * CLI wrapper.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ---- restricted glob matcher (for --exclude) -------------------------------
 * Same dialect as tools/check-companion-tests.mjs and runner/src/glob.ts:
 * "**" (any depth incl. zero segments), "*" (one segment, never crosses "/"),
 * literal segments. Duplicated here to keep this tool dep-free bare-node ESM
 * rather than importing across tools; a future unification is inbox territory. */
const UNSUPPORTED_GLOB_SYNTAX = /[?[{]/;

export function matches(filePath, pattern) {
  if (UNSUPPORTED_GLOB_SYNTAX.test(pattern)) {
    throw new Error(
      `pattern "${pattern}" uses unsupported glob syntax ("?", "[", or "{"); the restricted dialect allows "**", "*", and literal segments`,
    );
  }
  return matchSegments(filePath.split('/'), pattern.split('/'));
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

/* ---- parseUnifiedDiff ------------------------------------------------------
 * Parse `git diff --unified=0` output into the NEW-side changed lines per file.
 * Only hunk headers are needed: with --unified=0 the new-side count equals the
 * number of added lines. `@@ -a,b +c,d @@` → new lines [c, c+d) (d omitted ⇒ 1,
 * d===0 ⇒ deletion-only hunk ⇒ no new lines).
 */
export function parseUnifiedDiff(diffText) {
  const result = {};
  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  let current;
  /* Each file section starts with an unambiguous `diff --git` line; only within
     that header (before the first `@@`) is a `+++ ` line the new-file path. A
     hunk BODY line like `+++ counter;` (an added source line `++ counter;`) has
     inHeader=false, so it is never mistaken for a file header. */
  let inHeader = false;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      current = undefined;
      continue;
    }
    if (inHeader && line.startsWith('+++ ')) {
      current = parseDiffTarget(line.slice(4));
      continue;
    }
    if (line.startsWith('@@')) {
      inHeader = false;
      const match = hunkHeader.exec(line);
      if (!match || current === undefined) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      if (count === 0) continue; /* deletion-only hunk: no new lines */
      const lines = result[current] ?? (result[current] = []);
      for (let l = start; l < start + count; l += 1) lines.push(l);
    }
  }
  return result;
}

/* `+++ b/path` → `path`; `+++ /dev/null` (file deletion) → undefined. Git may
 * quote paths with special chars; strip the surrounding quotes if present. */
function parseDiffTarget(raw) {
  let target = raw.trim();
  if (target === '/dev/null') return undefined;
  if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1);
  if (target.startsWith('b/') || target.startsWith('a/')) target = target.slice(2);
  return target;
}

/* ---- normalizeCoverageKeys -------------------------------------------------
 * Coverage keys are absolute filesystem paths (v8 provider); diff paths are
 * repo-relative POSIX. Canonicalize coverage keys to root-relative forward-slash
 * form so they can be matched. Entries outside the root are dropped; a duplicate
 * normalized key is mapping ambiguity → loud fail.
 */
export function normalizeCoverageKeys(coverage, repoRoot) {
  const out = {};
  for (const [key, entry] of Object.entries(coverage)) {
    const abs = path.resolve(repoRoot, entry.path ?? key);
    const rel = path.relative(repoRoot, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue; /* outside root */
    const relPosix = rel.split(path.sep).join('/');
    if (Object.prototype.hasOwnProperty.call(out, relPosix)) {
      throw new Error(`duplicate normalized coverage key: ${relPosix}`);
    }
    out[relPosix] = entry;
  }
  return out;
}

/* ---- computeCoverage -------------------------------------------------------
 * With vitest coverage.all + include, every source file appears in the JSON
 * (untested files have zero hit counts). So:
 *   - excluded → matched a --exclude glob → skip.
 *   - present  → count executable changed lines (statement start lines); covered
 *                if that line's statement was hit.
 *   - absent + matches an --include glob → a source file with NO coverage entry
 *                is a coverage MISCONFIGURATION (coverage.all off, or include
 *                unaligned) → LOUD FAIL, never a silent skip that inflates the %.
 *   - absent + no --include match → not a source file (config/markdown) → skip.
 * Zero executable changed lines overall → total N/A (null), never invented 0/100%.
 */
export function computeCoverage(changedLinesByFile, coverageByRelPath, options = {}) {
  const excludes = options.excludes ?? [];
  const includes = options.includes ?? [];
  const files = [];
  let totalExecutable = 0;
  let totalCovered = 0;

  for (const [file, changedLines] of Object.entries(changedLinesByFile)) {
    if (excludes.some((glob) => matches(file, glob))) continue;
    const entry = coverageByRelPath[file];
    if (entry === undefined) {
      if (includes.some((glob) => matches(file, glob))) {
        throw new Error(
          `source file "${file}" matches --include but has no coverage entry — ` +
            'enable coverage.all and align coverage.include with --include/--exclude',
        );
      }
      continue; /* not a source file per --include → exclude entirely */
    }

    const { executable, covered } = lineCoverage(entry);
    let changedExecutable = 0;
    let changedCovered = 0;
    for (const line of new Set(changedLines)) {
      if (!executable.has(line)) continue; /* blank/comment/type-only → not in denominator */
      changedExecutable += 1;
      if (covered.has(line)) changedCovered += 1;
    }
    if (changedExecutable === 0) continue; /* no measurable lines in this file */

    files.push({
      path: file,
      changedExecutable,
      covered: changedCovered,
      pct: round2((changedCovered / changedExecutable) * 100),
    });
    totalExecutable += changedExecutable;
    totalCovered += changedCovered;
  }

  const total = totalExecutable === 0 ? null : round2((totalCovered / totalExecutable) * 100);
  return { total, files };
}

/* istanbul line coverage: map each statement to its START line and take the MAX
 * hit count of statements starting on that line (istanbul-lib-coverage semantics).
 * A line is executable if a statement starts on it, covered if that line's max hit
 * count is > 0. Using start lines — not the full [start,end] span — is what makes
 * this correct: expanding the span would (a) mark continuation lines executable and
 * (b) let a covered outer statement mask an uncovered nested statement sharing a
 * line (e.g. a hit 1-3 statement hiding an unhit line-2 statement). */
function lineCoverage(entry) {
  const lineHits = new Map();
  for (const [id, loc] of Object.entries(entry.statementMap)) {
    const line = loc.start.line;
    const count = entry.s[id] ?? 0;
    const prev = lineHits.get(line);
    if (prev === undefined || prev < count) lineHits.set(line, count);
  }
  const executable = new Set(lineHits.keys());
  const covered = new Set();
  for (const [line, count] of lineHits) if (count > 0) covered.add(line);
  return { executable, covered };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ---- loadCoverage (freshness guard, C10) -----------------------------------
 * The runner runs vitest --coverage immediately before this tool, so a
 * recent-mtime backstop rejects a stale report from an earlier run. Missing or
 * stale → loud fail (never silently report against old data).
 */
export function loadCoverage(coveragePath, maxAgeMs = 600_000, now = Date.now()) {
  let stat;
  try {
    stat = fs.statSync(coveragePath);
  } catch {
    throw new Error(`coverage file not found: ${coveragePath} (run tests with --coverage first)`);
  }
  const ageMs = now - stat.mtimeMs;
  if (ageMs > maxAgeMs) {
    throw new Error(
      `coverage file is stale: ${coveragePath} is ${Math.round(ageMs / 1000)}s old ` +
        `(> ${Math.round(maxAgeMs / 1000)}s) — re-run tests with --coverage`,
    );
  }
  return JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
}

/* ---- confined atomic report write ------------------------------------------
 * Mirrors runner/src/report.ts: confine the directory lexically and by realpath,
 * then replace the leaf via temp+rename so a symlinked leaf is not followed.
 * (Kept local because report.ts exports only its fixed-shape writer; a future
 * unification is inbox territory, not a tool edit.)
 */
function writeConfinedJson(root, reportDir, filename, data) {
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(root, reportDir);
  assertWithinRoot(root, target, reportDir);
  assertWithinRoot(realRoot, realpathOfDeepestExisting(target), reportDir);
  fs.mkdirSync(target, { recursive: true });
  assertWithinRoot(realRoot, fs.realpathSync(target), reportDir);

  const filePath = path.join(target, filename);
  const tmp = path.join(target, `.diff-cover-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { flag: 'wx' });
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup; surface the original rename failure */
    }
    throw error;
  }
  return filePath;
}

function assertWithinRoot(root, child, reportDir) {
  const rel = path.relative(root, child);
  const contained = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!contained) {
    throw new Error(`report dir ${JSON.stringify(reportDir)} resolves outside the repo root`);
  }
}

function realpathOfDeepestExisting(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync(current);
}

/* ---- git + base-ref resolution (thin wrapper) ------------------------------ */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`failed to run git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

function gitOk(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return !result.error && result.status === 0;
}

/* Derive [remote, branch] so a deepen/unshallow targets the base ref's OWN
   remote, not a hard-coded one. `origin/main` → ['origin','main'];
   `refs/remotes/upstream/main` → ['upstream','main']; a bare ref → best-effort
   ['origin', ref]. */
export function remoteAndBranch(ref) {
  const normalized = ref.replace(/^refs\/remotes\//, '');
  const slash = normalized.indexOf('/');
  if (slash > 0) return [normalized.slice(0, slash), normalized.slice(slash + 1)];
  return ['origin', normalized];
}

/*
 * base-ref (C9/GC6): the base must both RESOLVE and share a merge-base with HEAD
 * — a shallow clone can hold the ref commit yet lack the common ancestry the
 * triple-dot diff needs. If either is missing, attempt ONE bounded deepen
 * (unshallow if shallow, else --deepen=50 of the ref's own remote/branch) and
 * retry. Still unusable → loud fail. The empty-range check is done by the caller.
 */
function resolveBase(root, baseRefArg) {
  const ref = baseRefArg ?? 'origin/main';
  const usable = (r) =>
    gitOk(['rev-parse', '--verify', '--quiet', `${r}^{commit}`], root) &&
    gitOk(['merge-base', r, 'HEAD'], root);
  if (usable(ref)) return ref;

  const shallow = git(['rev-parse', '--is-shallow-repository'], root) === 'true';
  const [remote, branch] = remoteAndBranch(ref);
  const fetchArgs = shallow
    ? ['fetch', '--unshallow', remote]
    : ['fetch', '--deepen=50', remote, branch];
  try {
    git(fetchArgs, root);
  } catch {
    /* deepen may fail offline; fall through to the loud failure below */
  }
  if (usable(ref)) return ref;
  throw new Error(
    `base ref is unresolvable or shares no history with HEAD: ${ref} ` +
      '(fetch it / deepen the clone, or pass --base-ref <ref>)',
  );
}

function parseCliArgs(argv) {
  const opts = {
    coverage: 'coverage/coverage-final.json',
    baseRef: undefined,
    threshold: 70,
    excludes: [],
    includes: [],
    reportDir: 'reports/quality',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--coverage': opts.coverage = need(); break;
      case '--base-ref': opts.baseRef = need(); break;
      case '--threshold': opts.threshold = parseThreshold(need()); break;
      case '--exclude': opts.excludes.push(need()); break;
      case '--include': opts.includes.push(need()); break;
      case '--report-dir': opts.reportDir = need(); break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/* A blank/whitespace `--threshold` must NOT silently become 0 (which disables the
   gate: 0% ≥ 0 always passes), since Number('') === 0. Reject non-numeric or
   out-of-range values before use. */
export function parseThreshold(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const n = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error('--threshold must be a number in the inclusive range [0, 100]');
  }
  return n;
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const root = git(['rev-parse', '--show-toplevel'], process.cwd());
  const coveragePath = path.resolve(process.cwd(), opts.coverage);

  const base = resolveBase(root, opts.baseRef);
  const coverage = loadCoverage(coveragePath); /* loud fail if missing/stale */
  const headSha = git(['rev-parse', 'HEAD'], root);

  const rangeEmpty = git(['rev-list', `${base}..HEAD`], root) === '';
  let result;
  if (rangeEmpty) {
    result = { total: null, files: [] };
  } else {
    /* core.quotePath=false keeps non-ASCII paths as raw UTF-8 instead of octal
       C-escapes that would never match the coverage keys. */
    const diffText = git(
      ['-c', 'core.quotePath=false', 'diff', '--unified=0', `${base}...HEAD`],
      root,
    );
    const changed = parseUnifiedDiff(diffText);
    const normalized = normalizeCoverageKeys(coverage, root);
    result = computeCoverage(changed, normalized, {
      excludes: opts.excludes,
      includes: opts.includes,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    headSha,
    base,
    threshold: opts.threshold,
    total: result.total,
    files: result.files,
  };
  writeConfinedJson(root, opts.reportDir, 'diff-coverage.json', JSON.stringify(report, null, 2) + '\n');

  if (result.total === null) {
    const reason = rangeEmpty ? 'no commits to measure' : 'no measurable source changes';
    console.log(`diff-coverage: N/A (${reason}) — threshold ${opts.threshold}`);
    process.exitCode = 0;
    return;
  }
  const totalChanged = result.files.reduce((n, f) => n + f.changedExecutable, 0);
  const totalCovered = result.files.reduce((n, f) => n + f.covered, 0);
  const pass = result.total >= opts.threshold;
  console.log(
    `diff-coverage: ${result.total}% (${totalCovered}/${totalChanged} changed lines) ` +
      `threshold ${opts.threshold} — ${pass ? 'PASS' : 'FAIL'}`,
  );
  process.exitCode = pass ? 0 : 1;
}

function isMain() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    main();
  } catch (error) {
    console.error(`diff-cover: ${error.message}`);
    process.exit(2);
  }
}
