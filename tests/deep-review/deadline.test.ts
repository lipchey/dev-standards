// §0 Deadline — the single monotonic run budget. remainingMs decreases toward 0 (never negative),
// checkpoint throws once the budget is spent, and a zero-second budget is immediately exceeded.
// Time is process.hrtime.bigint (monotonic), so these use a real short sleep, not a wall clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeadline, DeadlineExceededError } from '../../deep-review/src/deadline.ts';

test('remainingMs starts within the budget and never exceeds it', () => {
  const d = createDeadline(10);
  const remaining = d.remainingMs();
  assert.ok(remaining > 0, 'a fresh 10s deadline has time left');
  assert.ok(remaining <= 10_000, 'never reports more than the budget');
});

test('remainingMs decreases monotonically as time passes', async () => {
  const d = createDeadline(10);
  const first = d.remainingMs();
  await delay(30);
  const second = d.remainingMs();
  assert.ok(second < first, `remaining should shrink: ${first} -> ${second}`);
});

test('checkpoint does not throw while budget remains', () => {
  const d = createDeadline(10);
  assert.doesNotThrow(() => d.checkpoint('mid-run'));
});

test('a zero-second budget is immediately exhausted: remainingMs 0, checkpoint throws', () => {
  const d = createDeadline(0);
  assert.equal(d.remainingMs(), 0);
  assert.throws(() => d.checkpoint('start'), DeadlineExceededError);
});

test('an exhausted deadline throws DeadlineExceededError naming the label', async () => {
  const d = createDeadline(0.01); // 10ms
  await delay(30);
  assert.equal(d.remainingMs(), 0, 'floored at 0, never negative');
  assert.throws(
    () => d.checkpoint('after-spawn'),
    (error: unknown) => error instanceof DeadlineExceededError && /after-spawn/.test((error as Error).message),
  );
});
