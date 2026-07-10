import './helpers/telemetry-off.ts'; // MUST be first: default the sink off for direct (non-npm) runs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctor } from '../../runner/src/doctor.ts';
import { reportSchedulerClass } from '../../runner/src/scheduler.ts';
import type { Manifest } from '../../runner/src/types.ts';

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    repo: 'fixture-repo',
    stack: 'node-service',
    scheduler_class: 'local-only',
    budgets: { staged_seconds: 10, fast_seconds: 60, full_seconds: 120, audit_seconds: 120 },
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
    tiers: { staged: [], fast: [], full: [] },
    ...overrides,
  };
}

function tmpRoot(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-doctor-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('all workspaces present -> ok:true and scheduler class reported', () => {
  const { root, cleanup } = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, '.githooks'));
    fs.mkdirSync(path.join(root, 'pkg'));
    const manifest = baseManifest({
      workspaces: [
        { name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' },
        { name: 'pkg', path: 'pkg', stack: 'node-service', package_manager: 'npm' },
      ],
    });

    const report = doctor(manifest, root);

    assert.equal(report.ok, true);
    assert.equal(report.messages[0], reportSchedulerClass(manifest));
    assert.equal(report.messages[0], 'repo "fixture-repo" scheduler class: local-only');
  } finally {
    cleanup();
  }
});

test('a missing workspace dir -> ok:false with a message naming it', () => {
  const { root, cleanup } = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, '.githooks'));
    const manifest = baseManifest({
      workspaces: [
        { name: 'root', path: '.', stack: 'node-service', package_manager: 'npm' },
        { name: 'svc', path: 'does-not-exist', stack: 'node-service', package_manager: 'npm' },
      ],
    });

    const report = doctor(manifest, root);

    assert.equal(report.ok, false);
    assert.ok(
      report.messages.some((m) => m.includes('does-not-exist')),
      `expected a message naming the missing workspace; got ${JSON.stringify(report.messages)}`,
    );
  } finally {
    cleanup();
  }
});

test('a missing hooks dir is advisory -> ok stays true', () => {
  const { root, cleanup } = tmpRoot();
  try {
    const manifest = baseManifest();

    const report = doctor(manifest, root);

    assert.equal(report.ok, true);
    assert.ok(
      report.messages.some((m) => m.toLowerCase().includes('hooks')),
      `expected an advisory hooks message; got ${JSON.stringify(report.messages)}`,
    );
  } finally {
    cleanup();
  }
});
