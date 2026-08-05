import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAllowedSpec,
  isSourceSpec,
  evaluate,
  evaluatePnpm,
  parsePnpmLock,
  OperationalError,
} from '../../tools/check-new-deps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', '..', 'tools', 'check-new-deps.mjs');
const TMP = fs.realpathSync(os.tmpdir());

/* Every temp fixture registers its root here; one file-scoped sweep removes them
   all after the suite. The fixtures assert mid-body, so a swept teardown beats a
   per-case finally that each test would have to remember to add. */
const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

const GRAMMAR_PASS = [
  '1.2.3', '1.2.3-beta.1', '^1.2.3', '^9', '^9.38', '~1.2.3', '~8', 'file:vendor/dev-standards',
  /* Case-insensitivity and build metadata are load-bearing: the grammar regexes
     were rewritten with the `i` flag (lowercase classes) — dropping the flag
     must turn these red. `^0` pins the flattened first RANGE_RE alternative. */
  '1.2.3-Alpha.1', '1.2.3+SHA.ABC', '1.2.3-rc.1+Build.5', '^0',
];
const GRAMMAR_FAIL = [
  '*', '>=1.0.0', '<=2', '>1', '1', '1.2', '1.x', '^9.x', 'latest',
  'git+https://github.com/u/r.git', 'https://example.com/x.tgz', 'github:u/r',
  '^1 || ^2', '1.2.3 - 2.0.0', 'npm:other@^1', 'file:../elsewhere',
  ' 1.2.3', '1.2.3 ', '1.2.3\n', '01.2.3', '1.2.3-', '^9.', '', '^01',
];

test('grammar: allowed specs pass', () => {
  for (const spec of GRAMMAR_PASS) assert.ok(isAllowedSpec(spec), `${JSON.stringify(spec)} should pass`);
});

test('grammar: everything outside the allow-list fails', () => {
  for (const spec of GRAMMAR_FAIL) assert.ok(!isAllowedSpec(spec), `${JSON.stringify(spec)} should fail`);
});

test('grammar: --exact-only drops caret/tilde but keeps exact + the file literal', () => {
  assert.ok(!isAllowedSpec('^1.2.3', { exactOnly: true }));
  assert.ok(isAllowedSpec('1.2.3', { exactOnly: true }));
  assert.ok(isAllowedSpec('file:vendor/dev-standards', { exactOnly: true }));
});

/* A lockfile object; `packages` carries the "" root section map plus any
   node_modules/<name> resolution entries. */
function makeLockfile(packages: Record<string, unknown>, version: unknown = 3): Record<string, unknown> {
  return { lockfileVersion: version, packages };
}

test('evaluate: new dep with a bound direct + resolution entry passes', () => {
  const findings = evaluate({
    baseManifest: { dependencies: {} },
    stagedManifest: { dependencies: { a: '^1.2.3' } },
    stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { version: '1.2.3' } }),
    lockfileStaged: true,
  });
  assert.deepEqual(findings, []);
});

test('evaluate: direct entry without a node_modules resolution entry fails', () => {
  const findings = evaluate({
    baseManifest: { dependencies: {} },
    stagedManifest: { dependencies: { a: '^1.2.3' } },
    stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } } }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /no resolution entry \(node_modules\/a\)/.test(f)));
});

test('evaluate: a resolution entry that is null/scalar/array fails (P1 — value must be an object)', () => {
  /* Object.hasOwn(packages, "node_modules/a") is true for a null/7/[] value, but an
     npm descriptor is always an object; a non-object means the pkg never resolved. */
  for (const bad of [null, 7, []] as unknown[]) {
    const findings = evaluate({
      baseManifest: { dependencies: {} },
      stagedManifest: { dependencies: { a: '^1.2.3' } },
      stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': bad }),
      lockfileStaged: true,
    });
    assert.ok(
      findings.some((f: string) => /no resolution entry \(node_modules\/a\)/.test(f)),
      `node_modules/a = ${JSON.stringify(bad)} must fail the resolution proof`,
    );
  }
});

test('evaluate: a transitive-only entry (no direct binding) fails', () => {
  const findings = evaluate({
    baseManifest: { dependencies: {} },
    stagedManifest: { dependencies: { a: '^1.2.3' } },
    stagedLockfile: makeLockfile({ '': { dependencies: {} }, 'node_modules/a': { version: '1.2.3' } }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /is not pinned/.test(f)));
});

test('evaluate: a direct entry in the WRONG section fails', () => {
  const findings = evaluate({
    baseManifest: { dependencies: {} },
    stagedManifest: { dependencies: { a: '^1.2.3' } },
    stagedLockfile: makeLockfile({ '': { devDependencies: { a: '^1.2.3' } }, 'node_modules/a': {} }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /is not pinned/.test(f)));
});

test('evaluate: a direct entry with a DIFFERENT spec fails', () => {
  const findings = evaluate({
    baseManifest: { dependencies: {} },
    stagedManifest: { dependencies: { a: '^1.2.3' } },
    stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.0.0' } }, 'node_modules/a': {} }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /is not pinned/.test(f)));
});

test('evaluate: a scoped dep with a scoped resolution entry passes', () => {
  const findings = evaluate({
    baseManifest: { dependencies: {} },
    stagedManifest: { dependencies: { '@scope/name': '^1.2.3' } },
    stagedLockfile: makeLockfile({
      '': { dependencies: { '@scope/name': '^1.2.3' } },
      'node_modules/@scope/name': { version: '1.2.3' },
    }),
    lockfileStaged: true,
  });
  assert.deepEqual(findings, []);
});

test('evaluate: a dep named "constructor" is not proven via the prototype chain', () => {
  /* D2 uses Object.hasOwn; `in`/member access would see Object.prototype.constructor
     and node_modules key lookup could resolve on the prototype, a false pass. */
  const findings = evaluate({
    baseManifest: { dependencies: {} },
    stagedManifest: { dependencies: { constructor: '^1.2.3' } },
    stagedLockfile: makeLockfile({ '': { dependencies: {} } }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /"constructor"/.test(f) && /is not pinned/.test(f)));
});

test('evaluate: a dep-bearing delta without a staged lockfile fails (D8)', () => {
  const findings = evaluate({
    baseManifest: { dependencies: {} },
    stagedManifest: { dependencies: { a: '^1.2.3' } },
    lockfileStaged: false,
  });
  assert.ok(findings.some((f: string) => /without a staged package-lock\.json/.test(f)));
});

test('evaluate: a metadata-only edit passes with no lockfile required', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.0.0' }, scripts: { build: 'x' } },
    stagedManifest: { dependencies: { a: '^1.0.0' }, scripts: { build: 'y' } },
    lockfileStaged: false,
  });
  assert.deepEqual(findings, []);
});

test('evaluate: a dep removed WITH a staged lockfile passes', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.0.0' } },
    stagedManifest: { dependencies: {} },
    stagedLockfile: makeLockfile({ '': { dependencies: {} } }),
    lockfileStaged: true,
  });
  assert.deepEqual(findings, []);
});

