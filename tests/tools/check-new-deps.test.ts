import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedSpec, isSourceSpec, evaluate, OperationalError } from '../../tools/check-new-deps.mjs';

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

test('git: a tracked pnpm-lock.yaml stands the check down (D10) → exit 0', () => {
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package.json', mkManifest({ dependencies: { a: '>=1.0.0' } }));
  git(dir, env, 'add', 'package.json');
  const r = runTool(dir, env);
  assert.equal(r.code, 0);
  assert.match(r.out, /pnpm\/yarn lockfile tracked/);
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

test('git: D10 pnpm/yarn stand-down probes the repo top-level from a subdirectory → exit 0', () => {
  /* The ls-files pnpm/yarn probe is root-relative: reverting only it to a
     cwd-relative pathspec leaves the existing subdir test green but misses the
     tracked pnpm-lock.yaml from a subdir, mis-reads the repo as npm, and the
     forbidden-spec dep false-fails (exit 1) instead of standing the check down. */
  const { dir, env } = setupRepo();
  write(dir, 'package.json', mkManifest({ dependencies: {} }));
  write(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'base');
  write(dir, 'package.json', mkManifest({ dependencies: { a: '>=1.0.0' } }));
  git(dir, env, 'add', 'package.json');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const r = runTool(sub, env);
  assert.equal(r.code, 0, r.err || r.out);
  assert.match(r.out, /pnpm\/yarn lockfile tracked/);
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
