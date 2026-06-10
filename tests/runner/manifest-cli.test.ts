import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../../runner/src/manifest-cli.ts';

/** Makes a fresh tmp dir; the caller removes it. */
function tmp(prefix = 'manifest-cli-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('isMainModule returns false when process.argv[1] is undefined', () => {
  const saved = process.argv;
  try {
    // Drop argv[1] entirely: no entrypoint path means we can never be it.
    process.argv = [process.argv[0] ?? process.execPath];
    assert.equal(isMainModule(pathToFileURL('/any/module.ts').href), false);
  } finally {
    process.argv = saved;
  }
});

test('isMainModule returns true when argv[1] is the module path of metaUrl', () => {
  const dir = tmp();
  const saved = process.argv;
  try {
    const modulePath = path.join(dir, 'entry.mjs');
    fs.writeFileSync(modulePath, '');
    process.argv = [process.execPath, modulePath];
    assert.equal(isMainModule(pathToFileURL(modulePath).href), true);
  } finally {
    process.argv = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isMainModule returns true when argv[1] is a symlink to the module path', () => {
  const dir = tmp();
  const saved = process.argv;
  try {
    const modulePath = path.join(dir, 'real-entry.mjs');
    fs.writeFileSync(modulePath, '');
    const linkPath = path.join(dir, 'link-entry.mjs');
    fs.symlinkSync(modulePath, linkPath);
    // argv[1] is the symlink; metaUrl is the real file. realpath on BOTH sides
    // is what makes them compare equal — this pins the symlink-safety fix.
    process.argv = [process.execPath, linkPath];
    assert.equal(isMainModule(pathToFileURL(modulePath).href), true);
  } finally {
    process.argv = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isMainModule returns false for an unrelated path', () => {
  const dir = tmp();
  const saved = process.argv;
  try {
    const modulePath = path.join(dir, 'entry.mjs');
    const otherPath = path.join(dir, 'other.mjs');
    fs.writeFileSync(modulePath, '');
    fs.writeFileSync(otherPath, '');
    process.argv = [process.execPath, otherPath];
    assert.equal(isMainModule(pathToFileURL(modulePath).href), false);
  } finally {
    process.argv = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