test('evaluate: a dep removed with NO staged lockfile fails (D8)', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.0.0' } },
    stagedManifest: { dependencies: {} },
    lockfileStaged: false,
  });
  assert.ok(findings.some((f: string) => /without a staged package-lock\.json/.test(f)));
});

test('evaluate: a peerDependencies-only spec change is ignored', () => {
  const findings = evaluate({
    baseManifest: { peerDependencies: { eslint: '>=9.38.0' } },
    stagedManifest: { peerDependencies: { eslint: '>=10.0.0' } },
    lockfileStaged: false,
  });
  assert.deepEqual(findings, []);
});

test('evaluate: a peer -> dependencies move counts as a NEW dep (D7)', () => {
  const findings = evaluate({
    baseManifest: { peerDependencies: { eslint: '>=9.38.0' } },
    stagedManifest: { dependencies: { eslint: '>=9.38.0' } },
    lockfileStaged: false,
  });
  /* Grammar runs on it (disallowed range) only because it is treated as NEW —
     if it counted as pre-existing, D3 would skip grammar for it. */
  assert.ok(findings.some((f: string) => /new dependency "eslint"/.test(f) && /disallowed/.test(f)));
});

test('evaluate: a spec change to a forbidden form PASSES with a staged lockfile (D3)', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' } },
    stagedManifest: { dependencies: { a: '>=1.2.3' } },
    stagedLockfile: makeLockfile({ '': { dependencies: { a: '>=1.2.3' } }, 'node_modules/a': {} }),
    lockfileStaged: true,
  });
  assert.deepEqual(findings, []);
});

test('evaluate: a spec change without a staged lockfile fails (D8)', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' } },
    stagedManifest: { dependencies: { a: '>=1.2.3' } },
    lockfileStaged: false,
  });
  assert.ok(findings.some((f: string) => /without a staged package-lock\.json/.test(f)));
});

test('evaluate: a corrupt staged lockfile with ZERO new deps is operational (D5 up-front)', () => {
  assert.throws(
    () =>
      evaluate({
        baseManifest: { dependencies: { a: '^1.0.0' } },
        stagedManifest: { dependencies: { a: '^1.0.0' } },
        stagedLockfile: makeLockfile({}, 2),
        lockfileStaged: true,
      }),
    OperationalError,
  );
});

test('evaluate: a dep removal carrying a lockfileVersion-2 lockfile is operational', () => {
  assert.throws(
    () =>
      evaluate({
        baseManifest: { dependencies: { a: '^1.0.0' } },
        stagedManifest: { dependencies: {} },
        stagedLockfile: makeLockfile({}, 2),
        lockfileStaged: true,
      }),
    OperationalError,
  );
});

test('evaluate: a valid-JSON but non-object staged manifest is operational (not a silent ok)', () => {
  for (const bad of [[], 'x', 42, true] as unknown[]) {
    assert.throws(() => evaluate({ stagedManifest: bad }), OperationalError);
  }
});

test('evaluate: a lockfile whose packages is missing or non-object is operational', () => {
  assert.throws(
    () => evaluate({ stagedManifest: { dependencies: {} }, stagedLockfile: { lockfileVersion: 3 }, lockfileStaged: true }),
    OperationalError,
  );
  assert.throws(
    () => evaluate({ stagedManifest: { dependencies: {} }, stagedLockfile: makeLockfile([] as unknown as Record<string, unknown>), lockfileStaged: true }),
    OperationalError,
  );
});

/* ADR-017 — source-swap on an EXISTING dep. */

/* Both lists double as the isSourceSpec classifier proof (faithful to
   npm-package-arg@14's registry-vs-source partition): deleting a rule from the
   classifier turns a specific spec here red. `.zip`/`.tar.bz2` are npa-registry
   and MUST stay registry; the `npm:` alias is npa-registry but DELIBERATELY a
   source (you declare `a`, install `other`). */
const REGISTRY_SPECS = [
  '1.2.3', '^1.2.3', '~1.2.3', '>=1.0.0', '<=2', '1.x', '*', '', 'latest', 'next', 'beta',
  'foo.bar', 'a.b.c', 'x.tar.bz2', 'pkg.zip', '^1 || ^2', '1.2.3 - 2.0.0', '1.2.3+build',
];
const SOURCE_SPECS = [
  'git+ssh://git@h/u/r.git', 'git+https://github.com/u/r.git', 'git://h/r.git', 'github:u/r', 'gitlab:u/r',
  'bitbucket:u/r', 'u/r', 'git@github.com:u/r.git', 'npm:other@^1', 'https://x/y.tgz', 'http://x/y.tar.gz',
  'file:vendor/dev-standards', 'file:../x', './x', '../x', '/abs', '~/home', 'pkg.tgz', 'foo.tar',
  'foo.tar.gz', 'FOO.TGZ', '.', '..', '.vendor', '.\\pkg',
  /* `pkg\subdir` isolates the backslash rule: no leading `.`, no `:`/`/`, no
     archive suffix, so ONLY `includes('\\')` classifies it — delete that rule and
     this fixture turns red (testing-guide: fixtures outside the generic fallback). */
  'pkg\\subdir',
];

test('ADR-017 classifier: registry version/range/tag specs are not sources', () => {
  for (const s of REGISTRY_SPECS) assert.ok(!isSourceSpec(s), `${JSON.stringify(s)} should be registry`);
});

test('ADR-017 classifier: git/remote/alias/file/path/archive specs are sources', () => {
  for (const s of SOURCE_SPECS) assert.ok(isSourceSpec(s), `${JSON.stringify(s)} should be source`);
});

test('ADR-017 classifier: a non-string spec is fail-closed to source', () => {
  for (const bad of [null, undefined, 42, {}, []] as unknown[]) assert.ok(isSourceSpec(bad));
});

/* Existing dep `a` is `^1.2.3` in base; stage a change to `spec` with a matching
   lockfile so D8 is satisfied and the source classification is the sole finding. */
function swapCase(spec: string): string[] {
  return evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' } },
    stagedManifest: { dependencies: { a: spec } },
    stagedLockfile: makeLockfile({ '': { dependencies: { a: spec } }, 'node_modules/a': {} }),
    lockfileStaged: true,
  });
}

test('evaluate: an existing dep changed to a source spec is a source swap (manifest-side)', () => {
  for (const spec of [
    'git+ssh://git@h/u/r.git', 'github:u/r', 'u/r', 'git@github.com:u/r.git', 'npm:other@^1',
    'file:../x', './x', '/abs', 'https://x.tgz', 'pkg.tgz', '.vendor',
  ]) {
    const findings = swapCase(spec);
    assert.ok(
      findings.some((f: string) => /existing dependency "a" changed to a non-registry source/.test(f)),
      `${JSON.stringify(spec)} must flag a source swap; got ${JSON.stringify(findings)}`,
    );
  }
});

test('evaluate: an existing dep range/tag change stays allowed (D3 preserved)', () => {
  for (const spec of ['>=1.0.0', 'latest', '*', '1.x', 'x.tar.bz2', 'pkg.zip']) {
    assert.deepEqual(swapCase(spec), [], `${JSON.stringify(spec)} must NOT flag`);
  }
});

