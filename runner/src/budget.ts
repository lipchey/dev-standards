export function assertWithinBudget(startedAtMs: number, budgetSeconds: number): void {
  const elapsedMs = Date.now() - startedAtMs;
  const budgetMs = budgetSeconds * 1000;
  if (elapsedMs > budgetMs) {
    const overrunMs = elapsedMs - budgetMs;
    throw new Error(
      `Runtime budget exceeded: elapsed ${elapsedMs}ms over the ${budgetSeconds}s tier budget by ${overrunMs}ms.`,
    );
  }
}
