import path from 'node:path';
import type { FeatureRecord } from './types.ts';
import type { SubsetMap, SubsetNode, SubsetScalar, SubsetSeq } from './front-matter.ts';
import { CorruptStateError } from './front-matter.ts';

const REVIEW_STATES = new Set(['', 'building', 'awaiting_human_review', 'processing_review', 'ci_failed', 'done']);

function corrupt(message: string): CorruptStateError {
  return new CorruptStateError('bad-feature-record', message);
}

function scalarString(value: string): SubsetScalar {
  const ctrl = controlCharIndex(value);
  if (ctrl >= 0) {
    throw corrupt(`string scalar contains a control character (code ${value.charCodeAt(ctrl)}) at index ${ctrl}`);
  }
  return { kind: 'string', value };
}

function controlCharIndex(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return i;
  }
  return -1;
}

function scalarInt(value: number): SubsetScalar {
  return { kind: 'int', value };
}

function mapOf(item: { entries: Array<[string, SubsetScalar]> }): Map<string, SubsetScalar> {
  return new Map(item.entries);
}

function needString(map: Map<string, SubsetScalar>, key: string): string {
  const node = map.get(key);
  if (node?.kind !== 'string') throw corrupt(`features[].${key} must be a quoted string`);
  return node.value;
}

function needInt(map: Map<string, SubsetScalar>, key: string): number {
  const node = map.get(key);
  if (node?.kind !== 'int') throw corrupt(`features[].${key} must be an integer`);
  return node.value;
}

function featureNode(doc: SubsetMap): SubsetNode | undefined {
  return doc.entries.find(([key]) => key === 'features')?.[1];
}

export function readFeatureRecords(doc: SubsetMap): FeatureRecord[] {
  const node = featureNode(doc);
  if (node === undefined) return [];
  if (node.kind !== 'seq') throw corrupt('features must be a block sequence');
  return node.items.map((item) => {
    const map = mapOf(item);
    const record: FeatureRecord = {
      slug: needString(map, 'slug'),
      branch: needString(map, 'branch'),
      worktree: needString(map, 'worktree'),
      pr: needInt(map, 'pr'),
      review_state: needString(map, 'review_state') as FeatureRecord['review_state'],
    };
    if (record.pr < 0) throw corrupt('features[].pr must be non-negative');
    if (!REVIEW_STATES.has(record.review_state)) {
      throw corrupt(`features[].review_state is invalid: ${record.review_state}`);
    }
    return record;
  });
}

export function writeFeatureRecords(doc: SubsetMap, records: FeatureRecord[]): void {
  const seq: SubsetSeq = {
    kind: 'seq',
    items: records.map((record) => ({
      kind: 'map',
      entries: [
        ['slug', scalarString(record.slug)],
        ['branch', scalarString(record.branch)],
        ['worktree', scalarString(record.worktree)],
        ['pr', scalarInt(record.pr)],
        ['review_state', scalarString(record.review_state)],
      ],
    })),
  };
  const idx = doc.entries.findIndex(([key]) => key === 'features');
  if (idx >= 0) doc.entries[idx] = ['features', seq];
  else doc.entries.push(['features', seq]);
}

export function addOrReplaceFeatureRecord(records: FeatureRecord[], record: FeatureRecord): FeatureRecord[] {
  if (records.some((existing) => existing.slug === record.slug)) {
    throw new Error(`feature record already exists for slug "${record.slug}"`);
  }
  if (records.some((existing) => existing.branch === record.branch)) {
    throw new Error(`feature record already exists for branch "${record.branch}"`);
  }
  if (record.worktree !== '' && records.some((existing) => existing.worktree === record.worktree)) {
    throw new Error(`feature record already exists for worktree "${record.worktree}"`);
  }
  return [...records, record];
}

export function defaultFeatureBranch(slug: string): string {
  return `feature/${slug}`;
}

export function defaultFeatureWorktree(parent: string, slug: string): string {
  return path.join(parent, slug);
}
