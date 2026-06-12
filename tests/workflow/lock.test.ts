import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT_LOCK_BUSY } from '../../workflow/src/types.ts';
import {
  acquire,
  claimStale,
  LockBusyError,
  lockPathFor,
  readLockInfo,
  release,
  withLock,
} from '../../workflow/src/lock.ts';
import type { LockInfo, LockSeams } from '../../workflow/src/lock.ts';

// Each test gets its own throwaway worktree dir under os.tmpdir(); the lock and
// any steal tokens live inside it and are removed wholesale on cleanup.
function makeWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-lock-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Deterministic injected seams: a fake clock/sleep so the ~5s bound is reached in
// zero real time, a fake PID-liveness oracle, and fixed identity. Tests override
// only the seams they exercise (the gate-test makeDeps pattern). Real fs is NOT
// mocked — the concurrency tests exercise real fs.open(wx)/rename atomicity.
function makeSeams(overrides: Partial<LockSeams> = {}): LockSeams {
  return {
    now: () => 0,
    sleep: () => {},
    isPidAlive: () => true,
    pid: 4242,
    hostname: 'test-host',
    warn: () => {},
    ...overrides,
  };
}

test('exclusive-create-wins-once', () => {
  const dir = makeWorktree();
  const lockPath = lockPathFor(dir);
  let clock = 0;
  const seams = makeSeams({
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
    },
    isPidAlive: () => true, // a live holder is never stealable
    pid: 321,
  });
  try {
    // Exactly one acquisition creates the exclusive lock.
    const first = acquire(dir, seams);
    assert.ok(first, 'the first acquisition wins the exclusive create');
    assert.ok(fs.existsSync(lockPath));

    // The second acquisition, contending for the held lock, gets LOCK_BUSY and
    // its critical section never runs.
    assert.throws(
      () =>
        withLock(dir, seams, () => {
          assert.fail('the critical section must not run while the lock is busy');
        }),
      (err: unknown) => err instanceof LockBusyError && err.exitCode === EXIT_LOCK_BUSY,
    );

    release(first);
    assert.ok(!fs.existsSync(lockPath), 'release removes the lockfile');
  } finally {
    cleanup(dir);
  }
});

test('bounded-retry-then-busy', () => {
  const dir = makeWorktree();
  let clock = 0;
  let sleeps = 0;
  const seams = makeSeams({
    now: () => clock,
    sleep: (ms) => {
      sleeps += 1;
      clock += ms; // advance the fake clock toward the retry bound
    },
    isPidAlive: () => true, // holder alive -> never stale -> pure retry path
    pid: 11,
  });
  try {
    const held = acquire(dir, seams);
    assert.ok(held, 'the holder takes the lock first');

    sleeps = 0; // count only the contended acquisition's retries
    const busy = acquire(dir, seams);
    assert.equal(busy, null, 'a contended acquisition returns LOCK_BUSY after the bound');
    assert.ok(sleeps > 1, 'it retried with backoff before giving up');
    assert.ok(sleeps <= 100, 'retries are bounded (~5s / 100ms), not unbounded');

    release(held);
  } finally {
    cleanup(dir);
  }
});

test('stale-dead-pid-removed', () => {
  const dir = makeWorktree();
  const lockPath = lockPathFor(dir);
  const NOW = 100_000;
  // A lock whose PID is dead AND acquired > 30s ago: both stale conditions met.
  const old: LockInfo = {
    pid: 4242,
    hostname: 'gone',
    acquired_at: new Date(NOW - 31_000).toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(old));
  const warnings: string[] = [];
  const seams = makeSeams({
    now: () => NOW,
    isPidAlive: () => false, // dead
    pid: 7,
    warn: (m) => warnings.push(m),
  });
  try {
    const handle = acquire(dir, seams);
    assert.ok(handle, 'a stale lock is reclaimed and acquisition succeeds');
    assert.equal(handle.info.pid, 7, 'the fresh lock is owned by us');
    assert.equal(warnings.length, 1, 'the steal is recorded as a warning');
    assert.equal(readLockInfo(lockPath)?.pid, 7, 'the on-disk lock is now ours');

    release(handle);
    assert.ok(!fs.existsSync(lockPath));
  } finally {
    cleanup(dir);
  }
});

