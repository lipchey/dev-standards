import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isGroupGone, runProcess } from '../../runner/src/exec.ts';

/* BUG-03 regression: the detached process group must be SIGKILLed AND drained on EVERY abnormal
   outcome — not just a timeout — so no grandchild survives to mutate the tree after runProcess (and
   therefore runFixStaged's rollback) returns. Before the fix the reap fired only for ETIMEDOUT, so a
   signal-kill or an ENOBUFS (maxBuffer overflow) left the grandchild alive and it wrote its marker
   ~`delayMs` later, corrupting the repo AFTER the "reverted" message.

   The child spawns a grandchild that writes `marker` after `delayMs`, then forces one of:
     - 'hang'   → outlives the caller's low timeout           (ETIMEDOUT)
     - 'signal' → self-SIGKILL                                (status null, no error)
     - 'enobuf' → floods stdout past the 64 MiB maxBuffer     (spawnSync ENOBUFS) */
function writeGroupStub(dir: string): string {
  const file = path.join(dir, 'reap-child.mjs');
  fs.writeFileSync(
    file,
    "import { spawn } from 'node:child_process';\n" +
      'const [marker, delayMs, mode] = process.argv.slice(2);\n' +
      "spawn(process.execPath, ['-e', 'setTimeout(()=>require(\"fs\").writeFileSync(process.argv[1],\"x\"),' + delayMs + ')', marker], { stdio: 'ignore' });\n" +
      "process.on('SIGTERM', () => {});\n" +
      "if (mode === 'signal') { process.kill(process.pid, 'SIGKILL'); }\n" +
      "else if (mode === 'enobuf') { process.stdout.write(Buffer.alloc(80 * 1024 * 1024, 0x61)); setTimeout(() => process.exit(0), 60000); }\n" +
      'else { setTimeout(() => process.exit(0), 60000); }\n',
  );
  return file;
}

const DELAY_MS = 800; // grandchild writes its marker this long after being spawned
const WAIT_MS = 1600; // > DELAY_MS: long enough for an un-reaped grandchild to have written

async function assertNoSurvivor(mode: 'signal' | 'enobuf' | 'hang', timeoutMs: number): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ds-reap-${mode}-`));
  try {
    const marker = path.join(dir, 'marker');
    const result = runProcess({
      argv: [process.execPath, writeGroupStub(dir), marker, String(DELAY_MS), mode],
      cwd: process.cwd(),
      timeoutMs,
    });
    // Every mode is an abnormal outcome, so it classifies operational (never a red test).
    assert.equal(result.kind, 'operational', `${mode}: expected operational, got ${result.kind}`);
    await delay(WAIT_MS);
    assert.equal(
      fs.existsSync(marker),
      false,
      `${mode}: grandchild survived and wrote its marker — the process group was not reaped`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('BUG-03: a timeout reaps the whole group — no grandchild survives', async () => {
  await assertNoSurvivor('hang', 400); // child sleeps 60s; killed at 400ms
});

test('BUG-03: a signal-kill of the child reaps the whole group — no grandchild survives', async () => {
  await assertNoSurvivor('signal', 30_000);
});

test('BUG-03: an ENOBUFS (maxBuffer overflow) reaps the whole group — no grandchild survives', async () => {
  await assertNoSurvivor('enobuf', 30_000);
});

/* The reap's give-up predicate. EPERM only reaches it once the group we killed has drained and its
   ID was recycled to a process we may not signal — staging that race is not feasible, so the
   predicate is pinned directly. Treating EPERM as a hard error made reapGroup throw under parallel
   test load and red a whole verify tier. */
test('the reap treats an unsignalable group as gone, and still surfaces real faults', () => {
  for (const code of ['ESRCH', 'EPERM']) {
    assert.equal(isGroupGone(Object.assign(new Error('kill'), { code })), true, code);
  }
  for (const code of ['EINVAL', undefined]) {
    assert.equal(isGroupGone(Object.assign(new Error('kill'), { code })), false, String(code));
  }
});
