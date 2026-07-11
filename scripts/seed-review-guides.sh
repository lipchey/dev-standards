#!/usr/bin/env bash
# seed-review-guides.sh — copy the canonical review-guide templates into a
# consumer repo's guides dir, copy-if-absent. Run from the consumer's
# ds-bootstrap.sh (after submodule update + build).
#
# copy-if-absent = the repo owns the final body: once a template is seeded, the
# consumer fills it in and we never overwrite it. Upstream template edits do NOT
# flow into filled copies by design — re-seeding only adds files that are absent.
# Renaming a template upstream leaves the old copy as an orphan in the consumer;
# that is harmless — the deep-review skill judges by every .md in the guides dir,
# so a stale extra guide is just extra (repo-owned) checklist data, not a failure.
#
# Modes:
#   seed (default) — mkdir -p guides_dir, copy each absent canonical guide.
#   --check        — write nothing (not even mkdir); list missing guides on
#                    stderr; exit 1 if any are missing (fast-tier gate), exit 0
#                    when the set is complete.
#
# The guides dir comes from <consumer-root>/quality.json deep_review.guides_dir
# (default .agents/review-guides); --guides-dir <rel> is an explicit override and
# then quality.json is not read. Canonical set = the *.md in this script's
# ../agents/review-guide-templates (the single source — no hardcoded names).
#
# macOS bash 3.2 compatible: no mapfile / assoc arrays / ${var,,} / realpath.

set -euo pipefail
export LC_ALL=C  # deterministic (byte-order) glob + sort

usage() {
  echo "usage: seed-review-guides.sh <consumer-root> [--check] [--guides-dir <rel>]" >&2
}

# --- parse args ---
consumer_root=""
check_mode=0
guides_override=""
guides_override_set=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_mode=1; shift ;;
    --guides-dir)
      shift
      [ $# -gt 0 ] || { echo "--guides-dir requires a value" >&2; exit 2; }
      guides_override="$1"; guides_override_set=1; shift ;;
    --guides-dir=*)
      guides_override="${1#--guides-dir=}"; guides_override_set=1; shift ;;
    -*) echo "unknown flag: $1" >&2; usage; exit 2 ;;
    *)
      if [ -z "$consumer_root" ]; then consumer_root="$1"; shift
      else echo "unexpected argument: $1" >&2; usage; exit 2; fi ;;
  esac
done
[ -n "$consumer_root" ] || { usage; exit 2; }
# An explicit-but-empty override is a config mistake, not "use the default" — refuse it rather
# than silently seeding a directory the caller did not intend.
if [ "$guides_override_set" -eq 1 ] && [ -z "$guides_override" ]; then
  echo "--guides-dir requires a non-empty value" >&2; exit 2
fi

# consumer-root must be an existing directory (cd fails on missing / non-dir).
consumer_root_abs=$(cd "$consumer_root" 2>/dev/null && pwd -P) \
  || { echo "consumer-root is not a directory: $consumer_root" >&2; exit 2; }

# --- locate the canonical templates dir relative to this script ---
script_dir=$(cd "$(dirname "$0")" && pwd -P)
templates_dir=$(cd "$script_dir/../agents/review-guide-templates" 2>/dev/null && pwd -P) \
  || { echo "templates dir not found: $script_dir/../agents/review-guide-templates" >&2; exit 2; }

# --- resolve the guides dir (manifest-aware) via node; enforce lexical guard ---
resolve_guides_dir() {
  # args: <consumer_root_abs> <override_or_empty>; prints resolved abs path or exits 2.
  node -e '
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const override = process.argv[2] || "";
let val;
if (override) {
  val = override;
} else {
  const qp = path.join(root, "quality.json");
  let raw = null;
  try {
    raw = fs.readFileSync(qp, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") { raw = null; }
    else { console.error("cannot read " + qp + ": " + (e && e.message)); process.exit(2); }
  }
  if (raw === null) {
    val = ".agents/review-guides";
  } else {
    let cfg;
    try { cfg = JSON.parse(raw); }
    catch (e) { console.error("invalid JSON in " + qp + ": " + (e && e.message)); process.exit(2); }
    const dr = cfg && cfg.deep_review;
    if (dr && Object.prototype.hasOwnProperty.call(dr, "guides_dir")) {
      val = dr.guides_dir;
      if (typeof val !== "string" || val === "") {
        console.error("deep_review.guides_dir must be a non-empty string"); process.exit(2);
      }
    } else {
      val = ".agents/review-guides";
    }
  }
}
if (path.isAbsolute(val)) {
  console.error("guides_dir must be repo-relative, got absolute path: " + val); process.exit(2);
}
const rootAbs = path.resolve(root);
const resolved = path.resolve(rootAbs, val);
const rel = path.relative(rootAbs, resolved);
if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
  console.error("guides_dir escapes consumer-root: " + val); process.exit(2);
}
process.stdout.write(resolved + "\n");
' "$1" "$2"
}

guides_dir=$(resolve_guides_dir "$consumer_root_abs" "$guides_override") || exit 2

# --- verify the templates dir is non-empty, count the canonical set ---
canon_count=0
for f in "$templates_dir"/*.md; do
  [ -e "$f" ] || continue  # literal glob when no *.md exists
  canon_count=$((canon_count + 1))
done
[ "$canon_count" -gt 0 ] \
  || { echo "no canonical guide templates in $templates_dir" >&2; exit 2; }

# --- seed or check ---
if [ "$check_mode" -eq 1 ]; then
  missing_count=0
  for f in "$templates_dir"/*.md; do
    [ -e "$f" ] || continue
    base="${f##*/}"
    dest="$guides_dir/$base"
    # "present" = ANY existing dirent, incl. a dangling symlink (-L catches what
    # -e misses); never follow, never overwrite.
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      :
    else
      echo "missing review guide: $base" >&2
      missing_count=$((missing_count + 1))
    fi
  done
  if [ "$missing_count" -gt 0 ]; then
    echo "review guides incomplete: $missing_count missing (run: $0 $consumer_root)" >&2
    exit 1
  fi
  echo "review guides: ok ($canon_count)"
  exit 0
fi

mkdir -p "$guides_dir"
seeded_count=0
kept_count=0
seeded_csv=""
for f in "$templates_dir"/*.md; do
  [ -e "$f" ] || continue
  base="${f##*/}"
  dest="$guides_dir/$base"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    kept_count=$((kept_count + 1))
  else
    # Copy via a temp + rename so an interrupted copy can never leave a truncated guide that later
    # runs count as "kept" and --check reports as complete. Stale temps from an interrupted run are
    # swept per canonical name only (this script's own namespace), never by a broad *.md.tmp.* glob.
    rm -f "$dest.tmp."* 2>/dev/null || true
    tmp="$dest.tmp.$$"
    if ! cp "$f" "$tmp"; then rm -f "$tmp"; echo "copy failed: $base" >&2; exit 2; fi
    mv "$tmp" "$dest"
    seeded_count=$((seeded_count + 1))
    if [ -n "$seeded_csv" ]; then seeded_csv="$seeded_csv, $base"; else seeded_csv="$base"; fi
  fi
done

if [ "$seeded_count" -gt 0 ]; then
  echo "seeded: $seeded_count ($seeded_csv)"
else
  echo "seeded: 0"
fi
echo "kept: $kept_count"
