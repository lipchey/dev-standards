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
 * npm scope: root package.json <-> root package-lock.json, lockfileVersion 3.
 * Out of scope there, by design: workspace sub-manifests, `overrides` /
 * `bundleDependencies`, and any registry/network heuristic. Known ceiling: an
 * npm repo carrying a stray legacy yarn.lock stands the gate down.
 *
 * pnpm scope (ADR-027): EVERY staged package.json (root and workspace
 * sub-manifests) <-> the root pnpm-lock.yaml, lockfileVersion '9.0'.
 * Manifest side, per staged manifest: a NEW dep must carry an allowed spec and
 * be DECLARED by an importer entry under the same importer path + section with
 * the same `specifier`; an EXISTING dep whose spec changed to a non-registry
 * source, or from a registry range to `workspace:`/`catalog:`, is a swap.
 * Lock side, needing no manifest (so it holds on a lock-ONLY commit): every
 * importer entry must have RESOLVED to what its own specifier implies (a
 * `link:` for `workspace:`, a registry version otherwise) — specifier equality
 * alone is forgeable by pairing `specifier: 1.2.3` with `version: link:../evil`;
 * an entry added or re-specified while its package.json stayed put came from
 * editing the lockfile; a `packages:` key whose `resolution:` line moved is the
 * same name@version pointed somewhere else; and a `resolution:` carrying a
 * `tarball:` or any URL is a redirection, since v9 writes only `{integrity}`
 * for a registry dep.
 * Known pnpm ceilings: `overrides`, `patchedDependencies` and
 * `packageExtensions` are not inspected; a lock-only change to an already
 * source-declared spec's resolution is only caught by the drift signals above;
 * an unparsable HEAD lockfile costs those baselines (not the staged read);
 * importer paths are assumed relative to the git root (true whenever
 * pnpm-lock.yaml sits at the git root, the only layout this tool detects).
 * pnpm mode is only as strong as the consumer fileset that triggers it — see
 * docs/ADOPTION.md.
 *
 * yarn is detected and stood down, not mis-flagged (D10).
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

/* pnpm-only spec families that are NOT registry specs and NOT remote sources:
   `workspace:*|^|~|<range>` resolves to a package declared in
   pnpm-workspace.yaml, `catalog:` to a version pinned there. Both stay inside
   the repository — and the target package's own manifest is itself gated once
   the consumer fileset covers every staged package.json — so they are exempt
   from the version grammar and from the source-swap classifier. The exemption
   is BOUND, not free: the lock must show the resolution each family really
   produces — a `link:` for `workspace:`, a registry version for `catalog:` —
   so neither can launder a remote resolution. */
export function isPnpmInternalSpec(spec) {
  return typeof spec === 'string' && (spec.startsWith('workspace:') || spec.startsWith('catalog:'));
}

/* An importer `version` that actually came from a registry: pnpm writes the
   resolved semver, optionally followed by a parenthesised peer suffix
   (`1.2.3(react@19.2.8)`). Anything carrying a URL or a `link:`/`file:` marker —
   at the head OR inside the peer suffix — is a source resolution. Fail-closed:
   a non-string or anything not starting with a digit is not registry-shaped. */
export function isPnpmRegistryVersion(version) {
  if (typeof version !== 'string' || !/^\d/.test(version)) return false;
  return !version.includes('://') && !version.includes('link:') && !version.includes('file:');
}

/* The resolution pnpm writes for a `workspace:` spec — a relative path into the
   repository. A `link:` that is a URL is not a local link (fail-closed). */
export function isPnpmLinkVersion(version) {
  return typeof version === 'string' && version.startsWith('link:') && !version.includes('://');
}

/* The lock resolution required for `spec`: `workspace:` links, everything else
   (registry ranges, `catalog:`) resolves to a registry version. */
