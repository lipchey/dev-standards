// §2.10 Lock protocol — the workflow mutex (ADR-006 zero-dep).
//
// macOS ships no flock(1) and Node core exposes no flock(2), so the lock is an
// exclusive-create lockfile at `<worktree>/.workflow.lock`, created via
// fs.open(path, 'wx'). Content is JSON `{ pid, hostname, acquired_at }`
// (acquired_at = ISO-8601 UTC).
//
// This is an EDGE module: it performs the REAL fs operations whose OS-level
// atomicity IS the mutex — fs.openSync(path,'wx') (exclusive create) and
// fs.renameSync (atomic move) are the primitives, not reimplemented in JS. The
// non-fs, non-deterministic seams are INJECTED (LockSeams) so the concurrency
// behaviour is unit-testable in zero real time: `now` (ms epoch), `sleep`
// (backoff), `isPidAlive` (PID-liveness oracle), the identity providers `pid` /
// `hostname`, and a `warn` sink for the stale-steal record. `realLockSeams()`
// wires the real implementations for the runner edge.
//
// Protocol (§2.10):
//   - Acquire = fs.open(path,'wx'). EEXIST means a holder; bounded retry up to
//     ~RETRY_BUDGET_MS with BACKOFF_MS backoff, then LOCK_BUSY.
//   - STALE = the holder's PID is not alive (process.kill(pid,0) throws ESRCH)
//     AND the lock is older than STALE_AGE_MS. BOTH conditions are required.
//   - A stale lock is stolen ATOMICALLY and at most ONCE: rename it to a unique
//     token (the loser's rename of the now-missing source throws ENOENT), verify
//     the renamed content still matches what we observed, drop it, then wx-create
//     a fresh lock. The steal is recorded as a warning.
//   - Reads take no lock. `claimed_by` ownership is a caller concern done INSIDE
//     the lock; it is NOT part of this mutex.
//
// LOCK_BUSY is surfaced via the frozen EXIT_LOCK_BUSY (§2.7) carried on
// LockBusyError — no new exit code is invented.

import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EXIT_LOCK_BUSY } from './types.ts';

// Lockfile name, joined onto the worktree root (§2.10).
const LOCK_FILE_NAME = '.workflow.lock';
// Bounded-retry budget (~5s) and backoff between polls (§2.10).
const RETRY_BUDGET_MS = 5000;
const BACKOFF_MS = 100;
// A lock is only stealable once it is older than this AND its PID is dead (§2.10).
const STALE_AGE_MS = 30_000;

// On-disk lock content (§2.10). `acquired_at` is an ISO-8601 UTC timestamp.
export interface LockInfo {
  pid: number;
  hostname: string;
  acquired_at: string;
}

// A held lock: the file path plus the exact content we wrote, so `release` can
// confirm the lock is still ours before unlinking.
export interface LockHandle {
  path: string;
  info: LockInfo;
}

// Injected, non-fs seams. Real fs stays real (it is the mutex); these are the
// non-deterministic edges so tests stay deterministic and run in zero real time.
export interface LockSeams {
  now: () => number; // ms since epoch; drives the retry bound and acquired_at
  sleep: (ms: number) => void; // synchronous backoff between retries
  isPidAlive: (pid: number) => boolean; // process.kill(pid,0) oracle in the real impl
  pid: number; // identity written into the lock
  hostname: string; // identity written into the lock
  warn: (message: string) => void; // stale-steal record sink
}

// LOCK_BUSY carrier: the bounded retry was exhausted without acquiring. Carries
// the frozen EXIT_LOCK_BUSY (§2.7) so the CLI edge maps it to the process exit
// code, plus a cross-realm `kind` tag (the CorruptStateError idiom) since a
// bundled copy can defeat `instanceof`.
export class LockBusyError extends Error {
  readonly kind = 'lock-busy';
  readonly exitCode = EXIT_LOCK_BUSY;
  constructor(worktree: string) {
    super(
      `could not acquire ${LOCK_FILE_NAME} at "${worktree}" within ${RETRY_BUDGET_MS}ms (LOCK_BUSY)`,
    );
    this.name = 'LockBusyError';
  }
}

export function lockPathFor(worktree: string): string {
  return `${worktree}/${LOCK_FILE_NAME}`;
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function sameLock(a: LockInfo, b: LockInfo): boolean {
  return a.pid === b.pid && a.acquired_at === b.acquired_at;
}

function isLockInfo(value: unknown): value is LockInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === 'number' &&
    typeof v.hostname === 'string' &&
    typeof v.acquired_at === 'string'
  );
}

function unlinkIfPresent(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch (err) {
    if (isErrno(err) && err.code === 'ENOENT') return; // already gone
    throw err;
  }
}

// Reads take no lock (§2.10). Returns null when the file is absent (ENOENT) or
// its content is not a well-formed lock — the latter tolerates a half-written
// lock (a writer that created the file via 'wx' but has not yet written its JSON
// content): an unreadable lock is treated as "not stealable", never stolen.
export function readLockInfo(path: string): LockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (isErrno(err) && err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // half-written / corrupt content — deliberately not stealable
  }
  return isLockInfo(parsed) ? parsed : null;
}

function isStale(info: LockInfo, seams: LockSeams): boolean {
  // BOTH conditions required (§2.10): the PID must be dead AND the lock old.
  if (seams.isPidAlive(info.pid)) return false;
  const acquiredMs = Date.parse(info.acquired_at);
  if (Number.isNaN(acquiredMs)) return false; // unparseable timestamp -> not provably stale
  return seams.now() - acquiredMs >= STALE_AGE_MS;
}

