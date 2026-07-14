// The run descriptor (Phase 5 §0) — the identity marker of a deep-review run-worktree. It is
// written LAST by `select-worktree` (so its presence means "worktree fully set up"), lives at
// `<absolute-git-dir>/deep-review-run.json` (OUTSIDE the working tree, so it dies with the
// worktree and never dirties a diff), and is the anchor every fix verb checks before mutating:
// the worktree it runs in must be exactly the one the run was created for.
//
// This module owns the descriptor's shape + persistence + the git-side identity gate
// (`verifyDescriptor`). The findings-side of the gate (findings.run_id == descriptor.run_id) is
// layered on by the fix verbs (W4). Effects (fs + git spawn) live behind injected seams so the
// logic is testable without a real repo; the real defaults use fixed-argv `shell:false` git.

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Deadline } from './deadline.ts';

// The descriptor file name under the worktree's absolute git-dir.
const DESCRIPTOR_FILENAME = 'deep-review-run.json';

export interface RunDescriptor {
  schema: 1;
  run_id: string;
  created_at: string;
  canonical_root: string; // realpath of the worktree toplevel
  git_dir: string; // realpath of `git rev-parse --absolute-git-dir`
  git_common_dir: string; // realpath of `git rev-parse --git-common-dir`
  branch_ref: string; // e.g. refs/heads/deep-review/<slug>
  base_ref: string; // full ref of the base, e.g. refs/heads/main
  base_sha: string; // base commit at creation time
  initial_head_sha: string; // worktree HEAD immediately after `worktree add`
}

// The whole-run context cli.ts builds ONCE and threads to the verbs (§0 — no global state). The
// mutation-layer (findings-io) confines writes under `reportsRootAbs`; the fix verbs read
// `descriptor`/`deadline`. `descriptor` is null outside a run-worktree (review-only).
export interface DeepReviewContext {
  canonicalRoot: string; // realpath git toplevel
  reportsRootAbs: string; // realpath(resolve(root, paths.reports))
  deadline: Deadline;
  descriptor: RunDescriptor | null;
  verifyEntry: string; // relative path of the verify shim spawned by the final gate + slice validation
}

// A descriptor-layer failure carrying a human-legible reason (surfaced by the caller as a §2.4
// machine error / EXIT_DESCRIPTOR_MISMATCH). `kind` is a cross-realm tag.
class DescriptorError extends Error {
  readonly kind = 'descriptor-error' as const;
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'DescriptorError';
    this.reason = reason;
    Object.setPrototypeOf(this, DescriptorError.prototype);
  }
}

// The git-side identity verdict. `ok:false` carries the specific mismatch so the fix verb can
// name what is wrong (worktree moved, wrong branch, HEAD rewound, etc.).
export type DescriptorVerdict =
  | { ok: true; descriptor: RunDescriptor }
  | { ok: false; reason: string };

// ── Effects seam ────────────────────────────────────────────────────────────────

interface DescriptorGitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface DescriptorDeps {
  // Fixed-argv git, shell:false; `status` is null on a spawn fault. `timeout` (§F7) bounds the
  // spawn so a hung git call cannot block the run past its deadline.
  git: (args: string[], cwd: string, timeout?: number) => DescriptorGitResult;
  readFile: (p: string) => string;
  writeFile: (p: string, content: string) => void;
  rename: (from: string, to: string) => void;
  exists: (p: string) => boolean;
  realpath: (p: string) => string;
  // §F7 the run deadline; when present, every git spawn is bounded by min(15s, remainingMs).
  // Omitted by callers with no deadline (classify's readDescriptor), which leaves git unbounded.
  deadline?: Deadline;
}

