import test from 'node:test';
import assert from 'node:assert/strict';
import { expandFileset, filesetByName } from '../../runner/src/filesets.ts';
import type { FilesetContext } from '../../runner/src/filesets.ts';
import type { Fileset, Manifest } from '../../runner/src/types.ts';

/** A repo_all fileset; the include/exclude vary per test. */
function repoAll(overrides: Partial<Fileset> = {}): Fileset {
  return { name: 'fs', source: 'repo_all', include: ['**/*.ts'], ...overrides };
}

/** A git_staged fileset; the include/exclude vary per test. */
function gitStaged(overrides: Partial<Fileset> = {}): Fileset {
  return { name: 'fs', source: 'git_staged', include: ['**/*.ts'], ...overrides };
}

/** A context whose trackedFiles/stagedFiles return fixed lists (never hits git). */
function fakeContext(files: {
  tracked?: string[];
  staged?: string[];
}): FilesetContext {
  return {
    cwd: '/repo',
    trackedFiles: () => files.tracked ?? [],
    stagedFiles: () => files.staged ?? [],
  };
}

test('repo_all include filters tracked files', () => {
  const context = fakeContext({ tracked: ['src/a.ts', 'README.md', 'src/b.ts'] });
  const result = expandFileset(repoAll({ include: ['**/*.ts'] }), context);
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('exclude removes matching files', () => {
  const context = fakeContext({ tracked: ['src/a.ts', 'src/a.test.ts', 'src/b.ts'] });
  const result = expandFileset(
    repoAll({ include: ['**/*.ts'], exclude: ['**/*.test.ts'] }),
    context,
  );
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('git_staged uses staged source and default ACMR diff filter', () => {
  let seenDiffFilter: string | undefined = 'NOT_CALLED';
  const context: FilesetContext = {
    cwd: '/repo',
    trackedFiles: () => {
      throw new Error('repo_all source must not be consulted for a git_staged fileset');
    },
    stagedFiles: (diffFilter?: string) => {
      seenDiffFilter = diffFilter;
      return ['src/staged.ts', 'docs/skip.md'];
    },
  };
  const result = expandFileset(gitStaged({ include: ['**/*.ts'] }), context);
  assert.deepEqual(result, ['src/staged.ts']);
  // No diff_filter on the fileset -> the helper's ACMR default must be requested.
  assert.equal(seenDiffFilter, 'ACMR');
});

test('git_staged forwards an explicit diff_filter', () => {
  let seenDiffFilter: string | undefined = 'NOT_CALLED';
  const context: FilesetContext = {
    cwd: '/repo',
    stagedFiles: (diffFilter?: string) => {
      seenDiffFilter = diffFilter;
      return ['src/staged.ts'];
    },
  };
  expandFileset(gitStaged({ include: ['**/*.ts'], diff_filter: 'AM' }), context);
  assert.equal(seenDiffFilter, 'AM');
});

test('empty fileset returns []', () => {
  const context = fakeContext({ tracked: [] });
  const result = expandFileset(repoAll({ include: ['**/*.ts'] }), context);
  assert.deepEqual(result, []);
});

test('filesetByName returns the declared fileset or undefined', () => {
  const manifest = {
    filesets: [repoAll({ name: 'ts' }), gitStaged({ name: 'staged_ts' })],
  } as unknown as Manifest;
  assert.equal(filesetByName(manifest, 'staged_ts')?.name, 'staged_ts');
  assert.equal(filesetByName(manifest, 'missing'), undefined);
});