test('evaluate: removing a source spec (source -> registry) is not a swap', () => {
  assert.deepEqual(
    evaluate({
      baseManifest: { dependencies: { a: 'github:u/r' } },
      stagedManifest: { dependencies: { a: '^1.2.3' } },
      stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': {} }),
      lockfileStaged: true,
    }),
    [],
  );
});

test('evaluate: the vendored dep is exempt when unchanged but a registry->vendor swap flags (no classifier exemption)', () => {
  const V = 'file:vendor/dev-standards';
  assert.deepEqual(
    evaluate({
      baseManifest: { dependencies: { d: V } },
      stagedManifest: { dependencies: { d: V } },
      stagedLockfile: makeLockfile({ '': { dependencies: { d: V } }, 'node_modules/d': { link: true, resolved: 'vendor/dev-standards' } }),
      lockfileStaged: true,
    }),
    [],
  );
  assert.ok(swapCase(V).some((f: string) => /existing dependency "a" changed to a non-registry source/.test(f)));
});

test('evaluate: a lock-only source swap (manifest unstaged) is caught via the resolved scheme (signal 2)', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' } },
    stagedManifest: null,
    stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { resolved: 'git+ssh://git@h/u/r.git' } }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /existing dependency "a" resolves to a non-registry source/.test(f)));
});

test('evaluate: a lock root spec swapped to a source while the manifest stays registry is caught (signal 1)', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' } },
    stagedManifest: { dependencies: { a: '^1.2.3' } },
    stagedLockfile: makeLockfile({
      '': { dependencies: { a: 'github:u/r' } },
      'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.2.3.tgz' },
    }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /existing dependency "a" is pinned to a non-registry source/.test(f)));
});

test('evaluate: an arbitrary-tarball lock swap (both https, different host) is caught by identity-drift (signal 3)', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' } },
    stagedManifest: null,
    baseLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.2.3.tgz' } }),
    stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { resolved: 'https://evil.example/a.tgz' } }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /changed its resolved package/.test(f) && /evil\.example/.test(f)));
});

test('evaluate: a SAME-host pivot to a different package is caught by identity-drift (Gate C P1)', () => {
  /* `…/a/-/a-1.2.3.tgz` -> `…/evil/-/evil-9.9.9.tgz` keeps the host but swaps the
     package; a host-only comparison would miss it. npm ci installs evil verbatim. */
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' } },
    stagedManifest: null,
    baseLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.2.3.tgz' } }),
    stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { resolved: 'https://registry.npmjs.org/evil/-/evil-9.9.9.tgz' } }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /changed its resolved package/.test(f)));
});

test('evaluate: a present-but-malformed existing-dep lock entry is flagged, not passed (N1 value-shape)', () => {
  for (const bad of [null, 7, []] as unknown[]) {
    const findings = evaluate({
      baseManifest: { dependencies: { a: '^1.2.3' } },
      stagedManifest: null,
      stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': bad }),
      lockfileStaged: true,
    });
    assert.ok(
      findings.some((f: string) => /has a malformed lock entry/.test(f)),
      `node_modules/a = ${JSON.stringify(bad)} must be flagged, not silently passed`,
    );
  }
});

test('evaluate: a link:true resolution (workspace / vendored) is not a source-swap false positive', () => {
  assert.deepEqual(
    evaluate({
      baseManifest: { dependencies: { a: '^1.2.3' } },
      stagedManifest: null,
      stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { link: true, resolved: 'packages/a' } }),
      lockfileStaged: true,
    }),
    [],
  );
});

/* Lock-only resolved-fingerprint edge cases (Gate C round 2). */
function driftCase(baseResolved: string, stagedResolved: string, name = 'a'): string[] {
  return evaluate({
    baseManifest: { dependencies: { [name]: '^1.2.3' } },
    stagedManifest: null,
    baseLockfile: makeLockfile({ '': { dependencies: { [name]: '^1.2.3' } }, [`node_modules/${name}`]: { resolved: baseResolved } }),
    stagedLockfile: makeLockfile({ '': { dependencies: { [name]: '^1.2.3' } }, [`node_modules/${name}`]: { resolved: stagedResolved } }),
    lockfileStaged: true,
  });
}

test('evaluate: a query-addressed package swap is caught by the fingerprint (Gate C R2 #1)', () => {
  assert.ok(
    driftCase('https://reg.ex/download?pkg=a&version=1', 'https://reg.ex/download?pkg=evil&version=9').some((f: string) =>
      /changed its resolved package/.test(f),
    ),
  );
});

test('evaluate: a link that indirects into node_modules is not exempt — it is flagged (Gate C R2 #2)', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' } },
    stagedManifest: null,
    stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { link: true, resolved: 'node_modules/evil' } }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /resolves to a non-registry source/.test(f)));
});

test('evaluate: a flat-CDN version bump (no /-/ marker) is not a false positive, but a pivot is caught (Gate C R2 #3)', () => {
  assert.deepEqual(driftCase('https://cdn.ex/download/a-1.0.0.tgz', 'https://cdn.ex/download/a-1.0.1.tgz'), []);
  assert.ok(driftCase('https://cdn.ex/download/a-1.0.0.tgz', 'https://cdn.ex/download/evil-9.tgz').some((f: string) => /changed its resolved package/.test(f)));
});

test('evaluate: a digit-bearing package name is not confused by the fingerprint (base64 -> base32)', () => {
  assert.ok(
    driftCase('https://registry.npmjs.org/base64/-/base64-1.0.0.tgz', 'https://registry.npmjs.org/base32/-/base32-1.0.0.tgz', 'base64').some(
      (f: string) => /changed its resolved package/.test(f),
    ),
  );
});

test('evaluate: a same-host version bump is not an identity-drift finding', () => {
  assert.deepEqual(
    evaluate({
      baseManifest: { dependencies: { a: '^1.2.3' } },
      stagedManifest: null,
      baseLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.2.3.tgz' } }),
      stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.2.4.tgz' } }),
      lockfileStaged: true,
    }),
    [],
  );
});

test('evaluate: effective-spec precedence — an optionalDependencies swap wins over a clean dependencies entry', () => {
  const findings = evaluate({
    baseManifest: { dependencies: { a: '^1.2.3' }, optionalDependencies: { a: '^1.2.3' } },
    stagedManifest: { dependencies: { a: '^1.2.3' }, optionalDependencies: { a: 'git+ssh://git@h/u/r.git' } },
    stagedLockfile: makeLockfile({ '': { optionalDependencies: { a: 'git+ssh://git@h/u/r.git' } }, 'node_modules/a': {} }),
    lockfileStaged: true,
  });
  assert.ok(findings.some((f: string) => /existing dependency "a" changed to a non-registry source/.test(f)));
});