test('fresh-lock-not-stolen', () => {
  // (a) A live PID is never stolen, even when the lock is old.
  const dirA = makeWorktree();
  const lockA = lockPathFor(dirA);
  fs.writeFileSync(
    lockA,
    JSON.stringify({ pid: 5555, hostname: 'host', acquired_at: new Date(0).toISOString() }),
  );
  let clockA = 0;
  const warnA: string[] = [];
  const seamsA = makeSeams({
    now: () => clockA,
    sleep: (ms) => {
      clockA += ms;
    },
    isPidAlive: () => true, // alive -> not stale regardless of age
    warn: (m) => warnA.push(m),
  });
  try {
    assert.equal(acquire(dirA, seamsA), null, 'a live-pid lock is not stolen -> LOCK_BUSY');
    assert.equal(warnA.length, 0, 'no steal warning for a live lock');
    assert.equal(readLockInfo(lockA)?.pid, 5555, 'the live lock is left untouched');
  } finally {
    cleanup(dirA);
  }

  // (b) A dead PID that is YOUNGER than the threshold is not stolen either.
  const dirB = makeWorktree();
  const lockB = lockPathFor(dirB);
  const NOW = 50_000;
  fs.writeFileSync(
    lockB,
    JSON.stringify({
      pid: 6666,
      hostname: 'host',
      acquired_at: new Date(NOW - 5_000).toISOString(), // 5s old, under the 30s threshold
    }),
  );
  let clockB = NOW;
  const warnB: string[] = [];
  const seamsB = makeSeams({
    now: () => clockB,
    sleep: (ms) => {
      clockB += ms;
    },
    isPidAlive: () => false, // dead, but the lock is too young to be stale
    warn: (m) => warnB.push(m),
  });
  try {
    assert.equal(acquire(dirB, seamsB), null, 'a young lock is not stolen even with a dead PID');
    assert.equal(warnB.length, 0, 'no steal warning for a young lock');
    assert.equal(readLockInfo(lockB)?.pid, 6666, 'the young lock is left untouched');
  } finally {
    cleanup(dirB);
  }
});

test('two-racers-steal-one-wins', () => {
  const dir = makeWorktree();
  const lockPath = lockPathFor(dir);
  // A stale lock both racers will observe identically.
  const stale: LockInfo = {
    pid: 999_001,
    hostname: 'old',
    acquired_at: new Date(0).toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(stale));
  const observed = readLockInfo(lockPath);
  assert.ok(observed, 'both racers observe the same stale lock');

  try {
    // Both racers race on the atomic rename of the SAME source path. The winner's
    // rename moves the source away; the loser's rename of the now-missing source
    // throws ENOENT, so exactly one steal claim succeeds (real fs.renameSync
    // atomicity, driven deterministically — no wall-clock timing).
    const tokenA = claimStale(lockPath, observed, makeSeams({ pid: 1001 }));
    const tokenB = claimStale(lockPath, observed, makeSeams({ pid: 1002 }));
    const winners = [tokenA, tokenB].filter((t) => t !== null);
    assert.equal(winners.length, 1, 'exactly one racer wins the atomic rename steal');
  } finally {
    cleanup(dir);
  }
});

test('release-on-success-and-throw', () => {
  // Success path: the critical section runs, its value is returned, lock released.
  const dirOk = makeWorktree();
  const lockOk = lockPathFor(dirOk);
  try {
    const value = withLock(dirOk, makeSeams(), () => {
      assert.ok(fs.existsSync(lockOk), 'the lock is held inside the critical section');
      return 'result';
    });
    assert.equal(value, 'result');
    assert.ok(!fs.existsSync(lockOk), 'the lock is released on success');
  } finally {
    cleanup(dirOk);
  }

  // Throw path: the error propagates AND the lock is still released (finally).
  const dirThrow = makeWorktree();
  const lockThrow = lockPathFor(dirThrow);
  try {
    assert.throws(
      () =>
        withLock(dirThrow, makeSeams(), () => {
          assert.ok(fs.existsSync(lockThrow), 'the lock is held when the section throws');
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.ok(!fs.existsSync(lockThrow), 'the lock is released even when the section throws');
  } finally {
    cleanup(dirThrow);
  }
});
