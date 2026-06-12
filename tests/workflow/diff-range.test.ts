import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRangeForPhase } from '../../workflow/src/diff-range.ts';
import type { FrontMatter } from '../../workflow/src/types.ts';

function fm(overrides: Partial<FrontMatter> = {}): FrontMatter {
  return {
    feature: 'demo',
    branch: 'feature/demo',
    worktree: '/tmp/worktrees/demo',
    base: 'main',
    base_sha: 'b'.repeat(40),
    cmux_section: 'demo',
    state: 'implemented',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: 'pane',
    updated: '2026-06-12T00:00:00Z',
    phases: {},
    budget_spent: { total_seconds: 0 },
    ...overrides,
  };
}

test('argv-safe-range-with-mandatory-exclusions', () => {
  const result = diffRangeForPhase('review-implementation', fm(), {
    planningFile: 'workflow-session-planning.md',
    reportsGlob: 'reports/**',
    commitExclude: ['*.log', '.DS_Store'],
  });

  assert.deepEqual(result.argv, [
    'diff',
    '--name-only',
    'b'.repeat(40) + '..HEAD',
    '--',
    '.',
    ':(exclude)workflow-session-planning.md',
    ':(exclude)reports/**',
    ':(exclude)*.log',
    ':(exclude).DS_Store',
  ]);
});

test('review-impl-spans-base-sha-to-head-current-loop-first', () => {
  const result = diffRangeForPhase('review-implementation', fm({
    loopback_count: 0,
    phases: {
      'implement-plan': {
        last_success_loop: 0,
        attempts: 1,
        start_sha: 's'.repeat(40),
        complete_sha: 'c'.repeat(40),
      },
    },
  }));

  assert.equal(result.range, `${'b'.repeat(40)}..HEAD`);
});

test('two-attempt-loopback-includes-both-impl-commits-excludes-planning', () => {
  const result = diffRangeForPhase('review-implementation', fm({
    loopback_count: 1,
    phases: {
      'implement-plan': {
        last_success_loop: 1,
        attempts: 2,
        start_sha: 's'.repeat(40),
        complete_sha: 'c'.repeat(40),
      },
    },
  }), { planningFile: 'plan.md', reportsGlob: 'reports/**', commitExclude: [] });

  assert.equal(result.range, `${'b'.repeat(40)}..HEAD`);
  assert.ok(result.argv.includes(':(exclude)plan.md'));
});