test('evaluate: a name in both dependencies and optionalDependencies (clean) is not a false positive', () => {
  assert.deepEqual(
    evaluate({
      baseManifest: { dependencies: { a: '^1.2.3' }, optionalDependencies: { a: '^1.2.3' } },
      stagedManifest: { dependencies: { a: '^1.2.3' }, optionalDependencies: { a: '^1.2.3' } },
      stagedLockfile: makeLockfile({ '': { dependencies: { a: '^1.2.3' } }, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.2.3.tgz' } }),
      lockfileStaged: true,
    }),
    [],
  );
});

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(dir: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
}

function setupRepo(): { dir: string; env: NodeJS.ProcessEnv } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'check-new-deps-')));
  tempRoots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dir = path.join(root, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  const env = isolatedEnv(home);
  git(dir, env, 'init', '-q', '-b', 'main');
  git(dir, env, 'config', 'user.email', 't@t');
  git(dir, env, 'config', 'user.name', 't');
  git(dir, env, 'config', 'commit.gpgsign', 'false');
  return { dir, env };
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function runTool(dir: string, env: NodeJS.ProcessEnv, ...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function mkManifest(fields: Record<string, unknown>): string {
  return JSON.stringify({ name: 't', version: '0.0.0', ...fields }, null, 2) + '\n';
}

function mkLock(
  root: Record<string, unknown> = {},
  nm: Record<string, unknown> = {},
  version: unknown = 3,
): string {
  return (
    JSON.stringify(
      { name: 't', version: '0.0.0', lockfileVersion: version, requires: true, packages: { '': { name: 't', version: '0.0.0', ...root }, ...nm } },
      null,
      2,
    ) + '\n'
  );
}

test('git: partial stage (new dep staged, lockfile edited but unstaged) → exit 1', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package.json', mkManifest({ dependencies: { a: '^1.2.3' } }));
  git(dir, env, 'add', 'package.json');
  write(dir, 'package-lock.json', mkLock({ dependencies: { a: '^1.2.3' } }, { 'node_modules/a': { version: '1.2.3' } }));
  const r = runTool(dir, env);
  assert.equal(r.code, 1);
  assert.match(r.out, /without a staged package-lock\.json/);
});

test('git: INVERSE partial stage (new dep only in the working tree) → exit 0', () => {
  /* The sharpest index-only probe: the tool must read `:package.json` (index),
     never the working tree. A working-tree read here would see dep `a` and fail. */
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }, { 'node_modules/leftpad': { version: '1.0.0' } }));
  git(dir, env, 'add', 'package-lock.json');
  write(dir, 'package.json', mkManifest({ dependencies: { a: '^1.2.3' } }));
  const r = runTool(dir, env);
  assert.equal(r.code, 0);
  assert.match(r.out, /check-new-deps: ok/);
});

test('git: run from a SUBDIRECTORY resolves the repo top-level (metadata-only edit) → exit 0', () => {
  /* The base read hangs off `git ls-tree HEAD -- package.json`, a cwd-relative
     pathspec: pre-fix, from a subdir it misses the root manifest, the base reads
     empty, dep `a` looks new, and the metadata-only edit false-fails (exit 1). */
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: { a: '^1.2.3' } }));
  write(dir, 'package-lock.json', mkLock({ dependencies: { a: '^1.2.3' } }, { 'node_modules/a': { version: '1.2.3' } }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  /* version-only bump: a real staged manifest change with no dep-bearing delta. */
  write(dir, 'package.json', JSON.stringify({ name: 't', version: '0.0.1', dependencies: { a: '^1.2.3' } }, null, 2) + '\n');
  git(dir, env, 'add', 'package.json');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const r = runTool(sub, env);
  assert.equal(r.code, 0, r.err || r.out);
  assert.match(r.out, /check-new-deps: ok/);
});

test('git: rename INTO package.json (no base) treats every dep as new → exit 1', () => {
  const { dir, env } = setupRepo();
  write(dir, 'manifest-old.json', mkManifest({ dependencies: { pkgnew: '>=1.0.0' } }));
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  git(dir, env, 'mv', 'manifest-old.json', 'package.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 1);
  assert.match(r.out, /new dependency "pkgnew"/);
});

test('git: rename-AWAY of package.json → exit 0', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: { a: '1.2.3' } }));
  write(dir, 'package-lock.json', mkLock({ dependencies: { a: '1.2.3' } }, { 'node_modules/a': { version: '1.2.3' } }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  git(dir, env, 'mv', 'package.json', 'renamed.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 0);
});

test('git: unborn HEAD runs the rules against an empty base → exit 1', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: { a: '^1.2.3' } }));
  git(dir, env, 'add', 'package.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 1);
  assert.match(r.out, /without a staged package-lock\.json/);
});

test('git: unborn HEAD — a forbidden spec with a valid staged lockfile → grammar finding (exit 1)', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: { a: '>=1.0.0' } }));
  write(dir, 'package-lock.json', mkLock({ dependencies: { a: '>=1.0.0' } }, { 'node_modules/a': { version: '1.0.0' } }));
  git(dir, env, 'add', '-A');
  const r = runTool(dir, env);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /disallowed version spec/);
});

test('git: unborn HEAD — an allowed spec whose staged lockfile lacks the direct entry → D2 finding (exit 1)', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: { a: '^1.2.3' } }));
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }, { 'node_modules/a': { version: '1.2.3' } }));
  git(dir, env, 'add', '-A');
  const r = runTool(dir, env);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /not pinned/);
});

test('git: nothing staged → exit 0', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  const r = runTool(dir, env);
  assert.equal(r.code, 0);
});

test('git: a tracked pnpm-lock.yaml selects the pnpm path, it no longer stands the check down (D10, ADR-027)', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n");
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package.json', mkManifest({ dependencies: { a: '>=1.0.0' } }));
  git(dir, env, 'add', 'package.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /disallowed version spec/);
});

test('git: run outside any git repo → exit 2', () => {
  const nogit = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'check-new-deps-nogit-')));
  tempRoots.push(nogit);
  const env = isolatedEnv(nogit);
  env.GIT_CEILING_DIRECTORIES = TMP;
  const r = runTool(nogit, env);
  assert.equal(r.code, 2);
});

test('git: a staged broken lockfile is operational → exit 2', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package.json', mkManifest({ dependencies: { a: '^1.2.3' } }));
  write(dir, 'package-lock.json', '{ "lockfileVersion": 3, "packages": {');
  git(dir, env, 'add', 'package.json', 'package-lock.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 2);
  assert.match(r.err, /unparseable/);
});

test('git: a staged lockfileVersion-2 with zero new deps is operational (D5 up-front) → exit 2', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }, {}, 2));
  git(dir, env, 'add', 'package-lock.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 2);
  assert.match(r.err, /lockfileVersion/);
});

