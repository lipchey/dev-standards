#!/usr/bin/env bash
# Existing destination dirents are consumer-owned state and must never be replaced.
# Both the fixed instance-doc path and configurable guides path must remain
# lexically contained by the consumer root.

set -euo pipefail
export LC_ALL=C

EXIT_INCOMPLETE=1
EXIT_USAGE=2
INSTANCE_DOCS_DIR_REL='.claude'

usage() {
  echo "usage: seed-review-guides.sh <consumer-root> [--check] [--guides-dir <rel>]" >&2
}

consumer_root=''
check_mode=false
guides_override=''
guides_override_set=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      check_mode=true
      shift
      ;;
    --guides-dir)
      shift
      [ "$#" -gt 0 ] || { echo "--guides-dir requires a value" >&2; exit "$EXIT_USAGE"; }
      guides_override="$1"
      guides_override_set=true
      shift
      ;;
    --guides-dir=*)
      guides_override="${1#--guides-dir=}"
      guides_override_set=true
      shift
      ;;
    -*)
      echo "unknown flag: $1" >&2
      usage
      exit "$EXIT_USAGE"
      ;;
    *)
      if [ -z "$consumer_root" ]; then
        consumer_root="$1"
        shift
      else
        echo "unexpected argument: $1" >&2
        usage
        exit "$EXIT_USAGE"
      fi
      ;;
  esac
done

[ -n "$consumer_root" ] || { usage; exit "$EXIT_USAGE"; }
if [ "$guides_override_set" = true ] && [ -z "$guides_override" ]; then
  echo "--guides-dir requires a non-empty value" >&2
  exit "$EXIT_USAGE"
fi

consumer_root_abs=$(cd "$consumer_root" 2>/dev/null && pwd -P) \
  || { echo "consumer-root is not a directory: $consumer_root" >&2; exit "$EXIT_USAGE"; }

script_dir=$(cd "$(dirname "$0")" && pwd -P)
agents_templates_dir=$(cd "$script_dir/../agents" 2>/dev/null && pwd -P) \
  || { echo "templates dir not found: $script_dir/../agents" >&2; exit "$EXIT_USAGE"; }
guide_templates_dir="$agents_templates_dir/review-guide-templates"
[ -d "$guide_templates_dir" ] \
  || { echo "templates dir not found: $guide_templates_dir" >&2; exit "$EXIT_USAGE"; }