// Exclusive-create the lockfile. Returns the handle on success, or null when a
// holder already exists (EEXIST). Any other fs error propagates.
function tryCreate(path: string, seams: LockSeams): LockHandle | null {
  const info: LockInfo = {
    pid: seams.pid,
    hostname: seams.hostname,
    acquired_at: new Date(seams.now()).toISOString(),
  };
  let fd: number;
  try {
    fd = fs.openSync(path, 'wx'); // atomic exclusive create — the mutex primitive
  } catch (err) {
    if (isErrno(err) && err.code === 'EEXIST') return null;
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(info));
  } finally {
    fs.closeSync(fd);
  }
  return { path, info };
}

// Atomic stale-lock steal step (§2.10). Renames the observed stale lockfile to a
// unique token: fs.renameSync is atomic, so of two racers exactly one rename
// wins — the loser's source is already gone (ENOENT). On winning, the renamed
// content is verified to STILL match what we observed (guards a TOCTOU where the
// lock was released+recreated between observe and rename); on a mismatch the file
// is restored and the steal declines. Returns the token path holding the claimed
// stale lock on success (the caller drops it), or null when the steal did not win.
export function claimStale(path: string, observed: LockInfo, seams: LockSeams): string | null {
  const token = `${path}.steal.${seams.pid}.${seams.now()}.${randomUUID()}`;
  try {
    fs.renameSync(path, token); // atomic claim — loser hits ENOENT here
  } catch (err) {
    if (isErrno(err) && err.code === 'ENOENT') return null; // lost the race
    throw err;
  }
  const renamed = readLockInfo(token);
  if (renamed === null || !sameLock(renamed, observed)) {
    // The lock changed between observe and rename: not the stale lock we saw.
    // Put it back (best effort) and decline rather than destroy a newer lock.
    try {
      fs.renameSync(token, path);
    } catch (err) {
      unlinkIfPresent(token);
      if (isErrno(err) && err.code === 'ENOENT') return null;
      throw err;
    }
    return null;
  }
  return token;
}

function staleWarning(observed: LockInfo, path: string): string {
  return (
    `reclaimed stale lock ${path} ` +
    `(pid ${observed.pid} on ${observed.hostname}, acquired ${observed.acquired_at})`
  );
}

// Acquire the worktree lock. Returns a handle on success, or null on LOCK_BUSY
// (the bounded retry was exhausted). A stale lock (dead PID AND older than the
// threshold) is stolen atomically and at most once along the way.
export function acquire(worktree: string, seams: LockSeams): LockHandle | null {
  const path = lockPathFor(worktree);
  const start = seams.now();
  let stolen = false;
  for (;;) {
    const handle = tryCreate(path, seams);
    if (handle !== null) return handle;

    // EEXIST: a holder exists. Consider a one-time stale steal before backing off.
    if (!stolen) {
      const observed = readLockInfo(path);
      if (observed !== null && isStale(observed, seams)) {
        stolen = true; // the steal is attempted at most ONCE (§2.10)
        const token = claimStale(path, observed, seams);
        if (token !== null) {
          unlinkIfPresent(token); // drop the reclaimed stale lock
          seams.warn(staleWarning(observed, path));
          continue; // the slot is free now — retry the wx-create immediately
        }
        // Lost the atomic steal (ENOENT) or the content changed: fall through.
      }
    }

    if (seams.now() - start >= RETRY_BUDGET_MS) return null; // LOCK_BUSY
    seams.sleep(BACKOFF_MS);
  }
}

// Release a lock we hold. Confirms the on-disk lock is still ours before
// unlinking (so a lock that was reclaimed as stale by another process is not
// clobbered), and treats an already-removed lock as released.
export function release(handle: LockHandle): void {
  const current = readLockInfo(handle.path);
  if (current !== null && sameLock(current, handle.info)) {
    unlinkIfPresent(handle.path);
  }
}

// Acquire, run the critical section, and release in `finally` — on the success
// path and when the section throws. Throws LockBusyError (carrying
// EXIT_LOCK_BUSY) when the lock cannot be acquired within the bound.
export function withLock<T>(worktree: string, seams: LockSeams, fn: () => T): T {
  const handle = acquire(worktree, seams);
  if (handle === null) throw new LockBusyError(worktree);
  try {
    return fn();
  } finally {
    release(handle);
  }
}

// Real PID-liveness: process.kill(pid, 0) sends no signal but probes existence.
// ESRCH -> no such process (dead); EPERM -> the process exists but is not ours
// (still alive). Any other error is treated conservatively as "alive".
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrno(err) && err.code === 'ESRCH') return false;
    return true; // EPERM and anything else: assume alive, never steal on doubt
  }
}

// Synchronous blocking sleep for the real edge (the acquire loop blocks the
// thread between retries). Atomics.wait on a private buffer is permitted on the
// Node main thread and needs no busy-spin.
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Real seams for the runner edge: wall clock, blocking sleep, the kill(0) oracle,
// this process's identity, and a stderr warning sink.
export function realLockSeams(): LockSeams {
  return {
    now: () => Date.now(),
    sleep: sleepSync,
    isPidAlive: defaultIsPidAlive,
    pid: process.pid,
    hostname: os.hostname(),
    warn: (message) => {
      process.stderr.write(`workflow: ${message}\n`);
    },
  };
}

export { LOCK_FILE_NAME };
