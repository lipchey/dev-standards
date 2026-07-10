// `now` defaults to the wall clock but callers on a monotonic deadline
// (verify-runner) inject performance.now() so a wall-clock jump can't move the budget.
export function assertWithinBudget(
  startedAtMs: number,
  budgetSeconds: number,
  now: () => number = Date.now,
): void {
  const elapsedMs = now() - startedAtMs;
  const budgetMs = budgetSeconds * 1000;
  if (elapsedMs > budgetMs) {
    const overrunMs = elapsedMs - budgetMs;
    throw new Error(
      `Runtime budget exceeded: elapsed ${elapsedMs}ms over the ${budgetSeconds}s tier budget by ${overrunMs}ms.`,
    );
  }
}
