#!/usr/bin/env bash
# seed-eslint-config.sh — make a consumer inherit the dev-standards ESLint presets
# with zero manual wiring. Run from the consumer's ds-bootstrap.sh (after submodule
# update). Two idempotent steps:
#   1. copy-if-absent the consumer eslint.config template → <consumer>/eslint.config.js
#      (repo-owned once seeded; re-seeding never overwrites — same contract as
#      seed-review-guides.sh).
#   2. ensure the ESLint toolchain (incl. the dev-standards file: dep that carries
#      every plugin) is in <consumer>/package.json devDependencies — add only the
#      keys that are ABSENT, never touching a version the consumer already pinned.
#
# The file: dep is what makes plugin delivery automatic: `npm ci` pulls
# dev-standards and, transitively, every pinned plugin — the consumer installs none
# by name. eslint stays the consumer's own (it is a peer of dev-standards).
#
# macOS bash 3.2 compatible: no mapfile / assoc arrays / realpath.

set -euo pipefail
export LC_ALL=C

usage() { echo "usage: seed-eslint-config.sh <consumer-root>" >&2; }

[ $# -eq 1 ] || { usage; exit 2; }
consumer_root_abs=$(cd "$1" 2>/dev/null && pwd -P) \
  || { echo "consumer-root is not a directory: $1" >&2; exit 2; }

script_dir=$(cd "$(dirname "$0")" && pwd -P)
template="$script_dir/../eslint/consumer-template.eslint.config.js"
[ -f "$template" ] || { echo "template not found: $template" >&2; exit 2; }

# --- step 1: seed eslint.config.js (copy-if-absent, atomic no-clobber) ---
# mktemp (O_EXCL + random suffix) closes the pre-planted-temp race and, by
# owning a unique name, needs no `rm -f "$dest.tmp."*` family sweep (which would
# eat a concurrent seeder's temp or a consumer lookalike). ln is the atomic
# no-clobber publish: a file that appeared after the absence check is
# consumer-owned and wins. Mirrors seed-review-guides.sh.
dest="$consumer_root_abs/eslint.config.js"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "eslint.config.js: kept (repo-owned)"
else
  tmp=$(mktemp "$dest.tmp.XXXXXX") || { echo "temp create failed" >&2; exit 2; }
  trap 'rm -f "$tmp"' EXIT
  cp "$template" "$tmp" || { echo "copy failed" >&2; exit 2; }
  chmod 644 "$tmp"
  if ln "$tmp" "$dest" 2>/dev/null; then
    echo "eslint.config.js: seeded"
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "eslint.config.js: kept (repo-owned)"
  else
    echo "publish failed" >&2; exit 2
  fi
  rm -f "$tmp"; trap - EXIT
fi

# --- step 2: ensure toolchain devDependencies + lint script (add-if-absent) ---
# --- step 3: wire the verify gate — quality.json eslint checks (add-if-absent) ---
# Severity `error` in the seeded config is only a gate when verify actually runs
# ESLint (ADR-014; Gate C 2026-07-15): without the tier entry a new consumer
# ships blocking-looking rules that nothing invokes.
pkg="$consumer_root_abs/package.json"
[ -f "$pkg" ] || { echo "no package.json at $consumer_root_abs — skipping dep inject" >&2; exit 0; }

node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pkgPath = process.argv[1];
/* Add only absent keys — a consumer that already pins a version keeps it. eslint
   is the consumers own runner (peer of dev-standards), so it is seeded too. */
const WANT = {
  "dev-standards": "file:vendor/dev-standards",
  "eslint": "^9.38.0",
  "@eslint/js": "^9",
  "globals": "^17",
  "typescript-eslint": "^8",
};

/* Random same-dir temp opened wx (O_EXCL) so a pre-planted symlink is refused
   rather than followed and truncated; clean only this file on any throw, then
   atomically rename over the destination. */
function writeAtomic(destPath, value) {
  const tmp = destPath + ".tmp." + crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(tmp, destPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

let cfg;
try { cfg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); }
catch (e) { console.error("invalid package.json: " + (e && e.message)); process.exit(2); }
cfg.devDependencies = cfg.devDependencies || {};
const added = [];
for (const [name, ver] of Object.entries(WANT)) {
  if (!cfg.devDependencies[name] && !(cfg.dependencies && cfg.dependencies[name])) {
    cfg.devDependencies[name] = ver;
    added.push(name);
  }
}
cfg.scripts = cfg.scripts || {};
if (!cfg.scripts.lint) {
  cfg.scripts.lint = "eslint .";
  added.push("scripts.lint");
}
if (added.length === 0) {
  console.log("devDependencies: complete");
} else {
  writeAtomic(pkgPath, cfg);
  console.log("devDependencies: added " + added.join(", ") + " (run npm install)");
}

/* Gate wiring: append a BLOCKING eslint check to the fast and full tiers of the
   consumer quality.json unless ANY tier already carries a check named "eslint"
   (a consumer that ramps at report-only keeps its own entry untouched). No
   quality.json yet = adoption seeds it later; the note tells the operator. */
const qualityPath = path.join(path.dirname(pkgPath), "quality.json");
if (!fs.existsSync(qualityPath)) {
  console.log("quality.json: absent — add the eslint check when seeding it (see ADOPTION.md)");
  process.exit(0);
}
let quality;
try { quality = JSON.parse(fs.readFileSync(qualityPath, "utf8")); }
catch (e) { console.error("invalid quality.json: " + (e && e.message)); process.exit(2); }
const tiers = quality.tiers || {};
const hasEslint = Object.values(tiers).some(
  (checks) => Array.isArray(checks) && checks.some((check) => check && check.name === "eslint"),
);
if (hasEslint) {
  console.log("quality.json: eslint check present");
  process.exit(0);
}
const ESLINT_CHECK = {
  name: "eslint",
  argv: ["npm", "run", "lint"],
  operational_exit_codes: [2],
  timeout_seconds: 45,
};
const wired = [];
for (const tierName of ["fast", "full"]) {
  if (Array.isArray(tiers[tierName])) {
    tiers[tierName].push(ESLINT_CHECK);
    wired.push(tierName);
  }
}
if (wired.length === 0) {
  console.log("quality.json: no fast/full tier arrays — wire the eslint check manually");
  process.exit(0);
}
writeAtomic(qualityPath, quality);
console.log("quality.json: eslint check added to " + wired.join(", ") + " (blocking)");
' "$pkg"
