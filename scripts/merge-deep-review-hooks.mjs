#!/usr/bin/env node
/* Merges the guides-read Stop/SubagentStop hooks into a consumer's .claude/settings.json
   WITHOUT clobbering existing settings (ADR-016). copy-if-absent cannot be used: a
   settings.json that already carries other hooks must gain ours by structured merge, not
   be skipped. Idempotent — keyed by the exact command string — so re-running the seeder
   never duplicates the hook. Prints `created:<abs>` when it creates the file (the seeder
   journals it for rollback). `--check` verifies both hooks are present without writing.

   Writes are confined to the consumer root and refuse a symlinked settings.json, mirroring
   seed-consumer.sh — a routed write would land .claude/settings.json outside the target. */

import { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

const EXIT_USAGE = 2;
/* $CLAUDE_PROJECT_DIR is Claude Code's documented hook-config placeholder (the project
   root), so the hook resolves the shim regardless of the session's cwd (e.g. a worktree).
   The embedded quotes tolerate spaces in the path. */
const HOOK_COMMAND = '"$CLAUDE_PROJECT_DIR"/scripts/deep-review guides-read --hook-stdin';
const EVENTS = ['Stop', 'SubagentStop'];

function fail(message) {
  process.stderr.write(`merge-deep-review-hooks: ${message}\n`);
  process.exit(EXIT_USAGE);
}

const consumerRoot = process.argv[2];
const checkMode = process.argv.includes('--check');
if (consumerRoot === undefined || consumerRoot.startsWith('--')) {
  fail('usage: merge-deep-review-hooks.mjs <consumer-root> [--check]');
}

let rootAbs;
try {
  rootAbs = realpathSync(consumerRoot);
} catch {
  fail(`consumer root is not a directory: ${consumerRoot}`);
}
const settingsPath = path.join(rootAbs, '.claude', 'settings.json');

/* A symlinked settings.json (or a symlinked .claude ancestor) would route the write
   outside the consumer despite a confined leaf; refuse it, like the seeder's append guard.
   lstat with throwIfNoEntry:false (NOT existsSync): a DANGLING symlink — target absent —
   makes existsSync false, so gating the check on existsSync would skip it and let a later
   write follow the link and create a file OUTSIDE the repo. lstat sees the link itself. */
const leafStat = lstatSync(settingsPath, { throwIfNoEntry: false });
if (leafStat !== undefined && leafStat.isSymbolicLink()) {
  fail(`refusing symlinked settings file: ${settingsPath}`);
}
let existingAncestor = path.dirname(settingsPath);
while (!existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);
const ancestorReal = realpathSync(existingAncestor);
if (ancestorReal !== rootAbs && !ancestorReal.startsWith(`${rootAbs}${path.sep}`)) {
  fail(`settings path escapes the consumer root: ${ancestorReal}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* A group is UNFILTERED when it has no restrictive `matcher` (absent, empty, or `*`). A
   SubagentStop group whose matcher targets some other agent type would not fire for a
   deep-review subagent, so a filtered group carrying our command must NOT count as armed. Our
   own merge always writes an unfiltered group, so this never rejects a correct install. */
function isUnfilteredGroup(group) {
  const matcher = group.matcher;
  return matcher === undefined || matcher === '' || matcher === '*';
}

/* An ARMED hook is a synchronous command hook with our exact command, in an unfiltered group.
   `type === 'command'` and `async !== true` are required: an async hook (or a non-command
   type) with the same command string cannot return a blocking decision, so treating it as
   installed would let --check certify a gate that can never block. */
function hasHook(groups) {
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        isPlainObject(group) &&
        isUnfilteredGroup(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some(
          (hook) =>
            isPlainObject(hook) &&
            hook.type === 'command' &&
            hook.async !== true &&
            hook.command === HOOK_COMMAND,
        ),
    )
  );
}

/* `disableAllHooks: true` is Claude Code's global kill-switch: every hook, including ours, is
   inert. The gate cannot run, so --check must fail and the seeder must warn loudly even though
   the hook entries are structurally present. */
function hooksGloballyDisabled(settingsObject) {
  return settingsObject.disableAllHooks === true;
}

let settings = {};
let fileExisted = existsSync(settingsPath);
if (fileExisted) {
  const raw = readFileSync(settingsPath, 'utf8').trim();
  if (raw !== '') {
    try {
      settings = JSON.parse(raw);
    } catch {
      fail(`existing settings.json is not valid JSON: ${settingsPath}`);
    }
    if (!isPlainObject(settings)) fail(`existing settings.json is not a JSON object: ${settingsPath}`);
  }
}

if (checkMode) {
  if (hooksGloballyDisabled(settings)) {
    process.stderr.write(`check: hooks are globally disabled (disableAllHooks) — guides-read gate cannot run\n`);
    process.exit(1);
  }
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const missing = EVENTS.filter((event) => !hasHook(hooks[event]));
  if (missing.length > 0) {
    process.stderr.write(`check: guides-read hook missing for: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (!isPlainObject(settings.hooks)) settings.hooks = {};
let changed = false;
for (const event of EVENTS) {
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  if (!hasHook(groups)) {
    groups.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
    changed = true;
  }
  settings.hooks[event] = groups;
}
/* Install the hooks regardless, but never let a global disable pass silently: the entries are
   present yet inert, which --check will also report. */
if (hooksGloballyDisabled(settings)) {
  process.stderr.write(`warning: disableAllHooks is set — the guides-read gate will NOT run until it is cleared\n`);
}

if (changed) {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  /* Re-check for a symlinked leaf immediately before writing — shrinks the TOCTOU window a
     local writer could use to swap in a symlink after the initial check — then publish via a
     temp file + atomic rename so the final step replaces the NAME (rename does not follow a
     symlink at the destination) instead of following a swapped-in link. (A `.claude` ancestor
     swapped for a symlink mid-run would still route the temp write; closing that needs openat,
     which Node lacks — out of scope for a user-local seeder.) */
  const preWrite = lstatSync(settingsPath, { throwIfNoEntry: false });
  if (preWrite !== undefined && preWrite.isSymbolicLink()) {
    fail(`refusing symlinked settings file: ${settingsPath}`);
  }
  const tmpPath = path.join(path.dirname(settingsPath), `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmpPath, settingsPath);
}
if (!fileExisted && existsSync(settingsPath)) process.stdout.write(`created:${settingsPath}\n`);
