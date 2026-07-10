// The single monotonic deadline for a deep-review run (Phase 5 §0). cli.ts builds ONE from
// `deep_review.budget.seconds` (default 900) and threads it down; every git / test / scan spawn
// takes `timeout = min(own cap, deadline.remainingMs())`, and each verb `checkpoint`s after a
// spawn so an already-exhausted budget aborts BEFORE the next irreversible step. There is no
// global state — the deadline is passed as a parameter, so a test can create its own.
//
// Time is read from `process.hrtime.bigint()` (monotonic, immune to wall-clock jumps), never
// Date.now(): a wall-clock adjustment mid-run must not extend or collapse the budget.
//
// §F7 note: the handoff/descriptor read paths take a `timeout` from this deadline to bound their
// git spawns, but DELIBERATELY do NOT `checkpoint()` (no EXIT_DEADLINE) — an exhausted budget there
// surfaces as an ordinary operational/timeout failure of the spawn, not a distinct deadline exit.

export class DeadlineExceededError extends Error {
  constructor(label: string) {
    super(`deep-review deadline exceeded at ${label}`);
    this.name = 'DeadlineExceededError';
    Object.setPrototypeOf(this, DeadlineExceededError.prototype);
  }
}

export interface Deadline {
  // Milliseconds left in the budget, floored at 0 (never negative). Rounds down: the final
  // sub-millisecond is reported as 0, so a spawn is never handed a `timeout` of a fractional ms.
  remainingMs(): number;
  // Throws DeadlineExceededError iff the budget is fully spent. `label` names the step for the
  // surfaced message.
  checkpoint(label: string): void;
}

const NS_PER_MS = 1_000_000n;

export function createDeadline(seconds: number): Deadline {
  const budgetNs = BigInt(Math.max(0, Math.round(seconds * 1000))) * NS_PER_MS;
  const start = process.hrtime.bigint();
  const remainingNs = (): bigint => budgetNs - (process.hrtime.bigint() - start);
  return {
    remainingMs(): number {
      const remaining = remainingNs();
      return remaining <= 0n ? 0 : Number(remaining / NS_PER_MS);
    },
    checkpoint(label: string): void {
      if (remainingNs() <= 0n) throw new DeadlineExceededError(label);
    },
  };
}
