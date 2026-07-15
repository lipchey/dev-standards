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
 * Every EXISTING dependency (ADR-017): a spec CHANGE to a non-registry SOURCE
 * (git / URL / tarball / npm: alias / local path) is a source SWAP and is
 * flagged; a registry version/range/tag change stays allowed (the D3 contract).
 * `isSourceSpec` is a vendored, fail-closed port of npm-package-arg's registry-
 * vs-source partition (no runtime dep — this tool imports only node: builtins).
 * A lock-only swap (manifest unchanged, only the lockfile edited) is caught by
 * three lock signals — a source root spec, a non-https `resolved`, and a
 * `resolved` registry-identity (host + package path) that drifts from the base
 * lock — because npm ci installs the lock's `resolved` verbatim. Residual
 * ceilings: a `link:true` (local/workspace) swap and a FIRST-time tarball with no
 * base entry to diff against are not caught.
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

/* Source-swap classifier (ADR-017): true ⇒ the spec resolves to a non-registry
   SOURCE (git / remote tarball / bare archive / npm: alias / file / local path),
   i.e. a supply-chain swap; false ⇒ a registry version/range/tag. A faithful,
   fail-closed port of npm-package-arg's registry-vs-source partition WITHOUT the
   dependency (this tool imports only node: builtins and runs from vendor/ in every
   consumer). `:`/`/` alone is NOT enough — npm-package-arg@14 also classifies bare
   archive filenames (`pkg.tgz`, `foo.tar`, `foo.tar.gz`; but NOT `.zip`/`.bz2`)
   and leading-dot / backslash paths (`.`, `..`, `.vendor`, `.\pkg`) as source with
   no such marker, so those are handled explicitly. Verified vs npm-package-arg@14
   over 84 specs: zero false negatives on {git,remote,file,directory}, zero
   non-alias false positives on {version,range,tag}. An `npm:other@1` alias
   (npm-package-arg `registry:true`) is DELIBERATELY treated as source — you declare
   `a` and silently install `other`. Unlike isAllowedSpec, this does NOT special-case
   FILE_SPEC: `file:vendor/dev-standards` is a source here, so a registry→vendor-path
   *change* is flagged; a pre-existing, unchanged vendored dep produces no delta and
   is never reached. */