const defaultGit: DescriptorDeps['git'] = (args, cwd, timeout) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, timeout, maxBuffer: 16 * 1024 * 1024 });
  if (r.error !== undefined) return { status: null, stdout: '', stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// §F7 per-git-call timeout cap (ms). The run deadline tightens it further per call.
const DESCRIPTOR_GIT_CAP_MS = 15_000;

// Runs a descriptor git call through the seam, bounded by the deadline when one is present
// (floored at 1ms so an exhausted budget yields an immediate timeout, not spawnSync's "no timeout").
function gitRun(deps: DescriptorDeps, args: string[], cwd: string): DescriptorGitResult {
  const timeout =
    deps.deadline === undefined
      ? undefined
      : Math.max(1, Math.min(DESCRIPTOR_GIT_CAP_MS, deps.deadline.remainingMs()));
  return deps.git(args, cwd, timeout);
}

const realDescriptorDeps: DescriptorDeps = {
  git: defaultGit,
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, content) => fs.writeFileSync(p, content),
  rename: (from, to) => fs.renameSync(from, to),
  exists: (p) => fs.existsSync(p),
  realpath: (p) => fs.realpathSync(p),
};

function withDefaults(over: Partial<DescriptorDeps> | undefined): DescriptorDeps {
  return over === undefined ? realDescriptorDeps : { ...realDescriptorDeps, ...over };
}

// ── git identity (realpath-normalized) ────────────────────────────────────────────

function safeReal(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p);
  } catch {
    return path.resolve(p);
  }
}

interface GitIdentity {
  gitDir: string;
  gitCommonDir: string;
  toplevel: string;
}

// Reads the realpath-normalized git-dir / common-dir / toplevel for `cwd`, or null when `cwd`
// is not inside a git worktree. Both `writeDescriptor`'s caller and `verifyDescriptor` normalize
// identically (realpath), so a symlinked temp root (/tmp -> /private/tmp) compares equal.
function readGitIdentity(deps: DescriptorDeps, cwd: string): GitIdentity | null {
  const gd = gitRun(deps, ['rev-parse', '--absolute-git-dir'], cwd);
  if (gd.status !== 0) return null;
  const cd = gitRun(deps, ['rev-parse', '--git-common-dir'], cwd);
  if (cd.status !== 0) return null;
  const tl = gitRun(deps, ['rev-parse', '--show-toplevel'], cwd);
  if (tl.status !== 0) return null;
  const commonRaw = cd.stdout.trim();
  return {
    gitDir: safeReal(deps.realpath, gd.stdout.trim()),
    gitCommonDir: safeReal(deps.realpath, path.isAbsolute(commonRaw) ? commonRaw : path.resolve(cwd, commonRaw)),
    toplevel: safeReal(deps.realpath, tl.stdout.trim()),
  };
}

function descriptorPath(gitDirAbs: string): string {
  return path.join(gitDirAbs, DESCRIPTOR_FILENAME);
}

// ── shape guard ─────────────────────────────────────────────────────────────────

const STRING_FIELDS = [
  'run_id',
  'created_at',
  'canonical_root',
  'git_dir',
  'git_common_dir',
  'branch_ref',
  'base_ref',
  'base_sha',
  'initial_head_sha',
] as const;

function parseDescriptor(raw: string): RunDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DescriptorError('run descriptor is not valid JSON');
  }
  if (typeof value !== 'object' || value === null) throw new DescriptorError('run descriptor is not an object');
  const record = value as Record<string, unknown>;
  if (record['schema'] !== 1) throw new DescriptorError(`run descriptor schema must be 1, got ${JSON.stringify(record['schema'])}`);
  for (const field of STRING_FIELDS) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new DescriptorError(`run descriptor field ${field} must be a non-empty string`);
    }
  }
  return value as RunDescriptor;
}

// ── write ───────────────────────────────────────────────────────────────────────