function pnpmVersionOk(spec, version) {
  return typeof spec === 'string' && spec.startsWith('workspace:')
    ? isPnpmLinkVersion(version)
    : isPnpmRegistryVersion(version);
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

/* ─────────────────────────────────────────────────────────────── pnpm ──── */

/* The ONLY lockfileVersion this parser claims to understand. A lock written by
   a future pnpm major must fail LOUD (exit 2) and be reviewed, never be parsed
   on the assumption the shape held — the npm path takes the same line on
   `lockfileVersion !== 3`. */
const PNPM_LOCKFILE_VERSIONS = new Set(['9.0']);

/* Split `key: value` where the key may be single- or double-quoted (pnpm quotes
   scoped names and specifiers that would otherwise be ambiguous YAML). Returns
   null when the line is not a mapping entry at all. Values keep their quotes —
   `unquoteScalar` strips them. */
function splitYamlEntry(trimmed) {
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    let i = 1;
    let key = '';
    while (i < trimmed.length) {
      if (trimmed[i] === quote) {
        /* YAML single-quote escaping: '' inside a single-quoted scalar is one '. */
        if (quote === "'" && trimmed[i + 1] === "'") {
          key += "'";
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      key += trimmed[i];
      i += 1;
    }
    if (trimmed[i] !== ':') return null;
    return { key, value: trimmed.slice(i + 1).trim() };
  }
  const colon = trimmed.indexOf(':');
  if (colon === -1) return null;
  return { key: trimmed.slice(0, colon), value: trimmed.slice(colon + 1).trim() };
}

function unquoteScalar(value) {
  const quote = value[0];
  if (value.length >= 2 && (quote === "'" || quote === '"') && value[value.length - 1] === quote) {
    const inner = value.slice(1, -1);
    return quote === "'" ? inner.replaceAll("''", "'") : inner;
  }
  return value;
}

/* Every YAML construct this parser refuses inside `importers:`. Skipping an
   unrecognised line is THE fail-open trap: a future format tweak would quietly
   empty the importer map and prove every dependency. Refusing means a format
   change breaks commits loudly, which is the correct failure for a gate. */
function assertPlainYamlLine(line, trimmed, lineNo) {
  if (/^ *\t/.test(line) || line.includes('\t')) {
    throw new OperationalError(`pnpm-lock.yaml line ${lineNo}: tab in the importers block`);
  }
  if (/^[#&*!|>-]|^<<:/.test(trimmed)) {
    throw new OperationalError(
      `pnpm-lock.yaml line ${lineNo}: unsupported YAML construct in the importers block ` +
        `(${JSON.stringify(trimmed.slice(0, 40))})`,
    );
  }
}

/**
 * Parse the parts of a pnpm-lock.yaml this gate proves things with:
 *   - `lockfileVersion`
 *   - the `importers:` block, strictly, as
 *     Map<importerDir, Map<section, Map<depName, {specifier, version}>>>
 *   - every `packages:` entry's `resolution:` line, for drift comparison, and
 *     separately those carrying a tarball or any URL —
 *     v9 writes only `{integrity: …}` for a registry dep, so such a line is the
 *     lock-side source-redirection signal (the importer entry can look clean
 *     while the source is redirected one block down).
 * Throws OperationalError on anything it cannot classify.
 *
 * @param {string} text
 * @returns {{ importers: Map<string, Map<string, Map<string, {specifier?: string, version?: string}>>>,
 *   sourceResolutions: Array<{ package: string, resolution: string }>,
 *   resolutions: Map<string, string> }}
 */
export function parsePnpmLock(text) {
  if (typeof text !== 'string') throw new OperationalError('staged pnpm-lock.yaml is not text');
  const lines = text.split('\n');
  const importers = new Map();
  const sourceResolutions = [];
  const resolutions = new Map();
  let lockfileVersion;
  let block = null;
  let importer = null;
  let sectionMap = null;
  let dep = null;
  let packageKey = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      const entry = splitYamlEntry(trimmed);
      if (entry === null) throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: unparsable top-level line`);
      block = entry.key;
      importer = null;
      sectionMap = null;
      dep = null;
      packageKey = null;
      if (entry.key === 'lockfileVersion') lockfileVersion = unquoteScalar(entry.value);
      continue;
    }

    if (block === 'packages') {
      /* Deliberately loose: this block is scanned, not modelled. Only the
         resolution signal is extracted; everything else is ignored. */
      if (indent === 2) {
        const entry = splitYamlEntry(trimmed);
        packageKey = entry === null ? null : entry.key;
      } else if (trimmed.startsWith('resolution:')) {
        if (packageKey !== null) resolutions.set(packageKey, trimmed);
        if (trimmed.includes('tarball:') || trimmed.includes('://')) {
          sourceResolutions.push({ package: packageKey ?? '(unknown)', resolution: trimmed });
        }
      }
      continue;
    }

    if (block !== 'importers') continue;

    assertPlainYamlLine(line, trimmed, i + 1);
    const entry = splitYamlEntry(trimmed);
    if (entry === null) {
      throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: unparsable line in the importers block`);
    }
    const { key, value } = entry;
    /* Same refusal, value side: an anchor/alias/tag/block-scalar/sequence as the
       VALUE of an otherwise ordinary mapping entry. Checked here rather than on
       the raw line so a legitimate `workspace:*` specifier is not mistaken for an
       alias. */
    if (/^[&*!|>[]/.test(value)) {
      throw new OperationalError(
        `pnpm-lock.yaml line ${i + 1}: unsupported YAML construct in the importers block ` +
          `(${JSON.stringify(trimmed.slice(0, 40))})`,
      );
    }

    if (indent === 2) {
      if (value !== '' && value !== '{}') {
        throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: unsupported inline importer value`);
      }
      if (importers.has(key)) throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: duplicate importer "${key}"`);
      importer = new Map();
      importers.set(key, importer);
      sectionMap = null;
      dep = null;
    } else if (indent === 4) {
      if (importer === null) throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: section outside an importer`);
      if (value !== '' && value !== '{}') {
        throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: unsupported inline section value`);
      }
      if (importer.has(key)) throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: duplicate section "${key}"`);
      sectionMap = new Map();
      importer.set(key, sectionMap);
      dep = null;
    } else if (indent === 6) {
      if (sectionMap === null) throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: dependency outside a section`);
      if (value !== '') throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: unsupported inline dependency value`);
      if (sectionMap.has(key)) throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: duplicate dependency "${key}"`);
      dep = {};
      sectionMap.set(key, dep);
    } else if (indent === 8) {
      if (dep === null) throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: field outside a dependency`);
      if (key === 'specifier' || key === 'version') dep[key] = unquoteScalar(value);
    } else {
      throw new OperationalError(`pnpm-lock.yaml line ${i + 1}: unexpected indentation ${indent} in the importers block`);
    }
  }

  if (!PNPM_LOCKFILE_VERSIONS.has(lockfileVersion)) {
    throw new OperationalError(
      `unsupported lockfileVersion ${JSON.stringify(lockfileVersion)} in staged pnpm-lock.yaml — ` +
        `this check requires one of ${[...PNPM_LOCKFILE_VERSIONS].join(', ')}`,
    );
  }
  return { importers, sourceResolutions, resolutions };
}

/* Lock-side proofs that need NO manifest — so they still hold on a lock-ONLY
   commit, where nothing else has anything to compare against. `stagedImporters`
   names the importers whose manifest is staged in this same commit; an importer
   outside that set had no manifest change, so any change to its declared
   specifiers came from the lockfile alone. */
function evaluatePnpmLock(stagedLock, baseLock, stagedImporters) {
  const findings = [];
  if (stagedLock === null || stagedLock === undefined) return findings;

  for (const hit of stagedLock.sourceResolutions) {
    findings.push(
      `staged pnpm-lock.yaml resolves "${hit.package}" from a non-registry source ` +
        `(${JSON.stringify(hit.resolution)}) — a registry package resolves to {integrity: …}`,
    );
  }

  /* A `packages:` key IS name@version, so an identical key whose resolution line
     changed is the same package pointed somewhere else — never legitimate. */
  for (const [key, resolution] of stagedLock.resolutions) {
    const before = baseLock?.resolutions.get(key);
    if (before !== undefined && before !== resolution) {
      findings.push(
        `staged pnpm-lock.yaml changed the resolution of "${key}" (${JSON.stringify(before)} → ` +
          `${JSON.stringify(resolution)}) — the same package version cannot resolve two ways`,
      );
    }
  }

  for (const [importerPath, sections] of stagedLock.importers) {
    for (const [sec, deps] of sections) {
      for (const [name, entry] of deps) {
        /* A specifier that is itself a declared source resolves to that source
           by definition; whether declaring it was legitimate is the manifest-side
           question (ADR-017), and a lock-only change to it is caught just below.
           `workspace:`/`catalog:` look source-like to `isSourceSpec` (they carry a
           colon) but are NOT declared sources — they have an exact required
           resolution, so they must stay inside the check. */
        const declaredSource = isSourceSpec(entry.specifier) && !isPnpmInternalSpec(entry.specifier);
        if (!declaredSource && !pnpmVersionOk(entry.specifier, entry.version)) {
          findings.push(
            `staged pnpm-lock.yaml importers["${importerPath}"].${sec}."${name}" ` +
              `(${JSON.stringify(entry.specifier)}) resolves to ${JSON.stringify(entry.version)} — ` +
              'not the resolution its spec implies; possible lockfile source swap',
          );
          continue;
        }
        if (baseLock === null || baseLock === undefined || stagedImporters.has(importerPath)) continue;
        /* pnpm never rewrites an importer's specifier without a manifest edit, so
           a specifier that appeared or changed while its manifest stayed put is a
           dependency introduced by editing the lockfile. */
        const before = baseLock.importers.get(importerPath)?.get(sec)?.get(name);
        if (before === undefined) {
          findings.push(
            `staged pnpm-lock.yaml adds "${name}" to importers["${importerPath}"].${sec} ` +
              `(${JSON.stringify(entry.specifier)}) with no change to its package.json`,
          );
        } else if (before.specifier !== entry.specifier) {
          findings.push(
            `staged pnpm-lock.yaml changed the declared spec of "${name}" in importers["${importerPath}"].${sec} ` +
              `(${JSON.stringify(before.specifier)} → ${JSON.stringify(entry.specifier)}) with no change to its package.json`,
          );
        }
      }
    }
  }
  return findings;
}

/**
 * Pure decision core for pnpm — no git, no I/O.
 *
 * @param {{ manifests?: Array<{ path: string, importer: string, base?: unknown, staged?: unknown }>,
 *   stagedLock?: ReturnType<typeof parsePnpmLock> | null,
 *   baseLock?: ReturnType<typeof parsePnpmLock> | null,
 *   lockfileStaged?: boolean, exactOnly?: boolean }} [input]
 * @returns {string[]}
 */
export function evaluatePnpm({
  manifests = [],
  stagedLock = null,
  baseLock = null,
  lockfileStaged = false,
  exactOnly = false,
} = {}) {
  const stagedManifests = manifests.filter((m) => m.staged !== null && m.staged !== undefined);
  const findings = lockfileStaged
    ? evaluatePnpmLock(stagedLock, baseLock, new Set(stagedManifests.map((m) => m.importer)))
    : [];

  for (const manifest of stagedManifests) {
    const { path, importer: importerPath } = manifest;
    if (typeof manifest.staged !== 'object' || Array.isArray(manifest.staged)) {
      throw new OperationalError(`staged ${path} is not a JSON object`);
    }
    const current = manifest.staged;
    const base = manifest.base ?? {};
    const baseNames = baseNameSet(base);
    const importer = stagedLock?.importers.get(importerPath);

    for (const sec of SECTIONS) {
      for (const [name, spec] of Object.entries(section(current, sec))) {
        if (baseNames.has(name)) continue;
        if (!isPnpmInternalSpec(spec) && !isAllowedSpec(spec, { exactOnly })) {
          findings.push(
            `${path}: new dependency "${name}" (${sec}) has a disallowed version spec ${JSON.stringify(spec)} — ` +
              `allowed: exact X.Y.Z, ^/~ ranges over X[.Y[.Z]], workspace:/catalog:, or ${FILE_SPEC}`,
          );
        }
        /* The lock must DECLARE this exact spec under this exact importer and
           section. That the declaration also RESOLVED to the right kind of source
           is proven lock-side above, for every entry, not just the new ones. */
        if (!lockfileStaged) continue;
        const entry = importer?.get(sec)?.get(name);
        if (entry === undefined || entry.specifier !== spec) {
          findings.push(
            `${path}: new dependency "${name}" (${sec}) is not pinned in the staged pnpm-lock.yaml ` +
              `(missing/mismatched importers["${importerPath}"].${sec} entry for ${JSON.stringify(spec)})`,
          );
        }
      }
    }

    if (hasDepBearingDelta(base, current) && !lockfileStaged) {
      findings.push(
        `${path}: dependency change staged without a staged pnpm-lock.yaml — stage the updated ` +
          'lockfile so added/changed deps are pinned',
      );
    }

    /* Existing deps, manifest side (ADR-017): a spec that CHANGED to a
       non-registry source is a swap. `workspace:`/`catalog:` are internal rather
       than remote, but moving a dep registry → internal still replaces published
       code with repo-local code, so the TRANSITION is reported even though the
       resulting spec is exempt from the grammar. */
    const currentEff = effectiveSpecs(current);
    const baseEff = effectiveSpecs(base);
    for (const [name, spec] of currentEff) {
      if (!baseNames.has(name)) continue;
      const before = baseEff.get(name);
      if (before === spec) continue;
      if (isPnpmInternalSpec(spec)) {
        if (!isPnpmInternalSpec(before)) {
          findings.push(
            `${path}: existing dependency "${name}" changed from ${JSON.stringify(before)} to the workspace-internal ` +
              `spec ${JSON.stringify(spec)} — published code replaced by repo-local code; review the linked package`,
          );
        }
      } else if (isSourceSpec(spec)) {
        findings.push(
          `${path}: existing dependency "${name}" changed to a non-registry source spec ${JSON.stringify(spec)} — ` +
            'a source swap (git/URL/tarball/npm: alias/local path); only registry version/range/tag changes are allowed',
        );
      }
    }
  }

  return findings;
}

/* ────────────────────────────────────────────────────────────────────────── */

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
  return targets;
}

/* Staged manifests for the pnpm path, from the INDEX only (never a
   pnpm-workspace.yaml glob expansion, which would need the working tree and
   break the DATA SOURCE INVARIANT). A deleted manifest never reaches here —
   parseNameStatus drops `D` records — so no `git show :path` on a gone blob.
   Importer keys in the lock are repo-root-relative with the root spelled `.`. */
function stagedPnpmManifests(targets) {
  const manifests = [];
  for (const path of targets) {
    if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
    if (path.split('/').includes('node_modules')) continue;
    manifests.push({ path, importer: path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length) });
  }
  return manifests.sort((a, b) => a.path.localeCompare(b.path));
}

function parseArgs(argv) {
  let exactOnly = false;
  for (const arg of argv) {
    if (arg === '--exact-only') exactOnly = true;
    else throw new OperationalError(`unrecognized argument: ${arg}`);
  }
  return { exactOnly };
}

function report(findings) {
  if (findings.length === 0) {
    process.stdout.write('check-new-deps: ok\n');
    return 0;
  }
  for (const f of findings) process.stdout.write(`check-new-deps: ${f}\n`);
  return 1;
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

    /* D10 (amended, ADR-027): yarn still stands the gate down — it has no proof
       model here. pnpm now has one, so a tracked pnpm-lock.yaml selects the pnpm
       path instead of silencing the check. */
    if (git(['ls-files', '-z', '--', 'yarn.lock'], root).length > 0) {
      process.stdout.write('check-new-deps: check inactive (yarn lockfile tracked)\n');
      return 0;
    }
    const pnpmRepo = git(['ls-files', '-z', '--', 'pnpm-lock.yaml'], root).length > 0;

    const targets = parseNameStatus(git(['diff', '--cached', '--name-status', '-z', '-M'], root));

    /* Read a staged/HEAD blob only when git says it is there — `ls-tree` lists
       nothing (exit 0) for an absent path, and absence is not a git failure. */
    const headJson = (path, label) =>
      hasHead && git(['ls-tree', 'HEAD', '--', path], root).trim() !== ''
        ? parseJson(git(['show', `HEAD:${path}`], root), label)
        : null;

    if (pnpmRepo) {
      const lockfileStaged = targets.has('pnpm-lock.yaml');
      const manifests = stagedPnpmManifests(targets);
      if (manifests.length === 0 && !lockfileStaged) return 0;
      const stagedLock = lockfileStaged ? parsePnpmLock(git(['show', ':pnpm-lock.yaml'], root)) : null;
      /* The base lock is the ONLY baseline for lock-only tampering (a specifier
         or a resolution that moved without its manifest). A HEAD lock this parser
         rejects leaves those signals without a baseline rather than blocking the
         commit — the staged lock is still parsed strictly, so the fail-closed
         reading of THIS commit is unaffected. */
      let baseLock = null;
      if (lockfileStaged && hasHead && git(['ls-tree', 'HEAD', '--', 'pnpm-lock.yaml'], root).trim() !== '') {
        try {
          baseLock = parsePnpmLock(git(['show', 'HEAD:pnpm-lock.yaml'], root));
        } catch (error) {
          if (!(error instanceof OperationalError)) throw error;
        }
      }
      for (const manifest of manifests) {
        manifest.staged = parseJson(git(['show', `:${manifest.path}`], root), `staged ${manifest.path}`);
        manifest.base = headJson(manifest.path, `base ${manifest.path}`);
      }
      return report(evaluatePnpm({ manifests, stagedLock, baseLock, lockfileStaged, exactOnly }));
    }

    const manifestStagedChange = targets.has('package.json');
    const lockfileStaged = targets.has('package-lock.json');
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
    const baseManifest = headJson('package.json', 'base package.json');

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

    return report(evaluate({ baseManifest, stagedManifest, stagedLockfile, baseLockfile, lockfileStaged, exactOnly }));
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
