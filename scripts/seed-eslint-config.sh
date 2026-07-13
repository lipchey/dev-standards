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

# --- step 1: seed eslint.config.js (copy-if-absent, temp+rename atomic) ---
dest="$consumer_root_abs/eslint.config.js"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "eslint.config.js: kept (repo-owned)"
else
  rm -f "$dest.tmp."* 2>/dev/null || true
  tmp="$dest.tmp.$$"
  cp "$template" "$tmp" || { rm -f "$tmp"; echo "copy failed" >&2; exit 2; }
  mv "$tmp" "$dest"
  echo "eslint.config.js: seeded"
fi

# --- step 2: ensure toolchain devDependencies (add-if-absent, atomic write) ---
pkg="$consumer_root_abs/package.json"
[ -f "$pkg" ] || { echo "no package.json at $consumer_root_abs — skipping dep inject" >&2; exit 0; }

node -e '
const fs = require("fs");
const path = require("path");
const pkgPath = process.argv[1];
/* Add only absent keys — a consumer that already pins a version keeps it. eslint
   is the consumers own runner (peer of dev-standards), so it is seeded too. */
const WANT = {
  "dev-standards": "file:vendor/dev-standards",
  "eslint": ">=9.38.0",
  "@eslint/js": "^9",
  "typescript-eslint": "^8",
};
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
if (added.length === 0) { console.log("devDependencies: complete"); process.exit(0); }
/* temp + rename so an interrupted write cannot leave a truncated package.json. */
const tmp = pkgPath + ".tmp." + process.pid;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
fs.renameSync(tmp, pkgPath);
console.log("devDependencies: added " + added.join(", ") + " (run npm install)");
' "$pkg"
