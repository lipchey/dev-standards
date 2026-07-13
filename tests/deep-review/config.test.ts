/* loadConfig projection defaults — specifically guidesDir: the manifest key is optional, but the
 * engine, the seeder (scripts/seed-review-guides.sh) and the skill body all document
 * `.agents/review-guides` as the default, so loadConfig must materialize it (a manifest without
 * the key must NOT reach preflight as "unconfigured"). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../deep-review/src/config.ts';

const MANIFEST_BASE = {
  version: 1,
  repo: 'fixture',
  stack: 'node-service',
  scheduler_class: 'local-only',
  budgets: { staged_seconds: 15, fast_seconds: 90, full_seconds: 300, audit_seconds: 300 },
  policy: {
    mutates_by_default: false,
    format_fix_staged_allowed: false,
    typed_eslint_in_precommit: false,
    block_new_dead_code_only: true,
  },
  paths: { reports: 'reports/quality', baselines: 'quality-baselines' },
  generated: { hooks_dir: '.githooks' },
  workspaces: [{ name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' }],
  filesets: [],
  tiers: { staged: [], fast: [], full: [], audit: [] },
};

test('deep_review without guides_dir -> loadConfig defaults to .agents/review-guides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
  try {
    const manifest = {
      ...MANIFEST_BASE,
      deep_review: { enabled: true, modes: ['review-only', 'review-and-refactor'] },
    };
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
    const config = loadConfig(join(dir, 'quality.json'));
    assert.equal(config.guidesDir, '.agents/review-guides');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deep_review with an explicit guides_dir -> loadConfig keeps it verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
  try {
    const manifest = {
      ...MANIFEST_BASE,
      deep_review: { enabled: true, modes: ['review-only'], guides_dir: 'custom/guides' },
    };
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
    const config = loadConfig(join(dir, 'quality.json'));
    assert.equal(config.guidesDir, 'custom/guides');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deep_review without verify_entry -> loadConfig defaults to verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
  try {
    const manifest = {
      ...MANIFEST_BASE,
      deep_review: { enabled: true, modes: ['review-only', 'review-and-refactor'] },
    };
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
    const config = loadConfig(join(dir, 'quality.json'));
    assert.equal(config.verifyEntry, 'verify');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deep_review with an explicit verify_entry -> loadConfig keeps it verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
  try {
    const manifest = {
      ...MANIFEST_BASE,
      deep_review: { enabled: true, modes: ['review-only'], verify_entry: 'scripts/verify' },
    };
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
    const config = loadConfig(join(dir, 'quality.json'));
    assert.equal(config.verifyEntry, 'scripts/verify');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const bad of ['/abs/verify', '../escape/verify', 'a/../../etc/verify', '..\\win\\verify', 'scripts\\verify', 'scripts/verify/']) {
  test(`verify_entry that is absolute or escapes the worktree is rejected: ${bad}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
    try {
      const manifest = {
        ...MANIFEST_BASE,
        deep_review: { enabled: true, modes: ['review-only'], verify_entry: bad },
      };
      writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
      assert.throws(() => loadConfig(join(dir, 'quality.json')), /verify_entry must be a repo-relative path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
