import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addOrReplaceFeatureRecord,
  defaultFeatureBranch,
  defaultFeatureWorktree,
  readFeatureRecords,
  writeFeatureRecords,
} from '../../workflow/src/feature-record.ts';
import { parseSubset, serializeSubset } from '../../workflow/src/front-matter.ts';

const stateText = [
  '---',
  'phase: "3"',
  'phase_status: "in_progress"',
  'note: "uses\\u0020noncanonical\\u0020escapes"',
  'features:',
  '  - slug: "old"',
  '    branch: "feature/old"',
  '    worktree: ""',
  '    pr: 0',
  '    review_state: "building"',
  '---',
  '',
  '# Handoff State',
  '',
].join('\n');

const frontMatterOnly = stateText.slice(0, stateText.indexOf('# Handoff State'));
const serializedFrontMatter = frontMatterOnly.replace(/\n\n$/, '\n');

test('feature-records-read-and-write-state-front-matter', () => {
  const doc = parseSubset(frontMatterOnly);
  const records = readFeatureRecords(doc);
  assert.deepEqual(records, [
    { slug: 'old', branch: 'feature/old', worktree: '', pr: 0, review_state: 'building' },
  ]);

  const next = addOrReplaceFeatureRecord(records, {
    slug: 'new-thing',
    branch: defaultFeatureBranch('new-thing'),
    worktree: defaultFeatureWorktree('/tmp/worktrees', 'new-thing'),
    pr: 0,
    review_state: 'building',
  });
  writeFeatureRecords(doc, next);

  assert.deepEqual(readFeatureRecords(doc), [
    { slug: 'old', branch: 'feature/old', worktree: '', pr: 0, review_state: 'building' },
    {
      slug: 'new-thing',
      branch: 'feature/new-thing',
      worktree: '/tmp/worktrees/new-thing',
      pr: 0,
      review_state: 'building',
    },
  ]);
});

test('state-md-roundtrip-preserves-unrelated-keys-byte-stable', () => {
  const doc = parseSubset(frontMatterOnly);
  writeFeatureRecords(doc, readFeatureRecords(doc));
  assert.equal(
    serializeSubset(doc),
    serializedFrontMatter,
    'unchanged unrelated front-matter keys preserve their original scalar tokens',
  );
});

test('feature-record-collision-aborts', () => {
  const records = readFeatureRecords(parseSubset(frontMatterOnly));
  assert.throws(
    () => addOrReplaceFeatureRecord(records, {
      slug: 'old',
      branch: 'feature/old-2',
      worktree: '',
      pr: 0,
      review_state: 'building',
    }),
    /feature record already exists/,
  );
});
