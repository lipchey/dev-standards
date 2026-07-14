#!/usr/bin/env node
/*
 * check-new-deps: supply-chain / slopsquatting gate for newly-added npm deps.
 *
 * Every NEW dependency (a name absent from the base manifest's
 * dependencies/devDependencies/optionalDependencies union) must (a) carry a
 * spec from a positive allow-list grammar and (b) be pinned by TWO bound
 * entries in the staged lockfile — a direct `packages[""][<section>][name]`
 * whose spec matches, AND a `packages["node_modules/<name>"]` resolution
 * entry. Name-in-any-section alone would accept a stale/wrong-section lockfile;
 * the resolution entry alone is the transitive false-pass the spec bans. This
 * makes a hallucinated/typosquatted package impossible to introduce without a
 * lockfile that actually resolved it.
 *
 * DATA SOURCE INVARIANT: only the git index (`git show :path`) and HEAD
 * (`git show HEAD:path`) are read, via fixed argv + shell:false — NEVER the
 * working tree. A dep must be *committed* to be proven; a working-tree-only
 * edit is invisible here by design.
 *
 * Exit contract: 0 = ok / nothing to check; 1 = findings (one
 * `check-new-deps: <message>` line each on stdout); 2 = operational failure
 * (git error incl. not-a-repo, unparseable or non-object manifest/lockfile
 * JSON, lockfileVersion !== 3, malformed `packages`) — message on stderr, blocks in
 * ANY mode, never a silent pass. Not `bypassable`: a process-global bypass
 * reason must not silence a supply-chain finding.
 *
 * v1 scope (npm only): root package.json <-> root package-lock.json,
 * lockfileVersion 3. Out of scope, by design: workspace sub-manifests,
 * pnpm/yarn (detected and stood down, not mis-flagged — see D10), `overrides`
 * / `bundleDependencies`, and any registry/network heuristic. Known ceiling:
 * an npm repo carrying a stray legacy yarn.lock trips the pnpm/yarn predicate
 * and silences this gate.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export class OperationalError extends Error {}

const FILE_SPEC = 'file:vendor/dev-standards';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/* Grammar (D9): a numeric identifier is `0` or a leading-zero-free run; a full
   triple carries optional semver prerelease/build. Exact = X.Y.Z(+pre)(+build).
   Caret/tilde = ^|~ followed by X, X.Y, or the full triple. Anchored with no
   whitespace class, so leading/trailing space or a trailing newline never
   matches (JS `$` without the `m` flag is end-of-input only, not before \n). */
const NUM = '(?:0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[a-z-][0-9a-z-]*)';
const PRERELEASE = `(?:-${PRE_ID}(?:\\.${PRE_ID})*)`;
const BUILD = '(?:\\+[0-9a-z-]+(?:\\.[0-9a-z-]+)*)';
const TRIPLE = `${NUM}\\.${NUM}\\.${NUM}${PRERELEASE}?${BUILD}?`;
const EXACT_RE = new RegExp(`^${TRIPLE}$`, 'i');
const RANGE_RE = new RegExp(`^[\\^~](?:0|[1-9]\\d*|${NUM}\\.${NUM}|${TRIPLE})$`, 'i');

export function isAllowedSpec(spec, { exactOnly = false } = {}) {
  if (typeof spec !== 'string') return false;
  if (spec === FILE_SPEC) return true;
  if (EXACT_RE.test(spec)) return true;
  if (!exactOnly && RANGE_RE.test(spec)) return true;
  return false;
}

/* A manifest section as a plain object; a missing or non-object section (e.g.
   `"dependencies": null`) reads as empty rather than throwing — malformed dep
   *values* become grammar findings, not operational faults. */
