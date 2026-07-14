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
const GUIDE_TEMPLATES_DIR = path.join(AGENTS_TEMPLATES_DIR, 'review-guide-templates');
const DEFAULT_GUIDES_REL = '.claude/review-guides';
const DEFAULT_INSTANCE_DOCS_REL = '.claude';
const EXIT_SUCCESS = 0;
const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;
const PARTIAL_REPAIR_COUNT = 2;
const STALE_PROCESS_ID = '99999';

/* The canonical guide set must follow the template directory without a duplicated list. */
const CANONICAL_GUIDES = fs
  .readdirSync(GUIDE_TEMPLATES_DIR)
  .filter((fileName) => fileName.endsWith('.md'))
  .sort();
const CANONICAL_GUIDE_COUNT = CANONICAL_GUIDES.length;

const INSTANCE_DOC_TEMPLATES = [
  ['CHECKLIST.md', 'checklist-template.md'],
  ['code-conventions.md', 'code-conventions-template.md'],
  ['gate-misses.md', 'gate-misses-template.md'],
  ['project-facts.md', 'project-facts-template.md'],
] as const;
const INSTANCE_DOC_NAMES = INSTANCE_DOC_TEMPLATES.map(([destinationName]) => destinationName);
const FIRST_INSTANCE_DOC_NAME = INSTANCE_DOC_TEMPLATES[0][0];
const INSTANCE_DOC_COUNT = INSTANCE_DOC_TEMPLATES.length;
const ONBOARDING_FILE_COUNT = CANONICAL_GUIDE_COUNT + INSTANCE_DOC_COUNT;
const EXPECTED_SEEDED_NAMES = [...CANONICAL_GUIDES, ...INSTANCE_DOC_NAMES];

function canonicalGuide(index: number): string {
  const guideName = CANONICAL_GUIDES[index];
  if (guideName === undefined) {
    throw new Error(`fewer than ${index + 1} canonical guides in ${GUIDE_TEMPLATES_DIR}`);
  }
  return guideName;
}

type Run = { status: number | null; stdout: string; stderr: string };

