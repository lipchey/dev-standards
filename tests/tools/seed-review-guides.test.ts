import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'seed-review-guides.sh');
const AGENTS_TEMPLATES_DIR = path.join(REPO_ROOT, 'agents');
const INSTANCE_DOCS_REL = '.claude';
const EXIT_SUCCESS = 0;
const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;
const STALE_PROCESS_ID = '99999';

const INSTANCE_DOC_TEMPLATES = [
  ['CHECKLIST.md', 'checklist-template.md'],
  ['code-conventions.md', 'code-conventions-template.md'],
  ['gate-misses.md', 'gate-misses-template.md'],
  ['project-facts.md', 'project-facts-template.md'],
] as const;
const INSTANCE_DOC_NAMES = INSTANCE_DOC_TEMPLATES.map(([destinationName]) => destinationName);
const INSTANCE_DOC_COUNT = INSTANCE_DOC_TEMPLATES.length;
const FIRST_INSTANCE_DOC_NAME = INSTANCE_DOC_TEMPLATES[0][0];
const SECOND_INSTANCE_DOC_NAME = INSTANCE_DOC_TEMPLATES[1][0];

type RunResult = { status: number | null; stdout: string; stderr: string };

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    env: options.env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withRoot(callback: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-seed-'));
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function instanceDocsOf(root: string): string[] {
  const directory = path.join(root, INSTANCE_DOCS_REL);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function instanceDocPaths(root: string): string[] {
  return INSTANCE_DOC_NAMES.map((documentName) => path.join(root, INSTANCE_DOCS_REL, documentName));
}

function assertInstanceDocContentsMatchTemplates(root: string): void {
  for (const [destinationName, templateName] of INSTANCE_DOC_TEMPLATES) {
    assert.deepEqual(
      fs.readFileSync(path.join(root, INSTANCE_DOCS_REL, destinationName)),
      fs.readFileSync(path.join(AGENTS_TEMPLATES_DIR, templateName)),
      `${destinationName} must match its source template`,
    );
  }
}

function assertInstanceDocsMatchTemplates(root: string): void {
  assert.deepEqual(instanceDocsOf(root), [...INSTANCE_DOC_NAMES].sort());
  assertInstanceDocContentsMatchTemplates(root);
}

test('a fresh consumer receives exactly the four instance docs and check passes', () => {
  withRoot((root) => {
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assertInstanceDocsMatchTemplates(root);
    assert.equal(fs.existsSync(path.join(root, INSTANCE_DOCS_REL, 'review-guides')), false);
    assert.equal(
      result.stdout.includes(`seeded instance docs: ${INSTANCE_DOC_COUNT} (${INSTANCE_DOC_NAMES.join(', ')})`),
      true,
      result.stdout,
    );
    assert.match(result.stdout, /kept instance docs: 0/);

    const checkResult = run([root, '--check']);
    assert.equal(checkResult.status, EXIT_SUCCESS, checkResult.stderr);
    assert.match(checkResult.stdout, new RegExp(`instance docs: ok \\(${INSTANCE_DOC_COUNT}\\)`));
  });
});

test('--check requires all four docs, reports absence, and writes nothing', () => {
  withRoot((root) => {
    const emptyResult = run([root, '--check']);
    assert.equal(emptyResult.status, EXIT_INCOMPLETE);
    for (const documentName of INSTANCE_DOC_NAMES) {
      assert.equal(emptyResult.stderr.includes(`missing instance doc: ${documentName}`), true);
    }
    assert.equal(fs.existsSync(path.join(root, INSTANCE_DOCS_REL)), false, '--check must not create .claude');

    assert.equal(run([root]).status, EXIT_SUCCESS);
    const missingName = FIRST_INSTANCE_DOC_NAME;
    fs.rmSync(path.join(root, INSTANCE_DOCS_REL, missingName));
    const partialResult = run([root, '--check']);
    assert.equal(partialResult.status, EXIT_INCOMPLETE);
    assert.match(partialResult.stderr, new RegExp(`missing instance doc: ${missingName}`));
    assert.doesNotMatch(partialResult.stdout, /instance docs: ok/);
  });
});

test('a second seed is idempotent and preserves every doc byte-for-byte', () => {
  withRoot((root) => {
    assert.equal(run([root]).status, EXIT_SUCCESS);
    const firstContents = instanceDocPaths(root).map((filePath) => fs.readFileSync(filePath));
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.match(result.stdout, /seeded instance docs: 0/);
    assert.match(result.stdout, new RegExp(`kept instance docs: ${INSTANCE_DOC_COUNT}`));
    const secondContents = instanceDocPaths(root).map((filePath) => fs.readFileSync(filePath));
    assert.deepEqual(secondContents, firstContents);
  });
});

test('existing consumer content is preserved and a missing doc is repaired', () => {
  withRoot((root) => {
    assert.equal(run([root]).status, EXIT_SUCCESS);
    const preservedName = FIRST_INSTANCE_DOC_NAME;
    const missingName = SECOND_INSTANCE_DOC_NAME;
    const preservedPath = path.join(root, INSTANCE_DOCS_REL, preservedName);
    const preservedContent = Buffer.from('CONSUMER OWNS THIS DOCUMENT\n');
    fs.writeFileSync(preservedPath, preservedContent);
    fs.rmSync(path.join(root, INSTANCE_DOCS_REL, missingName));

    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.deepEqual(fs.readFileSync(preservedPath), preservedContent);
    assert.equal(
      fs.readFileSync(path.join(root, INSTANCE_DOCS_REL, missingName), 'utf8'),
      fs.readFileSync(path.join(AGENTS_TEMPLATES_DIR, INSTANCE_DOC_TEMPLATES[1][1]), 'utf8'),
    );
    assert.match(result.stdout, new RegExp(`seeded instance docs: 1 \\(${missingName}\\)`));
    assert.match(result.stdout, new RegExp(`kept instance docs: ${INSTANCE_DOC_COUNT - 1}`));
  });
});

test('repo-owned extras and existing symlinks are untouched and excluded from counts', () => {
  withRoot((root) => {
    const directory = path.join(root, INSTANCE_DOCS_REL);
    fs.mkdirSync(directory, { recursive: true });
    const externalTarget = path.join(root, 'owned-checklist.md');
    fs.writeFileSync(externalTarget, 'linked consumer content\n');
    fs.symlinkSync(externalTarget, path.join(directory, FIRST_INSTANCE_DOC_NAME));
    fs.writeFileSync(path.join(directory, 'extra.md'), 'repo-specific\n');

    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.equal(fs.readFileSync(path.join(directory, FIRST_INSTANCE_DOC_NAME), 'utf8'), 'linked consumer content\n');
    assert.equal(fs.readFileSync(path.join(directory, 'extra.md'), 'utf8'), 'repo-specific\n');
    assert.match(result.stdout, /seeded instance docs: 3/);
    assert.match(result.stdout, /kept instance docs: 1/);
    assert.equal(run([root, '--check']).status, EXIT_SUCCESS);
  });
});

test('seeding from an arbitrary current directory resolves templates from the script', () => {
  withRoot((root) => {
    const otherCurrentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cwd-'));
    try {
      const result = run([root], { cwd: otherCurrentDirectory });
      assert.equal(result.status, EXIT_SUCCESS, result.stderr);
      assertInstanceDocsMatchTemplates(root);
    } finally {
      fs.rmSync(otherCurrentDirectory, { recursive: true, force: true });
    }
  });
});

test('invalid roots, removed guide flags, and extra operands fail with usage status', () => {
  withRoot((root) => {
    assert.equal(run([]).status, EXIT_USAGE);
    assert.equal(run([path.join(root, 'missing')]).status, EXIT_USAGE);
    const filePath = path.join(root, 'not-a-directory');
    fs.writeFileSync(filePath, 'x');
    assert.equal(run([filePath]).status, EXIT_USAGE);
    assert.equal(run([root, '--bogus']).status, EXIT_USAGE);
    assert.equal(run([root, '--guides-dir', 'custom/guides']).status, EXIT_USAGE);
    assert.equal(run([root, 'extra']).status, EXIT_USAGE);
    assert.equal(fs.existsSync(path.join(root, INSTANCE_DOCS_REL)), false);
  });
});

test('atomic seeding removes only destination-specific stale temps', () => {
  withRoot((root) => {
    const directory = path.join(root, INSTANCE_DOCS_REL);
    fs.mkdirSync(directory, { recursive: true });
    const firstName = FIRST_INSTANCE_DOC_NAME;
    const staleTemp = path.join(directory, `${firstName}.tmp.${STALE_PROCESS_ID}`);
    const foreignLookalike = path.join(directory, 'draft.md.tmp.keep');
    fs.writeFileSync(staleTemp, 'truncated');
    fs.writeFileSync(foreignLookalike, 'mine');

    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.equal(fs.existsSync(staleTemp), false);
    assert.equal(fs.readFileSync(foreignLookalike, 'utf8'), 'mine');
    assertInstanceDocContentsMatchTemplates(root);
  });
});

test('a failing copy publishes no partial file or temp and a later seed recovers', () => {
  withRoot((root) => {
    const shimsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shim-'));
    try {
      fs.writeFileSync(path.join(shimsDirectory, 'cp'), '#!/bin/sh\necho partial > "$2"\nexit 1\n', {
        mode: 0o755,
      });
      const brokenResult = run([root], {
        env: { ...process.env, PATH: `${shimsDirectory}:${process.env.PATH ?? ''}` },
      });
      assert.equal(brokenResult.status, EXIT_USAGE);
      assert.match(brokenResult.stderr, /copy failed/);
      const directory = path.join(root, INSTANCE_DOCS_REL);
      assert.deepEqual(instanceDocsOf(root), []);
      assert.deepEqual(
        fs.readdirSync(directory).filter((fileName) => fileName.includes('.tmp.')),
        [],
      );

      const recoveryResult = run([root]);
      assert.equal(recoveryResult.status, EXIT_SUCCESS, recoveryResult.stderr);
      assertInstanceDocsMatchTemplates(root);
    } finally {
      fs.rmSync(shimsDirectory, { recursive: true, force: true });
    }
  });
});

test('check rejects non-regular docs: directory and dangling symlink read as missing', () => {
  withRoot((root) => {
    assert.equal(run([root]).status, EXIT_SUCCESS);
    const directory = path.join(root, INSTANCE_DOCS_REL);
    fs.rmSync(path.join(directory, FIRST_INSTANCE_DOC_NAME));
    fs.mkdirSync(path.join(directory, FIRST_INSTANCE_DOC_NAME));
    fs.rmSync(path.join(directory, SECOND_INSTANCE_DOC_NAME));
    fs.symlinkSync(path.join(root, 'nowhere.md'), path.join(directory, SECOND_INSTANCE_DOC_NAME));

    const result = run([root, '--check']);
    assert.equal(result.status, EXIT_INCOMPLETE);
    assert.match(result.stderr, new RegExp(`missing instance doc: ${FIRST_INSTANCE_DOC_NAME}`));
    assert.match(result.stderr, new RegExp(`missing instance doc: ${SECOND_INSTANCE_DOC_NAME}`));
  });
});

test('a symlinked instance-docs dir is rejected in both modes and nothing is written through it', () => {
  withRoot((root) => {
    const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-outside-'));
    try {
      fs.symlinkSync(outsideTarget, path.join(root, INSTANCE_DOCS_REL));

      const seedResult = run([root]);
      assert.equal(seedResult.status, EXIT_USAGE);
      assert.match(seedResult.stderr, /instance-doc dir is a symlink/);
      assert.deepEqual(fs.readdirSync(outsideTarget), []);

      const checkResult = run([root, '--check']);
      assert.equal(checkResult.status, EXIT_USAGE);
      assert.match(checkResult.stderr, /instance-doc dir is a symlink/);
    } finally {
      fs.rmSync(outsideTarget, { recursive: true, force: true });
    }
  });
});