function section(manifest, name) {
  const s = manifest?.[name];
  return s !== null && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/* D7: the set of names installable from the base manifest — the 3 real
   sections' union. A base `peerDependencies`-only name is NOT in here, so
   moving it into a real section counts as NEW (it becomes installable and was
   never lockfile-proven). */
function baseNameSet(base) {
  const names = new Set();
  for (const sec of SECTIONS) for (const name of Object.keys(section(base, sec))) names.add(name);
  return names;
}

/* D8: any add / remove / spec-change across the 3 checked sections. Metadata
   edits (scripts/engines/name/version) and peerDependencies-only edits are not
   deltas — they need no lockfile change. */
function hasDepBearingDelta(base, staged) {
  for (const sec of SECTIONS) {
    const b = section(base, sec);
    const s = section(staged, sec);
    for (const name of new Set([...Object.keys(b), ...Object.keys(s)])) {
      const inB = Object.hasOwn(b, name);
      const inS = Object.hasOwn(s, name);
      if (inB !== inS) return true;
      if (inB && inS && b[name] !== s[name]) return true;
    }
  }
  return false;
}

/* D5: a staged lockfile is shape-validated before ANY dep iteration, so a
   corrupt/v2 lockfile on a removal- or metadata-commit (zero new deps) still
   fails loud rather than passing silently. */
function assertLockfileShape(lockfile) {
  if (lockfile === null || typeof lockfile !== 'object' || Array.isArray(lockfile)) {
    throw new OperationalError('staged package-lock.json is not a JSON object');
  }
  if (lockfile.lockfileVersion !== 3) {
    throw new OperationalError(
      `unsupported lockfileVersion ${JSON.stringify(lockfile.lockfileVersion)} in staged ` +
        'package-lock.json — this check requires lockfileVersion 3',
    );
  }
  if (lockfile.packages === null || typeof lockfile.packages !== 'object' || Array.isArray(lockfile.packages)) {
    throw new OperationalError('staged package-lock.json has no "packages" object');
  }
}

/* Pure decision core — no git, no I/O. `baseManifest`/`stagedLockfile` nullable;
   `stagedManifest` null means the manifest was deleted/absent (nothing to
   analyse, but a staged lockfile is still validated up-front). Throws
   OperationalError on a malformed staged lockfile; otherwise returns findings. */
/**
 * @param {{ baseManifest?: unknown, stagedManifest?: unknown,
 *   stagedLockfile?: unknown, lockfileStaged?: boolean,
 *   exactOnly?: boolean }} [input]
 * @returns {string[]}
 */
export function evaluate({
  baseManifest = null,
  stagedManifest = null,
  stagedLockfile = null,
  lockfileStaged = false,
  exactOnly = false,
} = {}) {
  const findings = [];
  if (lockfileStaged) assertLockfileShape(stagedLockfile);
  if (stagedManifest === null || stagedManifest === undefined) return findings;
  /* D5 symmetry: a valid-JSON-but-non-object manifest (`[]`, `"x"`, `42`) is
     malformed. Without this it slips past — `section()` coerces a non-object to
     `{}`, so zero new deps are found and the tool prints "ok", contradicting the
     stated "unparseable/non-object manifest is operational" contract. */
  if (typeof stagedManifest !== 'object' || Array.isArray(stagedManifest)) {
    throw new OperationalError('staged package.json is not a JSON object');
  }

  const base = baseManifest ?? {};
  const baseNames = baseNameSet(base);

  const newDeps = [];
  for (const sec of SECTIONS) {
    for (const [name, spec] of Object.entries(section(stagedManifest, sec))) {
      if (baseNames.has(name)) continue;
      newDeps.push({ name, section: sec, spec });
      if (!isAllowedSpec(spec, { exactOnly })) {
        findings.push(
          `new dependency "${name}" (${sec}) has a disallowed version spec ${JSON.stringify(spec)} — ` +
            `allowed: exact X.Y.Z, ^/~ ranges over X[.Y[.Z]], or ${FILE_SPEC}`,
        );
      }
    }
  }

  if (hasDepBearingDelta(base, stagedManifest) && !lockfileStaged) {
    findings.push(
      'dependency change staged without a staged package-lock.json — stage the updated ' +
        'lockfile so added/changed deps are pinned',
    );
  }

  if (lockfileStaged) {
    const packages = stagedLockfile.packages;
    const root =
      packages[''] !== null && typeof packages[''] === 'object' && !Array.isArray(packages[''])
        ? packages['']
        : {};
    for (const dep of newDeps) {
      const sectionMap =
        root[dep.section] !== null && typeof root[dep.section] === 'object'
          ? root[dep.section]
          : {};
      /* Object.hasOwn, never `in`/member access: a dep literally named
         `constructor` or `toString` must not be proven by the prototype chain. */
      const directOk = Object.hasOwn(sectionMap, dep.name) && sectionMap[dep.name] === dep.spec;
      /* The resolution entry must be an actual descriptor object: `Object.hasOwn`
         alone is true for a null/scalar/array value, which would false-pass a
         lockfile that lists the key but never resolved the package. */
      const resolutionKey = `node_modules/${dep.name}`;
      const resolutionEntry = Object.hasOwn(packages, resolutionKey) ? packages[resolutionKey] : undefined;
      const resolutionOk =
        resolutionEntry !== null && typeof resolutionEntry === 'object' && !Array.isArray(resolutionEntry);
      if (!directOk) {
        findings.push(
          `new dependency "${dep.name}" (${dep.section}) is not pinned in the staged ` +
            `package-lock.json (missing/mismatched packages[""].${dep.section} entry for ` +
            `${JSON.stringify(dep.spec)})`,
        );
      } else if (!resolutionOk) {
        findings.push(
          `new dependency "${dep.name}" has no resolution entry (node_modules/${dep.name}) ` +
            'in the staged package-lock.json',
        );
      }
    }
  }

  return findings;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new OperationalError(`failed to run git ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new OperationalError(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr ?? '').trim()}`);
  }
  return r.stdout ?? '';
}

