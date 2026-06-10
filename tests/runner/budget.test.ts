import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWithinBudget } from '../../runner/src/budget.ts';

test('assertWithinBudget throws when elapsed exceeds the budget', () => {
  assert.throws(() => assertWithinBudget(Date.now() - 10_000, 1), /budget/i);
});

test('assertWithinBudget returns normally when within the budget', () => {
  assert.doesNotThrow(() => assertWithinBudget(Date.now(), 300));
});