instance_template_files=(
  "$agents_templates_dir/checklist-template.md"
  "$agents_templates_dir/code-conventions-template.md"
  "$agents_templates_dir/gate-misses-template.md"
  "$agents_templates_dir/project-facts-template.md"
)
instance_destination_names=(
  'CHECKLIST.md'
  'code-conventions.md'
  'gate-misses.md'
  'project-facts.md'
)
instance_doc_count=${#instance_template_files[@]}

resolve_guides_dir() {
  node -e '
const fs = require("fs");
const path = require("path");
const EXIT_USAGE = 2;
const root = process.argv[1];
const override = process.argv[2] || "";
let configuredGuidesDir;
if (override) {
  configuredGuidesDir = override;
} else {
  const qualityPath = path.join(root, "quality.json");
  let rawManifest = null;
  try {
    rawManifest = fs.readFileSync(qualityPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      rawManifest = null;
    } else {
      console.error("cannot read " + qualityPath + ": " + (error && error.message));
      process.exit(EXIT_USAGE);
    }
  }
  if (rawManifest === null) {
    configuredGuidesDir = ".claude/review-guides";
  } else {
    let manifest;
    try {
      manifest = JSON.parse(rawManifest);
    } catch (error) {
      console.error("invalid JSON in " + qualityPath + ": " + (error && error.message));
      process.exit(EXIT_USAGE);
    }
    const deepReview = manifest && manifest.deep_review;
    if (deepReview && Object.prototype.hasOwnProperty.call(deepReview, "guides_dir")) {
      configuredGuidesDir = deepReview.guides_dir;
      if (typeof configuredGuidesDir !== "string" || configuredGuidesDir === "") {
        console.error("deep_review.guides_dir must be a non-empty string");
        process.exit(EXIT_USAGE);
      }
    } else {
      configuredGuidesDir = ".claude/review-guides";
    }
  }
}
if (path.isAbsolute(configuredGuidesDir)) {
  console.error("guides_dir must be repo-relative, got absolute path: " + configuredGuidesDir);
  process.exit(EXIT_USAGE);
}
const rootAbs = path.resolve(root);
const resolvedGuidesDir = path.resolve(rootAbs, configuredGuidesDir);
const relativeGuidesDir = path.relative(rootAbs, resolvedGuidesDir);
if (
  relativeGuidesDir === ".." ||
  relativeGuidesDir.startsWith(".." + path.sep) ||
  path.isAbsolute(relativeGuidesDir)
) {
  console.error("guides_dir escapes consumer-root: " + configuredGuidesDir);
  process.exit(EXIT_USAGE);
}
process.stdout.write(resolvedGuidesDir + "\n");
' "$1" "$2"
}

guides_dir=$(resolve_guides_dir "$consumer_root_abs" "$guides_override") || exit "$EXIT_USAGE"
instance_docs_dir="$consumer_root_abs/$INSTANCE_DOCS_DIR_REL"

canonical_guide_count=0
for template_file in "$guide_templates_dir"/*.md; do
  [ -e "$template_file" ] || continue
  canonical_guide_count=$((canonical_guide_count + 1))
done
[ "$canonical_guide_count" -gt 0 ] \
  || { echo "no canonical guide templates in $guide_templates_dir" >&2; exit "$EXIT_USAGE"; }

instance_index=0
while [ "$instance_index" -lt "$instance_doc_count" ]; do
  instance_template=${instance_template_files[$instance_index]}
  [ -f "$instance_template" ] \
    || { echo "instance-doc template not found: $instance_template" >&2; exit "$EXIT_USAGE"; }
  instance_index=$((instance_index + 1))
done

if [ "$check_mode" = true ]; then
  missing_count=0
  for template_file in "$guide_templates_dir"/*.md; do
    [ -e "$template_file" ] || continue
    guide_name=${template_file##*/}
    destination_path="$guides_dir/$guide_name"
    if [ ! -e "$destination_path" ] && [ ! -L "$destination_path" ]; then
      echo "missing review guide: $guide_name" >&2
      missing_count=$((missing_count + 1))
    fi
  done

  instance_index=0
  while [ "$instance_index" -lt "$instance_doc_count" ]; do
    instance_name=${instance_destination_names[$instance_index]}
    destination_path="$instance_docs_dir/$instance_name"
    if [ ! -e "$destination_path" ] && [ ! -L "$destination_path" ]; then
      echo "missing instance doc: $instance_name" >&2
      missing_count=$((missing_count + 1))
    fi
    instance_index=$((instance_index + 1))
  done

  if [ "$missing_count" -gt 0 ]; then
    echo "onboarding files incomplete: $missing_count missing (run: $0 $consumer_root)" >&2
    exit "$EXIT_INCOMPLETE"
  fi
  echo "review guides: ok ($canonical_guide_count)"
  echo "instance docs: ok ($instance_doc_count)"
  exit 0
fi

mkdir -p "$guides_dir" "$instance_docs_dir"
seeded_count=0
kept_count=0
seeded_names=''

copy_if_absent() {
  source_path="$1"
  destination_path="$2"
  display_name="$3"
  if [ -e "$destination_path" ] || [ -L "$destination_path" ]; then
    kept_count=$((kept_count + 1))
    return
  fi

  # Per-destination cleanup avoids deleting repo-owned files that merely resemble temps.
  rm -f "$destination_path.tmp."* 2>/dev/null || true
  temporary_path="$destination_path.tmp.$$"
  if ! cp "$source_path" "$temporary_path"; then
    rm -f "$temporary_path"
    echo "copy failed: $display_name" >&2
    exit "$EXIT_USAGE"
  fi
  if ! mv "$temporary_path" "$destination_path"; then
    rm -f "$temporary_path"
    echo "publish failed: $display_name" >&2
    exit "$EXIT_USAGE"
  fi
  seeded_count=$((seeded_count + 1))
  if [ -n "$seeded_names" ]; then
    seeded_names="$seeded_names, $display_name"
  else
    seeded_names="$display_name"
  fi
}

for template_file in "$guide_templates_dir"/*.md; do
  [ -e "$template_file" ] || continue
  guide_name=${template_file##*/}
  copy_if_absent "$template_file" "$guides_dir/$guide_name" "$guide_name"
done

instance_index=0
while [ "$instance_index" -lt "$instance_doc_count" ]; do
  instance_template=${instance_template_files[$instance_index]}
  instance_name=${instance_destination_names[$instance_index]}
  copy_if_absent "$instance_template" "$instance_docs_dir/$instance_name" "$instance_name"
  instance_index=$((instance_index + 1))
done

if [ "$seeded_count" -gt 0 ]; then
  echo "seeded: $seeded_count ($seeded_names)"
else
  echo "seeded: 0"
fi
echo "kept: $kept_count"
