import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnGroup } from './exec.ts';
import { readConfined, resolveConfinedPath } from './report.ts';
import type { Check, CheckGroup, CheckResult, TierName } from './types.ts';

export interface RunCheckGroupInput {
  group: CheckGroup;
  checks: Check[];
  tier: TierName;
  cwd: string;
  timeoutMs: number;
}

const STATUSES = new Set(['pass', 'fail', 'skipped', 'timeout', 'bypassed', 'error']);
export const TIMING_SOURCE_PATTERN = /^[\w.-]{1,64}$/;

interface ArtifactEntry {
  status: CheckResult['status'];
  exitCode: number | null;
  durationMs: number;
}

interface Artifact {
  timingSource: string;
  results: Record<string, ArtifactEntry>;
}

export function errorRows(
  input: Pick<RunCheckGroupInput, 'checks' | 'tier'>,
  reason: string,
): CheckResult[] {
  return input.checks.map((check) => unresolved(input, check, reason));
}

function unresolved(
  input: Pick<RunCheckGroupInput, 'tier'>,
  check: Check,
  reason: string,
): CheckResult {
  return {
    name: check.name,
    tier: input.tier,
    status: 'error',
    exitCode: null,
    durationMs: 0,
    mode: check.mode ?? 'blocking',
    reason,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArtifact(value: unknown, nonce: string, declared: Set<string>): string | Artifact {
  if (!isObject(value)) return 'not an object';
  if (value['v'] !== 1) return 'unsupported version';
  if (value['nonce'] !== nonce) return 'nonce mismatch';
  if (
    typeof value['timingSource'] !== 'string' ||
    !TIMING_SOURCE_PATTERN.test(value['timingSource'])
  ) {
    return 'invalid timing source';
  }
  if (!isObject(value['results'])) return 'results is not an object';
  for (const [key, entry] of Object.entries(value['results'])) {
    if (!declared.has(key)) return `undeclared result key ${JSON.stringify(key)}`;
    if (!isObject(entry)) return `result ${JSON.stringify(key)} is not an object`;
    const keys = Object.keys(entry);
    if (
      keys.length !== 3 ||
      !Object.hasOwn(entry, 'status') ||
      !Object.hasOwn(entry, 'exitCode') ||
      !Object.hasOwn(entry, 'durationMs')
    ) {
      return `result ${JSON.stringify(key)} has invalid keys`;
    }
    if (typeof entry['status'] !== 'string' || !STATUSES.has(entry['status'])) {
      return `result ${JSON.stringify(key)} has invalid status`;
    }
    if (entry['exitCode'] !== null && !Number.isSafeInteger(entry['exitCode'])) {
      return `result ${JSON.stringify(key)} has invalid exit code`;
    }
    if (
      typeof entry['durationMs'] !== 'number' ||
      !Number.isFinite(entry['durationMs']) ||
      !Number.isInteger(entry['durationMs']) ||
      entry['durationMs'] < 0
    ) {
      return `result ${JSON.stringify(key)} has invalid duration`;
    }
  }

  return value as unknown as Artifact;
}

function attribute(input: RunCheckGroupInput, artifact: Artifact): CheckResult[] {
  const keys = new Map(input.group.members.map((member) => [member.check, member.result_key]));
  return input.checks.map((check) => {
    const key = keys.get(check.name);
    if (key === undefined || !Object.hasOwn(artifact.results, key)) {
      return unresolved(input, check, 'group member unattributed');
    }

    const entry = artifact.results[key]!;
    if (entry.status === 'skipped' || entry.status === 'bypassed') {
      return unresolved(input, check, `group member reported ${entry.status}`);
    }
    if ((entry.status === 'pass' && entry.exitCode !== 0) ||
        (entry.status === 'fail' && (entry.exitCode === null || entry.exitCode === 0))) {
      return unresolved(input, check, 'group member exit code contradicts status');
    }

    const overTimeout = entry.durationMs > check.timeout_seconds * 1000;
    const status = overTimeout ? 'timeout' : entry.status;
    const exitCode = status === 'error' || status === 'timeout' ? null : entry.exitCode;
    return {
      name: check.name,
      tier: input.tier,
      status,
      exitCode,
      durationMs: entry.durationMs,
      mode: check.mode ?? 'blocking',
      timingSource: artifact.timingSource,
    };
  });
}

function executeArtifact(
  input: RunCheckGroupInput,
  nonce: string,
  relPath: string,
  artifactPath: string,
): CheckResult[] {
  try {
    fs.rmSync(artifactPath, { force: true });
  } catch {
    throw new Error('pre-delete failed');
  }

  try {
    const { result, timedOut } = spawnGroup(input.group.argv, input.cwd, input.timeoutMs, 'inherit', {
      ...process.env,
      DS_GROUP_ARTIFACT: artifactPath,
      DS_GROUP_NONCE: nonce,
    });
    if (!timedOut && result.error !== undefined) throw result.error;
  } catch {
    throw new Error('spawn failed');
  }
  /* The batch's own exit code and signal never decide a member's status — only the artifact does. */

  let content: string;
  try {
    content = readConfined(input.cwd, relPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return errorRows(input, 'group artifact missing');
    }
    return errorRows(input, 'group artifact corrupt: read failed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return errorRows(input, 'group artifact corrupt: invalid JSON');
  }

  const declared = new Set(input.group.members.map((member) => member.result_key));
  const artifact = validateArtifact(parsed, nonce, declared);
  if (typeof artifact === 'string') {
    return errorRows(input, `group artifact corrupt: ${artifact}`);
  }
  return attribute(input, artifact);
}

function execute(input: RunCheckGroupInput): CheckResult[] {
  const nonce = randomBytes(16).toString('hex');
  const relPath = path.join(input.group.artifact_dir, `${input.group.name}.${nonce}.json`);
  let artifactPath: string;
  try {
    artifactPath = resolveConfinedPath(input.cwd, relPath);
  } catch {
    throw new Error('confined path resolution failed');
  }

  let rows: CheckResult[] = [];
  let failure: unknown;
  let failed = false;
  try {
    rows = executeArtifact(input, nonce, relPath, artifactPath);
  } catch (error) {
    failure = error;
    failed = true;
  }
  try {
    fs.rmSync(artifactPath, { force: true, recursive: true });
  } catch {
    /* The nonce makes leftover artifacts inert after attribution. */
  }
  if (failed) throw failure;
  return rows;
}

export function runCheckGroup(input: RunCheckGroupInput): CheckResult[] {
  try {
    return execute(input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'execution failed';
    return errorRows(input, `group execution failed: ${detail}`);
  }
}
