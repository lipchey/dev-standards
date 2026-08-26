/* The engine and skill share `.claude/review-guides` as the optional overlay default. */
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
  tiers: {
    staged: [],
    fast: [{ name: 'noop', argv: ['node', '--version'], timeout_seconds: 5, covers: ['.'] }],
    full: [],
    audit: [],
  },
};

test('deep_review without guides_dir -> loadConfig defaults to .claude/review-guides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
  try {
    const manifest = {
      ...MANIFEST_BASE,
      deep_review: { enabled: true, modes: ['review-only', 'review-and-refactor'] },
    };
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
    const config = loadConfig(join(dir, 'quality.json'));
    assert.equal(config.guidesDir, '.claude/review-guides');
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

test('loadConfig rejects an absolute or escaping guides_dir (R2-4)', () => {
  // An absolute/escaping guides_dir would make the fix-mode no-touch glob match nothing,
  // leaving the overlay editable; reject it at load like verify_entry / required_reads.
  for (const bad of ['/etc/guides', '../evil', '.claude/guides/', 'a/../../escape']) {
    const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
    try {
      const manifest = {
        ...MANIFEST_BASE,
        deep_review: { enabled: true, modes: ['review-only'], guides_dir: bad },
      };
      writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
      assert.throws(() => loadConfig(join(dir, 'quality.json')), /guides_dir/, `should reject ${bad}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

test('deep_review without required_reads -> loadConfig defaults to []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
  try {
    const manifest = { ...MANIFEST_BASE, deep_review: { enabled: true } };
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
    assert.deepEqual(loadConfig(join(dir, 'quality.json')).requiredReads, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deep_review with required_reads -> loadConfig keeps repo-relative entries verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
  try {
    const reads = ['.claude/CHECKLIST.md', '.claude/code-conventions.md'];
    const manifest = { ...MANIFEST_BASE, deep_review: { enabled: true, required_reads: reads } };
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
    assert.deepEqual(loadConfig(join(dir, 'quality.json')).requiredReads, reads);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const bad of ['/abs/facts.md', '../escape.md', 'a/../../etc/passwd', 'win\\facts.md', 'trailing/']) {
  test(`a required_read that is absolute or escapes the worktree is rejected: ${bad}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-config-'));
    try {
      const manifest = { ...MANIFEST_BASE, deep_review: { enabled: true, required_reads: [bad] } };
      writeFileSync(join(dir, 'quality.json'), JSON.stringify(manifest));
      assert.throws(() => loadConfig(join(dir, 'quality.json')), /required_reads must be a repo-relative path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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