test('git: file:vendor/dev-standards new dep with bound entries passes → exit 0', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'package-lock.json', mkLock({ dependencies: {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package.json', mkManifest({ dependencies: { 'dev-standards': 'file:vendor/dev-standards' } }));
  write(dir, 'package-lock.json', mkLock(
    { dependencies: { 'dev-standards': 'file:vendor/dev-standards' } },
    { 'node_modules/dev-standards': { resolved: 'vendor/dev-standards', link: true } },
  ));
  git(dir, env, 'add', 'package.json', 'package-lock.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 0);
  assert.match(r.out, /check-new-deps: ok/);
});

test('git: the D10 package-manager probe reads the repo top-level from a subdirectory', () => {
  /* The ls-files pnpm/yarn probe is root-relative: reverting it to a cwd-relative
     pathspec leaves the existing subdir test green but misses the tracked
     pnpm-lock.yaml from a subdir and mis-reads the repo as npm — which now shows
     up as a bogus "without a staged package-lock.json" finding instead of the
     pnpm grammar finding. Staged manifest paths are root-relative for the same
     reason, so this pins both. */
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n");
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package.json', mkManifest({ dependencies: { a: '>=1.0.0' } }));
  git(dir, env, 'add', 'package.json');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const r = runTool(sub, env);
  assert.equal(r.code, 1, r.err || r.out);
  assert.match(r.out, /package\.json: new dependency "a" \(dependencies\) has a disallowed version spec/);
});

test('git: a git child killed by a signal at the HEAD probe is operational → exit 2', () => {
  /* A signalled child (status null, signal set) must NOT be mis-mapped to the
     valid nonzero "unborn HEAD" answer — that would false-pass every dep as new.
     A shim on PATH kills itself at the HEAD probe and passes every other call
     through to real git; the marker file proves the injection fired at the
     intended site, not on some earlier call (testing-guide fault-injection rule). */
  const { dir, env } = setupRepo();
  const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'check-new-deps-shim-')));
  tempRoots.push(shimDir);
  const marker = path.join(shimDir, 'head-probe-fired');
  /* Resolve real git in the TEST (which may spawn), embedding an absolute path so
     the shim's pass-through never re-enters the shim dir prepended to PATH. */
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const shim = path.join(shimDir, 'git');
  fs.writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in\n  *rev-parse*--verify*) touch '${marker}'; kill -TERM $$ ;;\n  *) exec '${realGit}' "$@" ;;\nesac\n`,
  );
  fs.chmodSync(shim, 0o755);
  const shimEnv = { ...env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` };
  const r = runTool(dir, shimEnv);
  assert.equal(r.code, 2, r.out || r.err);
  assert.match(r.err, /killed by signal/);
  assert.ok(fs.existsSync(marker), 'HEAD-probe injection did not fire at the intended site');
});