export function isSourceSpec(spec) {
  if (typeof spec !== 'string') return true;
  if (spec === '') return false; /* npm reads "" as "*" (a registry range) */
  if (spec.startsWith('.')) return true; /* . .. .vendor ./x ..\y — npa: directory */
  if (spec.includes('\\')) return true; /* windows path */
  if (spec.includes(':') || spec.includes('/')) return true; /* proto / scp / shorthand / path / alias */
  const low = spec.toLowerCase();
  return low.endsWith('.tgz') || low.endsWith('.tar') || low.endsWith('.tar.gz');
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

/* Effective spec per dep name across the 3 checked sections, by npm precedence
   (optionalDependencies overrides dependencies overrides devDependencies — npm
   permits a name in more than one, so a first-match union would compare a swap
   against the wrong section's spec). Iterated low→high precedence so the winner
   overwrites. (ADR-017) */
function effectiveSpecs(manifest) {
  const map = new Map();
  for (const sec of ['devDependencies', 'dependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(section(manifest, sec))) map.set(name, spec);
  }
  return map;
}

/* Lock `packages[""]` root section map (validated shape), or {}. */
function lockRoot(lockfile) {
  const packages = lockfile?.packages;
  const root = packages !== null && typeof packages === 'object' && !Array.isArray(packages) ? packages[''] : undefined;
  return root !== null && typeof root === 'object' && !Array.isArray(root) ? root : {};
}

/* The lock's declared root spec for a name, by npm precedence. Object.hasOwn so a
   dep literally named `constructor`/`toString` isn't proven by the prototype
   chain. Returns the spec (any type — caller string-guards) or undefined. */
function lockRootSpec(lockfile, name) {
  const root = lockRoot(lockfile);
  for (const sec of ['optionalDependencies', 'dependencies', 'devDependencies']) {
    const map = root[sec];
    if (map !== null && typeof map === 'object' && Object.hasOwn(map, name)) return map[name];
  }
  return undefined;
}

/* A name's node_modules descriptor, distinguishing ABSENT (no key) from
   PRESENT-but-invalid (key with a null/scalar/array value — hand-edited junk,
   N1 gate-C). Object.hasOwn so a name like `constructor` isn't matched on the
   prototype. `entry` is set only when valid. */
function lockEntry(lockfile, name) {
  const packages = lockfile?.packages;
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    return { present: false, valid: false, entry: undefined };
  }
  const key = `node_modules/${name}`;
  if (!Object.hasOwn(packages, key)) return { present: false, valid: false, entry: undefined };
  const entry = packages[key];
  const valid = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
  return { present: true, valid, entry: valid ? entry : undefined };
}

/* The `resolved` install location of a name (base-lock read for signal 3), or
   undefined for an absent/malformed descriptor. */
function lockResolved(lockfile, name) {
  const { valid, entry } = lockEntry(lockfile, name);
  return valid ? entry.resolved : undefined;
}

/* Version-independent FINGERPRINT of a `resolved` URL for dep `name`, or null if
   absent / unparseable. Two `resolved`s with the same fingerprint are the same
   package at (possibly) different versions; a different fingerprint is a package /
   host / query pivot. Layouts:
   - npm registry (`…/<pkg>/-/<pkg>-<v>.tgz`): everything before `/-/` — excludes
     the versioned filename entirely, so no version heuristic is needed and a
     digit-bearing name (`base64` vs `base32`) is NOT confused (Gate C R2).
   - flat CDN / query registry (no `/-/`): anchor on the dep's OWN name — strip a
     `<unscoped>-<version>.<ext>` tail so `…/a-1.0.0.tgz`→`…/a-1.0.1.tgz` matches
     (Gate C R2 #3), but a filename NOT starting with the dep name keeps the full
     path so a pivot to a different package differs (fail-closed).
   `url.search` is included so a query-addressed swap (`?pkg=a`→`?pkg=evil`,
   Gate C R2 #1) differs. A git+ssh/bare shorthand won't parse (→ null); the
   non-https signal catches those, fingerprint-drift is for URL↔URL swaps. */
function resolvedFingerprint(resolved, name) {
  if (typeof resolved !== 'string') return null;
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return null;
  }
  const path = url.pathname;
  const marker = path.indexOf('/-/');
  if (marker !== -1) return `${url.host}${path.slice(0, marker)}${url.search}`;
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const unscoped = String(name).slice(String(name).lastIndexOf('/') + 1).toLowerCase();
  const anchored = unscoped && base.toLowerCase().startsWith(`${unscoped}-`) ? `${dir}${unscoped}` : path;
  return `${url.host}${anchored}${url.search}`;
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

/* Pure decision core — no git, no I/O. All manifest/lockfile inputs nullable.
   `stagedManifest` null means the manifest is unstaged/absent — new-dep grammar
   and D8 don't run, but a staged lockfile is still shape-validated up front AND
   a lock-only commit still inspects EXISTING deps for a source swap (ADR-017).
   Throws OperationalError on a malformed staged lockfile or non-object staged
   manifest; otherwise returns findings. */
/**
 * @param {{ baseManifest?: unknown, stagedManifest?: unknown,
 *   stagedLockfile?: unknown, baseLockfile?: unknown, lockfileStaged?: boolean,
 *   exactOnly?: boolean }} [input]
 * @returns {string[]}
 */
export function evaluate({
  baseManifest = null,
  stagedManifest = null,
  stagedLockfile = null,
  baseLockfile = null,
  lockfileStaged = false,
  exactOnly = false,
} = {}) {
  const findings = [];
  if (lockfileStaged) assertLockfileShape(stagedLockfile);

  const manifestPresent = stagedManifest !== null && stagedManifest !== undefined;
  /* D5 symmetry: a valid-JSON-but-non-object staged manifest (`[]`, `"x"`, `42`)
     is malformed. Without this it slips past — `section()` coerces a non-object to
     `{}`, zero new deps are found, the tool prints "ok" — contradicting the
     "non-object manifest is operational" contract. */
  if (manifestPresent && (typeof stagedManifest !== 'object' || Array.isArray(stagedManifest))) {
    throw new OperationalError('staged package.json is not a JSON object');
  }
  if (!manifestPresent && !lockfileStaged) return findings;

  const base = baseManifest ?? {};
  const baseNames = baseNameSet(base);

  const newDeps = [];
  if (manifestPresent) {
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
  }

  if (lockfileStaged && manifestPresent) {
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

  /* Source-swap on an EXISTING dep (ADR-017). Manifest-side classification is the
     primary signal; on a lock-only commit (manifest unchanged) the base manifest
     supplies the existing deps and the three lockfile signals stand in. Each dep
     yields at most one finding — the `continue`s dedupe manifest- vs lock-side. */
  const currentManifest = manifestPresent ? stagedManifest : base;
  const currentEff = effectiveSpecs(currentManifest);
  const baseEff = effectiveSpecs(base);
  for (const [name, spec] of currentEff) {
    if (!baseNames.has(name)) continue; /* new deps handled above */
    /* Manifest-side: an existing dep whose effective spec CHANGED to a source. */
    if (manifestPresent && isSourceSpec(spec) && baseEff.get(name) !== spec) {
      findings.push(
        `existing dependency "${name}" changed to a non-registry source spec ${JSON.stringify(spec)} — ` +
          'a source swap (git/URL/tarball/npm: alias/local path); only registry version/range/tag changes are allowed',
      );
      continue;
    }
    /* A source spec that is unchanged (or pre-existing on a lock-only commit) is
       not a swap introduced here, and its lock entry legitimately points at that
       source — so the lock signals below don't apply. */
    if (isSourceSpec(spec)) continue;
    if (!lockfileStaged) continue; /* lock signals need the staged lock */

    /* Signal 1: the lock DECLARES a source for a dep the manifest says is registry
       (an internally-consistent source-swapped lock). */
    const lockSpec = lockRootSpec(stagedLockfile, name);
    if (typeof lockSpec === 'string' && isSourceSpec(lockSpec)) {
      findings.push(
        `existing dependency "${name}" is pinned to a non-registry source ${JSON.stringify(lockSpec)} in the ` +
          'staged package-lock.json while its manifest spec is a registry range — possible lockfile source swap',
      );
      continue;
    }

    /* The node_modules descriptor must be an actual object (N1 gate-C: a
       presence-only proof accepts null/scalar/array junk). A PRESENT-but-invalid
       entry for an existing dep is a hand-edited/malformed lock — flag it; the
       D3-valid empty `{}` descriptor stays valid and falls through to the signals. */
    const { present, valid, entry } = lockEntry(stagedLockfile, name);
    if (present && !valid) {
      findings.push(
        `existing dependency "${name}" has a malformed lock entry (node_modules/${name} is not an object) ` +
          'in the staged package-lock.json',
      );
      continue;
    }
    /* A `link:true` descriptor to a genuine LOCAL source dir (npm workspace
       package, vendored dep) is not a remote swap — exempt it from the URL signals
       (else a workspace repo false-fails). But exempt ONLY a real local path: a
       link `resolved` that is a URL, or that indirects INTO `node_modules/` (a
       crafted link → a remotely-resolved target descriptor, Gate C R2 #2), is NOT
       exempt and falls through to the signals below. */
    const resolved = valid ? entry.resolved : undefined;
    const linkPath = valid && entry.link === true && typeof resolved === 'string' ? resolved.replace(/\\/g, '/') : null;
    const exemptLink =
      valid &&
      entry.link === true &&
      resolvedFingerprint(resolved, name) === null &&
      (linkPath === null || !linkPath.split('/').includes('node_modules'));

    /* Signal 2: the resolution installs from a non-registry location. A registry
       install is always an http(s) tarball URL; a git scheme, hosted shorthand,
       bare `user/repo`, `file:`, or a non-exempt link path in `resolved` is not
       (Gate P P1 #3). */
    if (!exemptLink && typeof resolved === 'string' && !/^https?:/i.test(resolved)) {
      findings.push(
        `existing dependency "${name}" resolves to a non-registry source ${JSON.stringify(resolved)} in the ` +
          'staged package-lock.json — expected an https registry URL; possible lockfile source swap',
      );
      continue;
    }

    /* Signal 3: the resolution FINGERPRINT (host + package, version-independent)
       changed while the manifest spec did not — the signal that catches an
       https↔https swap npm ci installs verbatim, including a same-host pivot to a
       DIFFERENT package (`…/a/-/a-1.2.3.tgz` → `…/evil/-/evil-9.tgz`) or a
       query-addressed pivot (Gate C P1/R2). A version-only change keeps the
       fingerprint. Needs a base resolved to diff against. */
    if (!exemptLink) {
      const stagedFp = resolvedFingerprint(resolved, name);
      const baseFp = resolvedFingerprint(lockResolved(baseLockfile, name), name);
      if (baseFp !== null && stagedFp !== null && baseFp !== stagedFp) {
        findings.push(
          `existing dependency "${name}" changed its resolved package in the staged package-lock.json ` +
            `(${baseFp} → ${stagedFp}) with no manifest change — possible lockfile source swap`,
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

    /* Base manifest is read on a lock-ONLY commit too (not just a manifest
       change): the existing-dep source-swap inspection enumerates existing deps
       from the base when the manifest itself is unchanged (ADR-017). */
    let baseManifest = null;
    if (
      (manifestStagedChange || lockfileStaged) &&
      hasHead &&
      /* ls-tree lists nothing (exit 0) when the path is absent — absence is not
         a git failure, a distinction the base read depends on. */
      git(['ls-tree', 'HEAD', '--', 'package.json'], root).trim() !== ''
    ) {
      baseManifest = parseJson(git(['show', 'HEAD:package.json'], root), 'base package.json');
    }

    /* Base lockfile powers signal 3 (resolved identity-drift). A git READ failure
       stays operational (the git() call throws → exit 2); only a malformed/legacy
       HEAD lock is tolerated — its JSON.parse alone is caught, leaving signal 3
       without a baseline (the staged lock's own shape is still validated in
       evaluate()). Narrow catch, not a broad one, so a read failure can't silently
       fail the identity signal open. */
    let baseLockfile = null;
    if (lockfileStaged && hasHead && git(['ls-tree', 'HEAD', '--', 'package-lock.json'], root).trim() !== '') {
      const baseLockText = git(['show', 'HEAD:package-lock.json'], root);
      try {
        baseLockfile = JSON.parse(baseLockText);
      } catch {
        baseLockfile = null;
      }
    }

    const findings = evaluate({ baseManifest, stagedManifest, stagedLockfile, baseLockfile, lockfileStaged, exactOnly });
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