/* Status-only probe: a plain non-zero exit is a valid answer (used where that
   means something, e.g. unborn HEAD), so it is returned, not thrown; only a spawn
   failure or a killed child is operational. */
function gitStatus(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new OperationalError(`failed to run git ${args.join(' ')}: ${r.error.message}`);
  /* A signalled child (status null, signal set) is a killed git, not the valid
     nonzero "unborn HEAD" answer — mapping it to 1 would misread as unborn and
     false-pass every dep as new. */
  if (r.signal) throw new OperationalError(`git ${args.join(' ')} killed by signal ${r.signal}`);
  return r.status ?? 1;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OperationalError(`unparseable ${label} JSON: ${error.message}`);
  }
}

/* Parse `git diff --cached --name-status -z -M`: NUL-separated tokens where a
   single-letter status is followed by one path, and an R/C record by two (old,
   new). package.json / package-lock.json count for their TARGET path; a
   rename-away leaves them only as an old path, i.e. NOT staged as a change. */
function parseNameStatus(out) {
  const tokens = out.split('\0');
  const targets = new Set();
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) {
      i += 1;
      continue;
    }
    const code = status[0];
    if (code === 'R' || code === 'C') {
      targets.add(tokens[i + 2]);
      i += 3;
    } else {
      if (code !== 'D') targets.add(tokens[i + 1]);
      i += 2;
    }
  }
  return {
    manifestStagedChange: targets.has('package.json'),
    lockfileStaged: targets.has('package-lock.json'),
  };
}

function parseArgs(argv) {
  let exactOnly = false;
  for (const arg of argv) {
    if (arg === '--exact-only') exactOnly = true;
    else throw new OperationalError(`unrecognized argument: ${arg}`);
  }
  return { exactOnly };
}

export function main(argv) {
  try {
    const { exactOnly } = parseArgs(argv);

    /* Resolve the repo top-level ONCE and run EVERY git call from it: ls-tree /
       ls-files pathspecs are cwd-relative while `:path` is root-relative, so from
       a subdir the base read and the pnpm/yarn probe would silently see nothing
       and every dep would look new. This rev-parse also IS the not-a-repo probe —
       it fails (exit 2) outside a work tree, so no separate --is-inside-work-tree
       check is needed. */
    /* Strip only git's trailing newline, not path whitespace: a repo root may
       legally end in a space, and .trim() would then resolve to a sibling dir. */
    const root = git(['rev-parse', '--show-toplevel'], process.cwd()).replace(/\n$/, '');
    /* Unborn HEAD is NOT an error — it only means the base read is skipped
       (base = {}). `git diff --cached` handles the empty tree natively. */
    const hasHead = gitStatus(['rev-parse', '--verify', '--quiet', 'HEAD'], root) === 0;

    /* D10: a tracked pnpm/yarn lockfile means this is not an npm repo → stand
       down (else every dep change false-fails on a missing package-lock.json). */
    if (git(['ls-files', '-z', '--', 'pnpm-lock.yaml', 'yarn.lock'], root).length > 0) {
      process.stdout.write('check-new-deps: npm-only check inactive (pnpm/yarn lockfile tracked)\n');
      return 0;
    }

    const { manifestStagedChange, lockfileStaged } = parseNameStatus(
      git(['diff', '--cached', '--name-status', '-z', '-M'], root),
    );
    if (!manifestStagedChange && !lockfileStaged) return 0;

    const stagedLockfile = lockfileStaged
      ? parseJson(git(['show', ':package-lock.json'], root), 'staged package-lock.json')
      : null;
    const stagedManifest = manifestStagedChange
      ? parseJson(git(['show', ':package.json'], root), 'staged package.json')
      : null;

    let baseManifest = null;
    if (
      manifestStagedChange &&
      hasHead &&
      /* ls-tree lists nothing (exit 0) when the path is absent — absence is not
         a git failure, a distinction the base read depends on. */
      git(['ls-tree', 'HEAD', '--', 'package.json'], root).trim() !== ''
    ) {
      baseManifest = parseJson(git(['show', 'HEAD:package.json'], root), 'base package.json');
    }

    const findings = evaluate({ baseManifest, stagedManifest, stagedLockfile, lockfileStaged, exactOnly });
    if (findings.length === 0) {
      process.stdout.write('check-new-deps: ok\n');
      return 0;
    }
    for (const f of findings) process.stdout.write(`check-new-deps: ${f}\n`);
    return 1;
  } catch (error) {
    if (error instanceof OperationalError) {
      process.stderr.write(`check-new-deps: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`check-new-deps: unexpected error: ${error?.stack ?? error}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