test('git: stdout survives pipe backpressure — the last of ~3000 findings is not truncated → exit 1', () => {
  /* Entrypoint drain: `process.exitCode = main()` lets the event loop flush stdout
     past the 64 KiB pipe buffer; `process.exit(main())` would truncate the tail,
     dropping the last dep's finding line even though the process still exits 1. */
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  const deps: Record<string, string> = {};
  for (let i = 1; i <= 3000; i++) deps[`pkg-${String(i).padStart(4, '0')}`] = '>=1.0.0';
  write(dir, 'package.json', mkManifest({ dependencies: deps }));
  git(dir, env, 'add', 'package.json');
  const r = spawnSync(process.execPath, [TOOL], { cwd: dir, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 1, r.stderr);
  assert.ok((r.stdout ?? '').length > 128 * 1024, `stdout was ${(r.stdout ?? '').length} bytes`);
  assert.match(r.stdout ?? '', /new dependency "pkg-3000"/);
});

/* ─────────────────────────────────────────────────────────────── pnpm ──── */

type PnpmEntry = { specifier: string; version: string };
type PnpmImporters = Record<string, Record<string, Record<string, PnpmEntry>>>;

/* Emits the exact shape pnpm writes: 2-space steps, scoped names single-quoted,
   an importer with no deps inlined as `{}`. */
function mkPnpmLock(importers: PnpmImporters, opts: { version?: string; packages?: string[] } = {}): string {
  const lines = [`lockfileVersion: '${opts.version ?? '9.0'}'`, '', 'importers:', ''];
  for (const [dir, sections] of Object.entries(importers)) {
    if (Object.keys(sections).length === 0) {
      lines.push(`  ${dir}: {}`, '');
      continue;
    }
    lines.push(`  ${dir}:`);
    for (const [sec, deps] of Object.entries(sections)) {
      lines.push(`    ${sec}:`);
      for (const [name, entry] of Object.entries(deps)) {
        lines.push(`      ${name.startsWith('@') ? `'${name}'` : name}:`);
        lines.push(`        specifier: ${entry.specifier}`);
        lines.push(`        version: ${entry.version}`);
      }
    }
    lines.push('');
  }
  if (opts.packages) lines.push('packages:', '', ...opts.packages, '');
  return lines.join('\n');
}

const REG = (specifier: string, version = specifier.replace(/^[\^~]/, '')): PnpmEntry => ({ specifier, version });

function pnpmManifest(over: Partial<{ path: string; importer: string; base: unknown; staged: unknown }> = {}) {
  return { path: 'package.json', importer: '.', base: {}, staged: {}, ...over };
}

test('pnpm parser: reads importers, quoted scoped keys, empty importers and nested paths', () => {
  const lock = parsePnpmLock(
    mkPnpmLock({
      '.': { devDependencies: { eslint: REG('^9', '9.39.5') } },
      'apps/client': {
        dependencies: {
          '@ariadne/engine': { specifier: 'workspace:*', version: 'link:../../packages/engine' },
          'better-auth': REG('1.6.23', '1.6.23(react@19.2.8)(react-dom@19.2.8(react@19.2.8))'),
        },
      },
      'packages/engine': {},
    }),
  );
  assert.deepEqual([...lock.importers.keys()], ['.', 'apps/client', 'packages/engine']);
  assert.deepEqual(lock.importers.get('.')?.get('devDependencies')?.get('eslint'), {
    specifier: '^9',
    version: '9.39.5',
  });
  assert.deepEqual(lock.importers.get('apps/client')?.get('dependencies')?.get('@ariadne/engine'), {
    specifier: 'workspace:*',
    version: 'link:../../packages/engine',
  });
  assert.equal(lock.importers.get('packages/engine')?.size, 0);
  assert.deepEqual(lock.sourceResolutions, []);
});

test('pnpm parser: strips quotes from specifiers, including the YAML \'\' escape', () => {
  const text = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', "      a:", "        specifier: '>=1.2.3'", '        version: 1.2.3'].join('\n');
  assert.equal(parsePnpmLock(text).importers.get('.')?.get('dependencies')?.get('a')?.specifier, '>=1.2.3');
  const quoted = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', "      'it''s':", '        specifier: 1.0.0', '        version: 1.0.0'].join('\n');
  assert.ok(parsePnpmLock(quoted).importers.get('.')?.get('dependencies')?.has("it's"));
});

test('pnpm parser: flags a packages: resolution that is not a plain integrity', () => {
  const lock = parsePnpmLock(
    mkPnpmLock(
      { '.': { dependencies: { a: REG('1.2.3') } } },
      {
        packages: [
          '  a@1.2.3:',
          '    resolution: {integrity: sha512-aaa}',
          '  b@2.0.0:',
          '    resolution: {tarball: https://evil.example/b.tgz}',
        ],
      },
    ),
  );
  assert.deepEqual(
    lock.sourceResolutions.map((r) => r.package),
    ['b@2.0.0'],
  );
});

/* The refusal list is the fail-open frontier: every one of these must be a loud
   OperationalError, never a silently empty importer map that proves every dep. */
const PARSER_REFUSALS: Array<[string, string[]]> = [
  ['unsupported lockfileVersion', ["lockfileVersion: '10.0'", '', 'importers:', '', '  .: {}']],
  ['missing lockfileVersion', ['importers:', '', '  .: {}']],
  ['tab', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '\t\tdependencies: {}']],
  ['anchor', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies: &anchor']],
  ['alias', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies: *anchor']],
  ['tag', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies: !!map']],
  ['block scalar', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies: |']],
  ['merge key', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    <<: *base']],
  ['comment', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    # injected', '    dependencies: {}']],
  ['sequence', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    - dependencies']],
  ['flow collection', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .: {dependencies: {a: 1}}']],
  ['duplicate importer', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .: {}', '  .: {}']],
  ['duplicate section', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '      a:', '        specifier: 1.0.0', '        version: 1.0.0', '    dependencies:']],
  ['duplicate dependency', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '      a:', '        specifier: 1.0.0', '        version: 1.0.0', '      a:', '        specifier: 9.9.9', '        version: 9.9.9']],
  ['section before importer', ["lockfileVersion: '9.0'", '', 'importers:', '', '    dependencies:']],
  ['dependency before section', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '      a:']],
  ['field before dependency', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '        specifier: 1.0.0']],
  ['unexpected indentation', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '      a:', '        specifier: 1.0.0', '          extra: x']],
  ['unparsable line', ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '      a:', '        specifier 1.0.0']],
];

test('pnpm parser: refuses every construct it cannot model, loudly', () => {
  for (const [label, lines] of PARSER_REFUSALS) {
    assert.throws(() => parsePnpmLock(lines.join('\n')), OperationalError, `"${label}" must be refused`);
  }
});

test('pnpm: a dep-bearing change with no staged lockfile is a finding', () => {
  const findings = evaluatePnpm({
    manifests: [pnpmManifest({ path: 'apps/client/package.json', importer: 'apps/client', staged: { dependencies: { a: '1.2.3' } } })],
    lockfileStaged: false,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? '', /^apps\/client\/package\.json: dependency change staged without a staged pnpm-lock\.yaml/);
});

test('pnpm: a new dep pinned by its own importer and section passes', () => {
  const findings = evaluatePnpm({
    manifests: [pnpmManifest({ path: 'apps/client/package.json', importer: 'apps/client', staged: { dependencies: { a: '1.2.3' } } })],
    stagedLock: parsePnpmLock(mkPnpmLock({ 'apps/client': { dependencies: { a: REG('1.2.3') } } })),
    lockfileStaged: true,
  });
  assert.deepEqual(findings, []);
});

test('pnpm: a new dep proven by ANOTHER importer or ANOTHER section is not proven', () => {
  const staged = { dependencies: { a: '1.2.3' } };
  const wrongImporter = evaluatePnpm({
    manifests: [pnpmManifest({ path: 'apps/client/package.json', importer: 'apps/client', staged })],
    stagedLock: parsePnpmLock(mkPnpmLock({ '.': { dependencies: { a: REG('1.2.3') } } })),
    lockfileStaged: true,
  });
  assert.match(wrongImporter[0] ?? '', /is not pinned in the staged pnpm-lock\.yaml/);
  const wrongSection = evaluatePnpm({
    manifests: [pnpmManifest({ staged })],
    stagedLock: parsePnpmLock(mkPnpmLock({ '.': { devDependencies: { a: REG('1.2.3') } } })),
    lockfileStaged: true,
  });
  assert.match(wrongSection[0] ?? '', /is not pinned in the staged pnpm-lock\.yaml/);
});

test('pnpm: specifier equality alone does not prove a new dep — the resolution must match too', () => {
  /* The forgery the "non-empty version" test would have passed: the manifest asks
     for a registry package, the hand-written lock resolves it to a local path. */
  for (const version of ['link:../../evil', 'file:../evil.tgz', 'https://evil.example/a.tgz', '']) {
    const findings = evaluatePnpm({
      manifests: [pnpmManifest({ staged: { dependencies: { a: '1.2.3' } } })],
      stagedLock: parsePnpmLock(mkPnpmLock({ '.': { dependencies: { a: { specifier: '1.2.3', version } } } })),
      lockfileStaged: true,
    });
    assert.match(findings[0] ?? '', /not the resolution its spec implies/, `version ${JSON.stringify(version)}`);
  }
});

test('pnpm: workspace:/catalog: specs are allowed but bound to the resolution they imply', () => {
  const ok = evaluatePnpm({
    manifests: [pnpmManifest({ staged: { dependencies: { '@a/b': 'workspace:*', c: 'catalog:default' } } })],
    stagedLock: parsePnpmLock(
      mkPnpmLock({
        '.': {
          dependencies: {
            '@a/b': { specifier: 'workspace:*', version: 'link:packages/b' },
            c: { specifier: 'catalog:default', version: '1.2.3' },
          },
        },
      }),
    ),
    lockfileStaged: true,
  });
  assert.deepEqual(ok, []);
  const laundered = evaluatePnpm({
    manifests: [pnpmManifest({ staged: { dependencies: { '@a/b': 'workspace:*' } } })],
    stagedLock: parsePnpmLock(
      mkPnpmLock({ '.': { dependencies: { '@a/b': { specifier: 'workspace:*', version: 'link:https://evil.example/b' } } } }),
    ),
    lockfileStaged: true,
  });
  assert.match(laundered[0] ?? '', /not the resolution its spec implies/);
});

test('pnpm: the spec grammar still applies, with workspace:/catalog: carved out', () => {
  const findings = evaluatePnpm({
    manifests: [pnpmManifest({ staged: { dependencies: { a: '>=1.0.0', b: 'workspace:^' } } })],
    lockfileStaged: false,
  });
  assert.equal(findings.filter((f) => /disallowed version spec/.test(f)).length, 1);
  assert.match(findings.find((f) => /disallowed/.test(f)) ?? '', /"a"/);
});

test('pnpm: an existing dep swapped to a non-registry source spec is a finding', () => {
  const findings = evaluatePnpm({
    manifests: [pnpmManifest({ base: { dependencies: { a: '1.2.3' } }, staged: { dependencies: { a: 'git+https://evil.example/a.git' } } })],
    stagedLock: parsePnpmLock(mkPnpmLock({ '.': { dependencies: { a: { specifier: 'git+https://evil.example/a.git', version: '1.2.3' } } } })),
    lockfileStaged: true,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? '', /changed to a non-registry source spec/);
});

test('pnpm: an existing registry dep whose lock resolution turned into a link is a finding', () => {
  const findings = evaluatePnpm({
    manifests: [pnpmManifest({ base: { dependencies: { a: '1.2.3' } }, staged: { dependencies: { a: '1.2.3' } } })],
    stagedLock: parsePnpmLock(mkPnpmLock({ '.': { dependencies: { a: { specifier: '1.2.3', version: 'link:../evil' } } } })),
    lockfileStaged: true,
  });
  assert.match(findings[0] ?? '', /not the resolution its spec implies/);
});

test('pnpm: a lock-only commit still reports a redirected packages: resolution', () => {
  const findings = evaluatePnpm({
    manifests: [],
    stagedLock: parsePnpmLock(
      mkPnpmLock({ '.': { dependencies: { a: REG('1.2.3') } } }, { packages: ['  a@1.2.3:', '    resolution: {tarball: https://evil.example/a.tgz}'] }),
    ),
    lockfileStaged: true,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? '', /resolves "a@1\.2\.3" from a non-registry source/);
});

test('pnpm: a non-object staged manifest is operational, not a silent pass', () => {
  /* `null` is the sharp one: it is valid JSON, and a `filter(Boolean)` over the
     manifest list would drop it silently instead of faulting. */
  for (const staged of [[], 'x', 42, null] as unknown[]) {
    assert.throws(
      () => evaluatePnpm({ manifests: [{ path: 'package.json', importer: '.', base: {}, staged }], lockfileStaged: false }),
      OperationalError,
      `staged ${JSON.stringify(staged)} must be operational`,
    );
  }
});

function setupPnpmRepo(): { dir: string; env: NodeJS.ProcessEnv } {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'apps/client/package.json', mkManifest({ dependencies: {} }));
  write(dir, 'pnpm-lock.yaml', mkPnpmLock({ '.': {}, 'apps/client': {} }));
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  return { dir, env };
}

test('pnpm git: a new dep in a WORKSPACE manifest with no staged lockfile → exit 1', () => {
  /* The regression this whole path exists for: before pnpm support the tool
     stood down here and exited 0, so any dependency reached a commit unchecked. */
  const { dir, env } = setupPnpmRepo();
  write(dir, 'apps/client/package.json', mkManifest({ dependencies: { 'left-pad': '1.3.0' } }));
  git(dir, env, 'add', 'apps/client/package.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /apps\/client\/package\.json: dependency change staged without a staged pnpm-lock\.yaml/);
});

test('pnpm git: manifest + matching lockfile staged together → exit 0', () => {
  const { dir, env } = setupPnpmRepo();
  write(dir, 'apps/client/package.json', mkManifest({ dependencies: { 'left-pad': '1.3.0' } }));
  write(dir, 'pnpm-lock.yaml', mkPnpmLock({ '.': {}, 'apps/client': { dependencies: { 'left-pad': REG('1.3.0') } } }));
  git(dir, env, 'add', '-A');
  const r = runTool(dir, env);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /check-new-deps: ok/);
});

test('pnpm git: reads the INDEX, never the working tree', () => {
  const { dir, env } = setupPnpmRepo();
  write(dir, 'package.json', mkManifest({ dependencies: { evil: '9.9.9' } }));
  const r = runTool(dir, env);
  assert.equal(r.code, 0, r.err);
});

test('pnpm git: a tracked yarn.lock still stands the gate down', () => {
  const { dir, env } = setupPnpmRepo();
  write(dir, 'yarn.lock', '# yarn\n');
  git(dir, env, 'add', 'yarn.lock');
  write(dir, 'package.json', mkManifest({ dependencies: { evil: '9.9.9' } }));
  git(dir, env, 'add', 'package.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /check inactive \(yarn lockfile tracked\)/);
});

test('pnpm git: a deleted manifest does not fault on a gone blob', () => {
  const { dir, env } = setupPnpmRepo();
  fs.rmSync(path.join(dir, 'apps/client/package.json'));
  git(dir, env, 'add', '-A');
  const r = runTool(dir, env);
  assert.equal(r.code, 0, r.err + r.out);
});

test('pnpm git: a brand-new workspace manifest has no base, so all its deps must be pinned', () => {
  const { dir, env } = setupPnpmRepo();
  write(dir, 'packages/new/package.json', mkManifest({ dependencies: { a: '1.2.3' } }));
  /* The lock IS staged (an importer was added) — it just never resolved `a`, so
     the missing-importer-entry path is what fails, not the missing-lockfile one. */
  write(dir, 'pnpm-lock.yaml', mkPnpmLock({ '.': {}, 'apps/client': {}, 'packages/new': {} }));
  git(dir, env, 'add', '-A');
  const r = runTool(dir, env);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /packages\/new\/package\.json: new dependency "a" \(dependencies\) is not pinned/);
});

const BASE_LOCK = () => parsePnpmLock(mkPnpmLock({ 'apps/client': { dependencies: { a: REG('1.2.3') } } }));

test('pnpm: a dep injected by editing ONLY the lockfile is a finding', () => {
  const findings = evaluatePnpm({
    manifests: [],
    baseLock: BASE_LOCK(),
    stagedLock: parsePnpmLock(mkPnpmLock({ 'apps/client': { dependencies: { a: REG('1.2.3'), evil: REG('9.9.9') } } })),
    lockfileStaged: true,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? '', /adds "evil" to importers\["apps\/client"\]\.dependencies .* with no matching package\.json change/);
});

test('pnpm: a declared spec rewritten by editing ONLY the lockfile is a finding', () => {
  const findings = evaluatePnpm({
    manifests: [],
    baseLock: BASE_LOCK(),
    stagedLock: parsePnpmLock(mkPnpmLock({ 'apps/client': { dependencies: { a: REG('9.9.9') } } })),
    lockfileStaged: true,
  });
  assert.match(findings[0] ?? '', /changed the declared spec of "a" .* with no matching package\.json change/);
});

test('pnpm: the same lock-only edit is NOT reported when that manifest is staged with it', () => {
  const findings = evaluatePnpm({
    manifests: [
      pnpmManifest({
        path: 'apps/client/package.json',
        importer: 'apps/client',
        base: { dependencies: { a: '1.2.3' } },
        staged: { dependencies: { a: '9.9.9' } },
      }),
    ],
    baseLock: BASE_LOCK(),
    stagedLock: parsePnpmLock(mkPnpmLock({ 'apps/client': { dependencies: { a: REG('9.9.9') } } })),
    lockfileStaged: true,
  });
  assert.deepEqual(findings, []);
});

test('pnpm: a plain transitive version bump under an untouched manifest stays quiet', () => {
  const findings = evaluatePnpm({
    manifests: [],
    baseLock: BASE_LOCK(),
    stagedLock: parsePnpmLock(mkPnpmLock({ 'apps/client': { dependencies: { a: { specifier: '1.2.3', version: '1.2.3(react@19.2.8)' } } } })),
    lockfileStaged: true,
  });
  assert.deepEqual(findings, []);
});

test('pnpm: one packages: key resolving two different ways across the commit is a finding', () => {
  const lock = (resolution: string) =>
    parsePnpmLock(mkPnpmLock({ '.': { dependencies: { a: REG('1.2.3') } } }, { packages: ['  a@1.2.3:', `    resolution: {integrity: ${resolution}}`] }));
  const findings = evaluatePnpm({
    manifests: [],
    baseLock: lock('sha512-good'),
    stagedLock: lock('sha512-evil'),
    lockfileStaged: true,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? '', /changed the resolution of "a@1\.2\.3" .* cannot resolve two ways/);
});

test('pnpm: moving an existing registry dep onto a workspace link is reported', () => {
  const findings = evaluatePnpm({
    manifests: [pnpmManifest({ base: { dependencies: { a: '1.2.3' } }, staged: { dependencies: { a: 'workspace:*' } } })],
    lockfileStaged: false,
  });
  assert.ok(findings.some((f: string) => /changed from "1\.2\.3" to the workspace-internal spec "workspace:\*"/.test(f)), findings.join('\n'));
});

test('pnpm: an unchanged workspace dep produces no transition finding', () => {
  const findings = evaluatePnpm({
    manifests: [pnpmManifest({ base: { dependencies: { a: 'workspace:*' } }, staged: { dependencies: { a: 'workspace:*' } } })],
    lockfileStaged: false,
  });
  assert.deepEqual(findings, []);
});

test('pnpm git: a lock-only commit that injects a dependency → exit 1', () => {
  const { dir, env } = setupPnpmRepo();
  write(dir, 'pnpm-lock.yaml', mkPnpmLock({ '.': {}, 'apps/client': { dependencies: { evil: REG('9.9.9') } } }));
  git(dir, env, 'add', 'pnpm-lock.yaml');
  const r = runTool(dir, env);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /adds "evil" to importers\["apps\/client"\]\.dependencies/);
});

test('pnpm git: an unparsable HEAD lockfile is reported, not silently swallowed', () => {
  /* The staged lock is still parsed strictly, so this commit is fully judged; what
     is lost is the drift BASELINE. That loss is said out loud (exit 1) rather than
     blocking the commit on a defect in history (exit 2) or passing in silence. */
  const { dir, env } = setupPnpmRepo();
  write(dir, 'pnpm-lock.yaml', 'lockfileVersion: nonsense\n');
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'broken base lock');
  write(dir, 'pnpm-lock.yaml', mkPnpmLock({ '.': {}, 'apps/client': {} }));
  git(dir, env, 'add', 'pnpm-lock.yaml');
  const r = runTool(dir, env);
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.out, /HEAD pnpm-lock\.yaml is unreadable .* have no baseline/);
});

test('pnpm parser: an unknown field parked under a dependency is refused', () => {
  const lines = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '      a:', '        specifier: 1.0.0', '        version: link:../evil', '        _real: 1.0.0'];
  assert.throws(() => parsePnpmLock(lines.join('\n')), OperationalError);
});

test('pnpm: the one grammar-legal source spec cannot launder a resolution', () => {
  /* `file:vendor/dev-standards` is the single source spec isAllowedSpec accepts,
     so it is the only one that reaches the lock side on a NEW dep. Bind it. */
  const findings = evaluatePnpm({
    manifests: [pnpmManifest({ staged: { devDependencies: { 'dev-standards': 'file:vendor/dev-standards' } } })],
    stagedLock: parsePnpmLock(
      mkPnpmLock({ '.': { devDependencies: { 'dev-standards': { specifier: 'file:vendor/dev-standards', version: 'link:../../evil' } } } }),
    ),
    lockfileStaged: true,
  });
  assert.match(findings[0] ?? '', /not the resolution its spec implies/);
  const honest = evaluatePnpm({
    manifests: [pnpmManifest({ staged: { devDependencies: { 'dev-standards': 'file:vendor/dev-standards' } } })],
    stagedLock: parsePnpmLock(
      mkPnpmLock({ '.': { devDependencies: { 'dev-standards': { specifier: 'file:vendor/dev-standards', version: 'file:vendor/dev-standards(eslint@9.39.5)' } } } }),
    ),
    lockfileStaged: true,
  });
  assert.deepEqual(honest, []);
});

test('pnpm: staging a manifest is not cover for a name only the lockfile introduces', () => {
  /* The importer IS staged (an unrelated dep moved), but `evil` appears nowhere
     in the manifest — a per-importer skip would have hidden it. */
  const findings = evaluatePnpm({
    manifests: [
      pnpmManifest({
        path: 'apps/client/package.json',
        importer: 'apps/client',
        base: { dependencies: { a: '1.2.3' } },
        staged: { dependencies: { a: '1.2.4' } },
      }),
    ],
    baseLock: BASE_LOCK(),
    stagedLock: parsePnpmLock(mkPnpmLock({ 'apps/client': { dependencies: { a: REG('1.2.4'), evil: REG('9.9.9') } } })),
    lockfileStaged: true,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? '', /adds "evil" to importers\["apps\/client"\]\.dependencies/);
});

test('pnpm parser: a second importers: block is refused', () => {
  const lines = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .: {}', '', 'importers:', '', '  apps/client: {}'];
  assert.throws(() => parsePnpmLock(lines.join('\n')), OperationalError);
});

test('pnpm parser: a BLOCK-form resolution is refused, not skimmed', () => {
  /* The redirect hides one line below a clean-looking `resolution:` header, where
     a line-oriented scan never looks. v9 only ever writes the flow form. */
  const lines = [
    "lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '      a:',
    '        specifier: 1.2.3', '        version: 1.2.3', '', 'packages:', '', '  a@1.2.3:',
    '    resolution:', '      tarball: https://evil.example/a.tgz',
  ];
  assert.throws(() => parsePnpmLock(lines.join('\n')), OperationalError);
});

test('pnpm parser: a lockfile with no importers block is refused', () => {
  assert.throws(() => parsePnpmLock("lockfileVersion: '9.0'\n"), OperationalError);
});

test('pnpm: a workspace link that climbs out of the repository is a finding', () => {
  const escaping = evaluatePnpm({
    manifests: [pnpmManifest({ staged: { dependencies: { '@a/b': 'workspace:*' } } })],
    stagedLock: parsePnpmLock(
      mkPnpmLock({ '.': { dependencies: { '@a/b': { specifier: 'workspace:*', version: 'link:../../../../tmp/evil' } } } }),
    ),
    lockfileStaged: true,
  });
  assert.match(escaping[0] ?? '', /not the resolution its spec implies/);
  /* The same climb is legitimate from a nested importer that has the depth for it. */
  const nested = evaluatePnpm({
    manifests: [pnpmManifest({ path: 'apps/client/package.json', importer: 'apps/client', staged: { dependencies: { '@a/b': 'workspace:*' } } })],
    stagedLock: parsePnpmLock(
      mkPnpmLock({ 'apps/client': { dependencies: { '@a/b': { specifier: 'workspace:*', version: 'link:../../packages/b' } } } }),
    ),
    lockfileStaged: true,
  });
  assert.deepEqual(nested, []);
  const absolute = evaluatePnpm({
    manifests: [pnpmManifest({ staged: { dependencies: { '@a/b': 'workspace:*' } } })],
    stagedLock: parsePnpmLock(
      mkPnpmLock({ '.': { dependencies: { '@a/b': { specifier: 'workspace:*', version: 'link:/tmp/evil' } } } }),
    ),
    lockfileStaged: true,
  });
  assert.match(absolute[0] ?? '', /not the resolution its spec implies/);
});
