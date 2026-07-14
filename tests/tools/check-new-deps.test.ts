import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedSpec, evaluate, OperationalError } from '../../tools/check-new-deps.mjs';

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

const GRAMMAR_PASS = ['1.2.3', '1.2.3-beta.1', '^1.2.3', '^9', '^9.38', '~1.2.3', '~8', 'file:vendor/dev-standards'];
const GRAMMAR_FAIL = [
  '*', '>=1.0.0', '<=2', '>1', '1', '1.2', '1.x', '^9.x', 'latest',
  'git+https://github.com/u/r.git', 'https://example.com/x.tgz', 'github:u/r',
  '^1 || ^2', '1.2.3 - 2.0.0', 'npm:other@^1', 'file:../elsewhere',
  ' 1.2.3', '1.2.3 ', '1.2.3\n', '01.2.3', '1.2.3-', '^9.', '',
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
