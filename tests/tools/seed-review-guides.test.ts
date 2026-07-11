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
const TEMPLATES_DIR = path.join(REPO_ROOT, 'agents', 'review-guide-templates');

// Canonical set is derived from the templates dir — never hardcode "7".
const CANON = fs
  .readdirSync(TEMPLATES_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();
const CANON_COUNT = CANON.length;

function canon(i: number): string {
  const n = CANON[i];
  if (n === undefined) throw new Error(`fewer than ${i + 1} canonical guides in ${TEMPLATES_DIR}`);
  return n;
}

type Run = { status: number | null; stdout: string; stderr: string };

function run(args: string[], opts: { cwd?: string } = {}): Run {
  const res = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', cwd: opts.cwd });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function withRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-seed-'));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function guidesOf(root: string, rel = '.agents/review-guides'): string[] {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

test('1. fresh seed (no quality.json): copies the whole canonical set, exit 0', () => {
  withRoot((root) => {
    const res = run([root]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(guidesOf(root), CANON);
    assert.match(res.stdout, new RegExp(`seeded: ${CANON_COUNT} \\(`));
    // deterministic (sorted) name list
    assert.ok(res.stdout.includes(`seeded: ${CANON_COUNT} (${CANON.join(', ')})`), res.stdout);
    assert.match(res.stdout, /kept: 0/);
  });
});

test('2. re-run is idempotent: seeded 0, kept all, content unchanged', () => {
  withRoot((root) => {
    run([root]);
    const first = CANON.map((n) => fs.readFileSync(path.join(root, '.agents/review-guides', n)));
    const res = run([root]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /seeded: 0/);
    assert.match(res.stdout, new RegExp(`kept: ${CANON_COUNT}`));
    const second = CANON.map((n) => fs.readFileSync(path.join(root, '.agents/review-guides', n)));
    CANON.forEach((_, i) => assert.deepEqual(second[i], first[i]));
  });
});

test('3. an existing file with changed content is preserved byte-for-byte', () => {
  withRoot((root) => {
    run([root]);
    const target = path.join(root, '.agents/review-guides', canon(0));
    const edited = Buffer.from('REPO OWNS THIS BODY\n');
    fs.writeFileSync(target, edited);
    const res = run([root]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(fs.readFileSync(target), edited);
  });
});

test('4. partial repair: delete 2, re-seed adds exactly those 2 and keeps the rest', () => {
  withRoot((root) => {
    run([root]);
    const gone = [canon(0), canon(1)];
    for (const n of gone) fs.rmSync(path.join(root, '.agents/review-guides', n));
    const res = run([root]);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes(`seeded: 2 (${gone.join(', ')})`), res.stdout);
    assert.match(res.stdout, new RegExp(`kept: ${CANON_COUNT - 2}`));
    assert.deepEqual(guidesOf(root), CANON);
  });
});

test('5. a foreign repo-owned guide is left untouched and not counted as canonical', () => {
  withRoot((root) => {
    run([root]);
    const extra = path.join(root, '.agents/review-guides', 'extra.md');
    const body = Buffer.from('repo-specific guide\n');
    fs.writeFileSync(extra, body);
    const res = run([root]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /seeded: 0/);
    assert.match(res.stdout, new RegExp(`kept: ${CANON_COUNT}`)); // extra.md not counted
    assert.deepEqual(fs.readFileSync(extra), body);
    const check = run([root, '--check']);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, new RegExp(`review guides: ok \\(${CANON_COUNT}\\)`));
  });
});

test('6. --check on an unseeded root: exit 1, names the missing, creates no dir; ok after seed', () => {
  withRoot((root) => {
    const res = run([root, '--check']);
    assert.equal(res.status, 1);
    for (const n of CANON) assert.ok(res.stderr.includes(n), `stderr should name ${n}`);
    assert.equal(fs.existsSync(path.join(root, '.agents/review-guides')), false, 'no dir in --check');
    run([root]);
    const ok = run([root, '--check']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`review guides: ok \\(${CANON_COUNT}\\)`));
  });
});