// Writes the descriptor to `<git_dir>/deep-review-run.json` via tmp + atomic rename. NOT confined
// under paths.reports (the git-dir is outside the working tree by design). This is the LAST step
// of `select-worktree`: its presence is the "worktree ready" marker.
export function writeDescriptor(descriptor: RunDescriptor, over?: Partial<DescriptorDeps>): void {
  const deps = withDefaults(over);
  const target = descriptorPath(descriptor.git_dir);
  const tmp = `${target}.${process.pid}.tmp`;
  deps.writeFile(tmp, `${JSON.stringify(descriptor, null, 2)}\n`);
  deps.rename(tmp, target);
}

// ── read (content only, no identity gate) ─────────────────────────────────────────

// Returns the parsed descriptor for `cwd`, or null when `cwd` is not a worktree or carries no
// descriptor (review-only, or a pre-v0.4.0 worktree). A PRESENT-but-malformed descriptor throws
// DescriptorError (loud, never silently null). Used by classify's unbound->bound transition.
export function readDescriptor(cwd: string, over?: Partial<DescriptorDeps>): RunDescriptor | null {
  const deps = withDefaults(over);
  const identity = readGitIdentity(deps, cwd);
  if (identity === null) return null;
  const target = descriptorPath(identity.gitDir);
  if (!deps.exists(target)) return null;
  return parseDescriptor(deps.readFile(target));
}

// ── verify (git-side identity gate) ───────────────────────────────────────────────

// The git-side identity gate: the descriptor exists + parses, and the CURRENT worktree matches it
// (canonical root, git-dir, common-dir, branch, and HEAD is a descendant of the recorded initial
// HEAD). Any divergence -> `ok:false` with the specific reason. The findings-side check
// (findings.run_id == descriptor.run_id) is applied by the fix verb on top of this (W4).
export function verifyDescriptor(cwd: string, over?: Partial<DescriptorDeps>): DescriptorVerdict {
  const deps = withDefaults(over);
  const identity = readGitIdentity(deps, cwd);
  if (identity === null) return { ok: false, reason: 'not inside a git worktree' };

  const target = descriptorPath(identity.gitDir);
  if (!deps.exists(target)) {
    return {
      ok: false,
      reason: 'no run descriptor: this worktree was not created by deep-review select-worktree (or setup aborted); remove it and re-run select-worktree',
    };
  }

  let descriptor: RunDescriptor;
  try {
    descriptor = parseDescriptor(deps.readFile(target));
  } catch (error) {
    return { ok: false, reason: error instanceof DescriptorError ? error.reason : String(error) };
  }

  if (identity.toplevel !== descriptor.canonical_root) {
    return { ok: false, reason: `canonical root mismatch: worktree is ${identity.toplevel}, descriptor is ${descriptor.canonical_root}` };
  }
  if (identity.gitDir !== descriptor.git_dir) {
    return { ok: false, reason: `git-dir mismatch: ${identity.gitDir} vs ${descriptor.git_dir}` };
  }
  if (identity.gitCommonDir !== descriptor.git_common_dir) {
    return { ok: false, reason: `git-common-dir mismatch: ${identity.gitCommonDir} vs ${descriptor.git_common_dir}` };
  }
  const branch = gitRun(deps, ['symbolic-ref', 'HEAD'], cwd);
  if (branch.status !== 0 || branch.stdout.trim() !== descriptor.branch_ref) {
    return { ok: false, reason: `branch mismatch: HEAD is ${branch.stdout.trim() || '(detached/unreadable)'}, descriptor is ${descriptor.branch_ref}` };
  }
  // The recorded initial HEAD must be an ancestor of the current HEAD: slices only move HEAD
  // forward, so a HEAD that no longer descends from it means the branch was reset/rewritten.
  const ancestor = gitRun(deps, ['merge-base', '--is-ancestor', descriptor.initial_head_sha, 'HEAD'], cwd);
  if (ancestor.status !== 0) {
    return { ok: false, reason: `HEAD no longer descends from the run's initial HEAD ${descriptor.initial_head_sha}` };
  }
  return { ok: true, descriptor };
}
