import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfined, resolveConfinedPath, writeReport } from '../../runner/src/report.ts';
import type { RunnerReport } from '../../runner/src/report.ts';

function makeReport(scope = 'fast'): RunnerReport {
  return {
    repo: 'dev-standards',
    scope,
    generatedAt: new Date().toISOString(),
    results: [
      { name: 'tsc', tier: 'fast', status: 'pass', exitCode: 0, durationMs: 12, mode: 'blocking' },
    ],
  };
}

function tmp(prefix = 'verify-report-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('writeReport writes pretty, newline-terminated JSON that round-trips', () => {
  const root = tmp();
  try {
    const report = makeReport();
    const written = writeReport(report, root, 'reports');

    assert.equal(written, path.join(root, 'reports', 'verify-fast.json'));
    const content = fs.readFileSync(written, 'utf8');
    assert.ok(content.endsWith('\n'), 'report content must be newline-terminated');
    assert.deepEqual(JSON.parse(content), report);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeReport rejects a reports path that escapes the repo root via ..', () => {
  const root = tmp();
  try {
    assert.throws(() => writeReport(makeReport(), root, '../escape'), /outside the repo root/i);
    assert.ok(
      !fs.existsSync(path.join(root, '..', 'escape')),
      'an escaping report directory must never be created',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeReport rejects an absolute reports path outside the repo root', () => {
  const root = tmp();
  const outside = tmp('verify-outside-');
  try {
    assert.throws(() => writeReport(makeReport(), root, outside), /outside the repo root/i);
    assert.ok(
      !fs.existsSync(path.join(outside, 'verify-fast.json')),
      'no report may be written into the out-of-root directory',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('writeReport rejects a symlinked report directory that escapes the repo root', () => {
  const root = tmp();
  const outside = tmp('verify-outside-');
  try {
    // Repo-controlled report directories can be symlink escapes.
    fs.symlinkSync(outside, path.join(root, 'reports'), 'dir');
    assert.throws(() => writeReport(makeReport(), root, 'reports/quality'), /outside the repo root/i);
    assert.ok(
      !fs.existsSync(path.join(outside, 'quality', 'verify-fast.json')),
      'no report may be written through the escaping symlink',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('writeReport replaces a symlinked report leaf instead of following it (P1)', () => {
  const root = tmp();
  const victimDir = tmp('verify-victim-');
  const victim = path.join(victimDir, 'victim.txt');
  const original = 'ORIGINAL VICTIM CONTENT\n';
  try {
    fs.writeFileSync(victim, original);
    // A repo-controlled report leaf can target an operator-writable file.
    const leaf = path.join(root, 'verify-fast.json');
    fs.symlinkSync(victim, leaf);

    const report = makeReport();
    const written = writeReport(report, root, '.');

    assert.equal(written, leaf);
    assert.equal(
      fs.readFileSync(victim, 'utf8'),
      original,
      'the out-of-repo symlink target must be left untouched',
    );
    assert.ok(
      !fs.lstatSync(leaf).isSymbolicLink(),
      'the report leaf must be replaced by a real file, not the symlink',
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(leaf, 'utf8')), report);
    assert.deepEqual(
      fs.readdirSync(root).filter((entry) => entry.endsWith('.tmp')),
      [],
      'the atomic-write temp file must not be left behind',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(victimDir, { recursive: true, force: true });
  }
});

test('writeReport overwrites an existing real report leaf (regression for atomic rename)', () => {
  const root = tmp();
  try {
    writeReport(makeReport(), root, 'reports');
    const second = makeReport();
    second.generatedAt = new Date(Date.now() + 1000).toISOString();
    const written = writeReport(second, root, 'reports');
    assert.deepEqual(JSON.parse(fs.readFileSync(written, 'utf8')), second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfinedPath rejects lexical and symlink escapes', () => {
  const root = tmp();
  const outside = tmp('verify-outside-');
  try {
    assert.throws(
      () => resolveConfinedPath(root, '../escape.json'),
      /^Error: path "\.\.\/escape\.json" resolves outside the repo root:/,
    );
    fs.symlinkSync(outside, path.join(root, 'artifacts'), 'dir');
    assert.throws(
      () => resolveConfinedPath(root, 'artifacts/result.json'),
      /^Error: path "artifacts\/result\.json" resolves outside the repo root:/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('readConfined reads a regular file through its open handle', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'result.json'), '{"ok":true}\n');
    assert.equal(readConfined(root, 'result.json'), '{"ok":true}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readConfined rejects a symlink leaf and a directory', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'real.json'), '{}');
    fs.symlinkSync(path.join(root, 'real.json'), path.join(root, 'link.json'));
    fs.mkdirSync(path.join(root, 'directory.json'));

    assert.throws(() => readConfined(root, 'link.json'));
    assert.throws(() => readConfined(root, 'directory.json'), /regular file/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
