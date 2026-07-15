#!/usr/bin/env node
// Content-fingerprint of the runner build inputs. The core ./verify shim compares
// this against runner/dist/.build-fingerprint and refuses a bundle whose sources or
// build recipe changed since the last build (build-on-demand artifact → stamp +
// freshness, quality-gates.md).
//
// Node crypto, not a shasum/shell pipeline: the consumer's ds-bootstrap.sh builds
// this submodule (`npm run build`), so a shell/shasum dependency in the build would
// become a new consumer build requirement (bash/coreutils on every adopter, Windows
// included). Node is already guaranteed — the verify shim execs `node` anyway.
//
// A CONTENT fingerprint, not a revision/SHA stamp (the consumer shim's approach):
// active core dev moves HEAD on every commit and leaves uncommitted source edits, so
// a SHA stamp would false-pass on exactly the uncommitted edits this guard must catch.
//
// Wired into `build:runner` (not a top-level `postbuild`) so it stamps whether the
// runner bundle is built via `npm run build` or `npm run build:runner` directly, and
// so the stamp is written immediately after esbuild (minimal edit-during-build window).
//
// ponytail: covers runner/src/*.ts content + the `build:runner` recipe + the esbuild
// version RANGE. A within-range esbuild bump (same package.json range) is not caught,
// and the ~ms window between esbuild and this stamp is a documented ceiling — this is a
// LOCAL dev guard; CI rebuilds every run so CI is safe regardless.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const repoRoot = argValue('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..');
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
  // Sorted for a deterministic, traversal-order-independent digest; forward-slash the
  // relative path so the fingerprint is stable across platforms and absolute prefixes.
  for (const file of tsFiles(srcDir).sort()) {
    hash.update(relative(repoRoot, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  // Bind the bundle to how it was built, so a recipe change (same sources) is caught.
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
  const tmp = `${stampPath}.tmp`;
  writeFileSync(tmp, `${fp}\n`);
  renameSync(tmp, stampPath); // atomic replace; a failed write never leaves a truncated stamp
} else {
  process.stdout.write(`${fp}\n`);
}
