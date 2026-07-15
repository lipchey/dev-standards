#!/usr/bin/env node
/*
 * Content-fingerprint of the runner build inputs. The core ./verify shim compares this
 * against runner/dist/.build-fingerprint and refuses a bundle whose sources or build
 * recipe changed since the last build (build-on-demand artifact -> stamp + freshness,
 * quality-gates.md).
 *
 * Node crypto, not a shasum/shell pipeline: the consumer's ds-bootstrap.sh builds this
 * submodule (`npm run build`), so a shell/shasum dependency in the build would become a
 * new consumer build requirement (bash/coreutils on every adopter, Windows included).
 * Node is already guaranteed -- the verify shim execs `node` anyway.
 *
 * A CONTENT fingerprint, not a revision/SHA stamp (the consumer shim's approach): active
 * core dev moves HEAD on every commit and leaves uncommitted source edits, so a SHA
 * stamp would false-pass on exactly the uncommitted edits this guard must catch.
 *
 * Wired into `build:runner` (not a top-level `postbuild`) so it stamps whether the runner
 * bundle is built via `npm run build` or `npm run build:runner` directly.
 *
 * Known ceilings (LOCAL dev guard only; CI rebuilds every run so CI is safe regardless):
 *   - the esbuild version is fingerprinted as the package.json RANGE, so a within-range
 *     bump (same range string) is not caught;
 *   - a source edit in the sub-second window between esbuild finishing and this stamp
 *     writing yields bundle(S0)+stamp(S1) -> a false-fresh pass. Not worth a
 *     capture-before/verify-after build wrapper for a local convenience guard.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, openSync, writeSync, closeSync, renameSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/* `--root <dir>` overrides the repo root (used by tests). Reject a missing or
   flag-looking value: `--write --root` with no dir must not silently fall back to the
   real repo and overwrite its stamp. */
function rootArg() {
  const i = process.argv.indexOf('--root');
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('-')) {
    process.stderr.write('build-fingerprint: --root requires a directory value\n');
    process.exit(2);
  }
  return value;
}

const repoRoot = rootArg() ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'runner', 'src');
const stampPath = join(repoRoot, 'runner', 'dist', '.build-fingerprint');

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function fingerprint() {
  const hash = createHash('sha256');
  /* Sort by the forward-slashed relative KEY (not the native absolute path): `sep`
     differs across POSIX/Windows, so sorting raw paths would order files differently per
     OS and false-stale a shared checkout. The key folds path + set membership into the
     digest; the content folds in file bodies. */
  const files = tsFiles(srcDir)
    .map((abs) => ({ abs, key: relative(repoRoot, abs).split(sep).join('/') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { abs, key } of files) {
    hash.update(key);
    hash.update('\0');
    hash.update(readFileSync(abs));
    hash.update('\0');
  }
  /* Bind the bundle to how it was built, so a recipe change (same sources) is caught.
     Only the two fields that actually shape the runner bundle -- not the whole file, so
     an unrelated package.json edit (version bump, other deps) does not false-stale. */
  const pkgPath = join(repoRoot, 'package.json');
  hash.update('recipe\0');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    hash.update(pkg.scripts?.['build:runner'] ?? '');
    hash.update('\0');
    hash.update(pkg.devDependencies?.esbuild ?? '');
  }
  return hash.digest('hex');
}

const fp = fingerprint();
if (process.argv.includes('--write')) {
  /* Random-suffix temp opened O_CREAT|O_EXCL (`wx`) then atomic rename: a predictable
     `.tmp` written with truncating semantics is a symlink-race (profile-security.md
     §Path confinement) -- an attacker-planted symlink at the fixed name would be followed
     and its target truncated. */
  const tmp = `${stampPath}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, `${fp}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, stampPath);
} else {
  process.stdout.write(`${fp}\n`);
}