function run(args: string[], options: { cwd?: string } = {}): Run {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', cwd: options.cwd });
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

function guidesOf(root: string, relativePath = DEFAULT_GUIDES_REL): string[] {
  const directory = path.join(root, relativePath);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.md'))
    .sort();
}

function instanceDocsOf(root: string): string[] {
  const directory = path.join(root, DEFAULT_INSTANCE_DOCS_REL);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((fileName) => INSTANCE_DOC_NAMES.includes(fileName as (typeof INSTANCE_DOC_NAMES)[number]))
    .sort();
}

function expectedSeededPaths(root: string): string[] {
  return [
    ...CANONICAL_GUIDES.map((guideName) => path.join(root, DEFAULT_GUIDES_REL, guideName)),
    ...INSTANCE_DOC_NAMES.map((documentName) => path.join(root, DEFAULT_INSTANCE_DOCS_REL, documentName)),
  ];
}

function readSeededFiles(root: string): Buffer[] {
  return expectedSeededPaths(root).map((filePath) => fs.readFileSync(filePath));
}

function assertInstanceDocsMatchTemplates(root: string): void {
  assert.deepEqual(instanceDocsOf(root), [...INSTANCE_DOC_NAMES].sort());
  for (const [destinationName, templateName] of INSTANCE_DOC_TEMPLATES) {
    assert.deepEqual(
      fs.readFileSync(path.join(root, DEFAULT_INSTANCE_DOCS_REL, destinationName)),
      fs.readFileSync(path.join(AGENTS_TEMPLATES_DIR, templateName)),
      `${destinationName} must match its source template`,
    );
  }
}

test('a fresh consumer receives all review guides and instance docs', () => {
  withRoot((root) => {
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.deepEqual(guidesOf(root), CANONICAL_GUIDES);
    assertInstanceDocsMatchTemplates(root);
    assert.equal(guidesOf(root).length + instanceDocsOf(root).length, ONBOARDING_FILE_COUNT);
    assert.match(result.stdout, new RegExp(`seeded: ${ONBOARDING_FILE_COUNT} \\(`));
    assert.ok(
      result.stdout.includes(`seeded: ${ONBOARDING_FILE_COUNT} (${EXPECTED_SEEDED_NAMES.join(', ')})`),
      result.stdout,
    );
    assert.match(result.stdout, /kept: 0/);
  });
});

test('a second seed is idempotent and preserves every seeded file byte-for-byte', () => {
  withRoot((root) => {
    run([root]);
    const firstContents = readSeededFiles(root);
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.match(result.stdout, /seeded: 0/);
    assert.match(result.stdout, new RegExp(`kept: ${ONBOARDING_FILE_COUNT}`));
    const secondContents = readSeededFiles(root);
    secondContents.forEach((content, index) => assert.deepEqual(content, firstContents[index]));
  });
});

test('an existing guide with changed content is preserved byte-for-byte', () => {
  withRoot((root) => {
    run([root]);
    const target = path.join(root, DEFAULT_GUIDES_REL, canonicalGuide(0));
    const editedContent = Buffer.from('REPO OWNS THIS BODY\n');
    fs.writeFileSync(target, editedContent);
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.deepEqual(fs.readFileSync(target), editedContent);
  });
});

test('an existing instance doc with changed content is preserved byte-for-byte', () => {
  withRoot((root) => {
    run([root]);
    const target = path.join(root, DEFAULT_INSTANCE_DOCS_REL, FIRST_INSTANCE_DOC_NAME);
    const editedContent = Buffer.from('REPO OWNS THIS DOCUMENT\n');
    fs.writeFileSync(target, editedContent);
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.deepEqual(fs.readFileSync(target), editedContent);
  });
});

test('a partial guide set is repaired without replacing the remaining onboarding files', () => {
  withRoot((root) => {
    run([root]);
    const removedGuides = CANONICAL_GUIDES.slice(0, PARTIAL_REPAIR_COUNT);
    for (const guideName of removedGuides) {
      fs.rmSync(path.join(root, DEFAULT_GUIDES_REL, guideName));
    }
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.ok(result.stdout.includes(`seeded: ${PARTIAL_REPAIR_COUNT} (${removedGuides.join(', ')})`), result.stdout);
    assert.match(result.stdout, new RegExp(`kept: ${ONBOARDING_FILE_COUNT - PARTIAL_REPAIR_COUNT}`));
    assert.deepEqual(guidesOf(root), CANONICAL_GUIDES);
    assertInstanceDocsMatchTemplates(root);
  });
});

test('a foreign repo-owned guide is untouched and excluded from canonical counts', () => {
  withRoot((root) => {
    run([root]);
    const extraGuide = path.join(root, DEFAULT_GUIDES_REL, 'extra.md');
    const extraContent = Buffer.from('repo-specific guide\n');
    fs.writeFileSync(extraGuide, extraContent);
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.match(result.stdout, /seeded: 0/);
    assert.match(result.stdout, new RegExp(`kept: ${ONBOARDING_FILE_COUNT}`));
    assert.deepEqual(fs.readFileSync(extraGuide), extraContent);
    const checkResult = run([root, '--check']);
    assert.equal(checkResult.status, EXIT_SUCCESS, checkResult.stderr);
    assert.match(checkResult.stdout, new RegExp(`review guides: ok \\(${CANONICAL_GUIDE_COUNT}\\)`));
    assert.match(checkResult.stdout, new RegExp(`instance docs: ok \\(${INSTANCE_DOC_COUNT}\\)`));
  });
});

test('--check requires all onboarding files, reports every missing name, and writes nothing', () => {
  withRoot((root) => {
    const result = run([root, '--check']);
    assert.equal(result.status, EXIT_INCOMPLETE);
    for (const fileName of EXPECTED_SEEDED_NAMES) {
      assert.ok(result.stderr.includes(fileName), `stderr should name ${fileName}`);
    }
    assert.equal(fs.existsSync(path.join(root, DEFAULT_INSTANCE_DOCS_REL)), false, '--check must not create .claude');
    run([root]);
    const completeResult = run([root, '--check']);
    assert.equal(completeResult.status, EXIT_SUCCESS, completeResult.stderr);
    assert.match(completeResult.stdout, new RegExp(`review guides: ok \\(${CANONICAL_GUIDE_COUNT}\\)`));
    assert.match(completeResult.stdout, new RegExp(`instance docs: ok \\(${INSTANCE_DOC_COUNT}\\)`));
  });
});

test('quality.json deep_review.guides_dir routes only the guides while docs retain their canonical path', () => {
  withRoot((root) => {
    fs.writeFileSync(
      path.join(root, 'quality.json'),
      JSON.stringify({ deep_review: { guides_dir: 'custom/guides' } }),
    );
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.deepEqual(guidesOf(root, 'custom/guides'), CANONICAL_GUIDES);
    assert.equal(fs.existsSync(path.join(root, DEFAULT_GUIDES_REL)), false, 'default guide dir must remain untouched');
    assertInstanceDocsMatchTemplates(root);
    const checkResult = run([root, '--check']);
    assert.equal(checkResult.status, EXIT_SUCCESS, checkResult.stderr);
  });
});

test('a guides_dir that escapes the root exits with usage failure and writes nothing outside', () => {
  withRoot((root) => {
    fs.writeFileSync(
      path.join(root, 'quality.json'),
      JSON.stringify({ deep_review: { guides_dir: '../out' } }),
    );
    const result = run([root]);
    assert.equal(result.status, EXIT_USAGE);
    assert.match(result.stderr, /escapes consumer-root/);
    assert.equal(fs.existsSync(path.join(path.dirname(root), 'out')), false);
    assert.equal(fs.existsSync(path.join(root, DEFAULT_INSTANCE_DOCS_REL)), false);
  });
});

test('broken quality.json fails while a manifest without deep_review uses the defaults', () => {
  withRoot((root) => {
    fs.writeFileSync(path.join(root, 'quality.json'), '{ not json');
    const brokenResult = run([root]);
    assert.equal(brokenResult.status, EXIT_USAGE);
    assert.match(brokenResult.stderr, /invalid JSON/);
  });
  withRoot((root) => {
    fs.writeFileSync(path.join(root, 'quality.json'), JSON.stringify({ version: 1 }));
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.deepEqual(guidesOf(root), CANONICAL_GUIDES);
    assertInstanceDocsMatchTemplates(root);
  });
});

test('--guides-dir overrides quality.json without relocating instance docs', () => {
  withRoot((root) => {
    fs.writeFileSync(
      path.join(root, 'quality.json'),
      JSON.stringify({ deep_review: { guides_dir: 'custom/guides' } }),
    );
    const result = run([root, '--guides-dir', 'other/dir']);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.deepEqual(guidesOf(root, 'other/dir'), CANONICAL_GUIDES);
    assert.equal(fs.existsSync(path.join(root, 'custom')), false, 'quality.json path must be ignored');
    assertInstanceDocsMatchTemplates(root);
  });
});

test('a missing or non-directory consumer root exits with usage failure', () => {
  withRoot((root) => {
    const missingResult = run([path.join(root, 'nope')]);
    assert.equal(missingResult.status, EXIT_USAGE);
    const filePath = path.join(root, 'a-file');
    fs.writeFileSync(filePath, 'x');
    const nonDirectoryResult = run([filePath]);
    assert.equal(nonDirectoryResult.status, EXIT_USAGE);
  });
});

test('seeding from an arbitrary current directory still resolves templates from the script', () => {
  withRoot((root) => {
    const otherCurrentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cwd-'));
    try {
      const result = run([root], { cwd: otherCurrentDirectory });
      assert.equal(result.status, EXIT_SUCCESS, result.stderr);
      assert.deepEqual(guidesOf(root), CANONICAL_GUIDES);
      assertInstanceDocsMatchTemplates(root);
    } finally {
      fs.rmSync(otherCurrentDirectory, { recursive: true, force: true });
    }
  });
});

test('unknown flags and a missing --guides-dir value exit with usage failure', () => {
  withRoot((root) => {
    assert.equal(run([root, '--bogus']).status, EXIT_USAGE);
    assert.equal(run([root, '--guides-dir']).status, EXIT_USAGE);
    assert.equal(run([]).status, EXIT_USAGE);
  });
});

test('an explicitly empty --guides-dir fails in both flag forms without seeding', () => {
  withRoot((root) => {
    for (const args of [
      [root, '--guides-dir', ''],
      [root, '--guides-dir='],
    ]) {
      const result = run(args);
      assert.equal(result.status, EXIT_USAGE, args.join(' '));
      assert.match(result.stderr, /non-empty/);
    }
    assert.deepEqual(guidesOf(root), []);
    assert.equal(fs.existsSync(path.join(root, DEFAULT_INSTANCE_DOCS_REL)), false);
  });
});

test('atomic seeding removes only per-destination stale temps and leaves foreign lookalikes', () => {
  withRoot((root) => {
    const guidesDirectory = path.join(root, DEFAULT_GUIDES_REL);
    fs.mkdirSync(guidesDirectory, { recursive: true });
    const staleTemp = path.join(guidesDirectory, `${canonicalGuide(0)}.tmp.${STALE_PROCESS_ID}`);
    fs.writeFileSync(staleTemp, 'truncated');
    const foreignLookalike = path.join(guidesDirectory, 'draft.md.tmp.keep');
    fs.writeFileSync(foreignLookalike, 'mine');
    const result = run([root]);
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.equal(fs.existsSync(staleTemp), false, 'stale temp must be swept');
    assert.equal(fs.readFileSync(foreignLookalike, 'utf8'), 'mine', 'foreign lookalike must remain');
    assert.deepEqual(guidesOf(root), CANONICAL_GUIDES);
    assert.equal(
      fs.readFileSync(path.join(guidesDirectory, canonicalGuide(0)), 'utf8'),
      fs.readFileSync(path.join(GUIDE_TEMPLATES_DIR, canonicalGuide(0)), 'utf8'),
      'the published guide must contain the complete template',
    );
    assertInstanceDocsMatchTemplates(root);
  });
});

test('a failing copy publishes no partial file or temp and a later seed recovers', () => {
  withRoot((root) => {
    const shimsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shim-'));
    try {
      fs.writeFileSync(path.join(shimsDirectory, 'cp'), '#!/bin/sh\necho partial > "$2"\nexit 1\n', {
        mode: 0o755,
      });
      const brokenResult = spawnSync('bash', [SCRIPT, root], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${shimsDirectory}:${process.env.PATH ?? ''}` },
      });
      assert.equal(brokenResult.status, EXIT_USAGE);
      assert.match(brokenResult.stderr, /copy failed/);
      const guidesDirectory = path.join(root, DEFAULT_GUIDES_REL);
      assert.deepEqual(guidesOf(root), [], 'a failed copy must not publish a guide');
      assert.deepEqual(
        fs.readdirSync(guidesDirectory).filter((fileName) => fileName.includes('.tmp.')),
        [],
        'a failed copy must remove its temp',
      );
      assert.deepEqual(instanceDocsOf(root), [], 'copy failure must stop before later files are published');
      const recoveryResult = run([root]);
      assert.equal(recoveryResult.status, EXIT_SUCCESS, recoveryResult.stderr);
      assert.deepEqual(guidesOf(root), CANONICAL_GUIDES);
      assertInstanceDocsMatchTemplates(root);
    } finally {
      fs.rmSync(shimsDirectory, { recursive: true, force: true });
    }
  });
});