test('7. quality.json deep_review.guides_dir routes seeding + --check to that dir', () => {
  withRoot((root) => {
    fs.writeFileSync(
      path.join(root, 'quality.json'),
      JSON.stringify({ deep_review: { guides_dir: 'custom/guides' } }),
    );
    const res = run([root]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(guidesOf(root, 'custom/guides'), CANON);
    assert.equal(fs.existsSync(path.join(root, '.agents')), false, 'default dir untouched');
    const check = run([root, '--check']);
    assert.equal(check.status, 0, check.stderr);
  });
});

test('8. quality.json guides_dir that escapes the root exits 2 and writes nothing outside', () => {
  withRoot((root) => {
    fs.writeFileSync(
      path.join(root, 'quality.json'),
      JSON.stringify({ deep_review: { guides_dir: '../out' } }),
    );
    const res = run([root]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /escapes consumer-root/);
    assert.equal(fs.existsSync(path.join(path.dirname(root), 'out')), false);
  });
});

test('9. broken quality.json exits 2; a quality.json without deep_review falls back to default', () => {
  withRoot((root) => {
    fs.writeFileSync(path.join(root, 'quality.json'), '{ not json');
    const broken = run([root]);
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /invalid JSON/);
  });
  withRoot((root) => {
    fs.writeFileSync(path.join(root, 'quality.json'), JSON.stringify({ version: 1 }));
    const res = run([root]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(guidesOf(root), CANON);
  });
});

test('10. --guides-dir override wins and quality.json is ignored', () => {
  withRoot((root) => {
    fs.writeFileSync(
      path.join(root, 'quality.json'),
      JSON.stringify({ deep_review: { guides_dir: 'custom/guides' } }),
    );
    const res = run([root, '--guides-dir', 'other/dir']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(guidesOf(root, 'other/dir'), CANON);
    assert.equal(fs.existsSync(path.join(root, 'custom')), false, 'quality.json path ignored');
  });
});

test('11. a missing or non-directory consumer-root exits 2', () => {
  withRoot((root) => {
    const missing = run([path.join(root, 'nope')]);
    assert.equal(missing.status, 2);
    const file = path.join(root, 'afile');
    fs.writeFileSync(file, 'x');
    const notDir = run([file]);
    assert.equal(notDir.status, 2);
  });
});

test('12. runs from an arbitrary cwd (templates resolve from script dir, not cwd)', () => {
  withRoot((root) => {
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cwd-'));
    try {
      const res = run([root], { cwd: otherCwd });
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(guidesOf(root), CANON);
    } finally {
      fs.rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});

test('unknown flag / missing --guides-dir value exit 2', () => {
  withRoot((root) => {
    assert.equal(run([root, '--bogus']).status, 2);
    assert.equal(run([root, '--guides-dir']).status, 2);
    assert.equal(run([]).status, 2); // no consumer-root
  });
});

test('an explicit-but-EMPTY --guides-dir exits 2 in both flag forms (never a silent default)', () => {
  withRoot((root) => {
    for (const args of [
      [root, '--guides-dir', ''],
      [root, '--guides-dir='],
    ]) {
      const res = run(args);
      assert.equal(res.status, 2, args.join(' '));
      assert.match(res.stderr, /non-empty/);
    }
    assert.deepEqual(guidesOf(root), []); // nothing seeded anywhere
  });
});

test('seeding copies via temp+rename and leaves no temp residue; a stale temp is swept, foreign *.md.tmp.* names survive', () => {
  withRoot((root) => {
    const dir = path.join(root, '.agents/review-guides');
    fs.mkdirSync(dir, { recursive: true });
    /* Simulate a previously interrupted copy: temp present, destination absent. */
    const stale = path.join(dir, `${canon(0)}.tmp.99999`);
    fs.writeFileSync(stale, 'truncated');
    /* A user file that merely LOOKS like a temp must not be swept (per-name namespace only). */
    const foreign = path.join(dir, 'draft.md.tmp.keep');
    fs.writeFileSync(foreign, 'mine');
    const res = run([root]);
    assert.equal(res.status, 0);
    assert.equal(fs.existsSync(stale), false, 'stale temp swept');
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'mine', 'foreign temp-lookalike untouched');
    assert.deepEqual(guidesOf(root), CANON); // full set, no temp names counted or left behind
    assert.equal(
      fs.readFileSync(path.join(dir, canon(0)), 'utf8'),
      fs.readFileSync(path.join(TEMPLATES_DIR, canon(0)), 'utf8'),
      'the guide whose temp was stale is a complete copy, not the truncated leftover',
    );
  });
});

test('a failing cp leaves NO destination and NO temp residue (exit 2); a rerun with a working cp recovers', () => {
  withRoot((root) => {
    /* PATH-shim a cp that writes partial data and fails — the interrupted-copy scenario. */
    const shims = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shim-'));
    try {
      fs.writeFileSync(path.join(shims, 'cp'), '#!/bin/sh\necho partial > "$2"\nexit 1\n', { mode: 0o755 });
      const broken = spawnSync('bash', [SCRIPT, root], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` },
      });
      assert.equal(broken.status, 2);
      assert.match(broken.stderr, /copy failed/);
      const dir = path.join(root, '.agents/review-guides');
      assert.deepEqual(guidesOf(root), [], 'no guide published from a failed copy');
      assert.deepEqual(
        fs.readdirSync(dir).filter((n) => n.includes('.tmp.')),
        [],
        'failed copy cleans its temp',
      );
      const rerun = run([root]);
      assert.equal(rerun.status, 0);
      assert.deepEqual(guidesOf(root), CANON);
    } finally {
      fs.rmSync(shims, { recursive: true, force: true });
    }
  });
});
