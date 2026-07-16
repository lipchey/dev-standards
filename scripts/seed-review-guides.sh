#!/usr/bin/env bash
# Existing destination dirents are consumer-owned state and must never be replaced.
# The fixed instance-doc path must remain lexically contained by the consumer root.

set -euo pipefail
export LC_ALL=C

EXIT_INCOMPLETE=1
EXIT_USAGE=2
INSTANCE_DOCS_DIR_REL='.claude'

usage() {
  echo "usage: seed-review-guides.sh <consumer-root> [--check]" >&2
}

consumer_root=''
check_mode=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      check_mode=true
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

consumer_root_abs=$(cd "$consumer_root" 2>/dev/null && pwd -P) \
  || { echo "consumer-root is not a directory: $consumer_root" >&2; exit "$EXIT_USAGE"; }

case "$INSTANCE_DOCS_DIR_REL" in
  /*|..|../*|*/../*)
    echo "instance-doc path escapes consumer-root: $INSTANCE_DOCS_DIR_REL" >&2
    exit "$EXIT_USAGE"
    ;;
esac
instance_docs_dir="$consumer_root_abs/$INSTANCE_DOCS_DIR_REL"

# Lexical containment alone is not enough: a symlinked docs dir would route
# writes (and check reads) outside the consumer — e.g. `.claude -> ~/.claude`
# would seed into the user's global tooling. Scope: this closes the PASSIVE
# hazard (a pre-existing symlink). An ACTIVE racer swapping the dir between
# check and write is accepted residual risk — anything positioned to run that
# race already executes arbitrary code via the repo's hooks/npm scripts.
require_docs_dir_confined() {
  if [ -L "$instance_docs_dir" ]; then
    echo "instance-doc dir is a symlink: $INSTANCE_DOCS_DIR_REL" >&2
    exit "$EXIT_USAGE"
  fi
  if [ -d "$instance_docs_dir" ]; then
    resolved_docs_dir=$(cd "$instance_docs_dir" && pwd -P) \
      || { echo "instance-doc dir unreadable: $INSTANCE_DOCS_DIR_REL" >&2; exit "$EXIT_USAGE"; }
    case "$resolved_docs_dir" in
      "$consumer_root_abs"|"$consumer_root_abs"/*) ;;
      *)
        echo "instance-doc dir escapes consumer-root: $resolved_docs_dir" >&2
        exit "$EXIT_USAGE"
        ;;
    esac
  fi
}

script_dir=$(cd "$(dirname "$0")" && pwd -P)
agents_templates_dir=$(cd "$script_dir/../agents" 2>/dev/null && pwd -P) \
  || { echo "templates dir not found: $script_dir/../agents" >&2; exit "$EXIT_USAGE"; }

instance_template_files=(
  "$agents_templates_dir/checklist-template.md"
  "$agents_templates_dir/code-conventions-template.md"
  "$agents_templates_dir/gate-misses-template.md"
  "$agents_templates_dir/project-facts-template.md"
  "$agents_templates_dir/two-stage-dev-marker-template.md"
)
instance_destination_names=(
  'CHECKLIST.md'
  'code-conventions.md'
  'gate-misses.md'
  'project-facts.md'
  'two-stage-dev.marker'
)
instance_doc_count=${#instance_template_files[@]}

instance_index=0
while [ "$instance_index" -lt "$instance_doc_count" ]; do
  instance_template=${instance_template_files[$instance_index]}
  [ -f "$instance_template" ] \
    || { echo "instance-doc template not found: $instance_template" >&2; exit "$EXIT_USAGE"; }
  instance_index=$((instance_index + 1))
done

if [ "$check_mode" = true ]; then
  require_docs_dir_confined
  missing_count=0
  instance_index=0
  while [ "$instance_index" -lt "$instance_doc_count" ]; do
    instance_name=${instance_destination_names[$instance_index]}
    destination_path="$instance_docs_dir/$instance_name"
    # [ -f ] dereferences: a consumer-owned symlink to a real file passes,
    # while a directory, FIFO or dangling symlink must fail the gate.
    if [ ! -f "$destination_path" ]; then
      echo "missing instance doc: $instance_name" >&2
      missing_count=$((missing_count + 1))
    fi
    instance_index=$((instance_index + 1))
  done

  if [ "$missing_count" -gt 0 ]; then
    echo "instance docs incomplete: $missing_count missing (run: $0 $consumer_root)" >&2
    exit "$EXIT_INCOMPLETE"
  fi
  echo "instance docs: ok ($instance_doc_count)"
  exit 0
fi

require_docs_dir_confined
mkdir -p "$instance_docs_dir"
require_docs_dir_confined
seeded_count=0
kept_count=0
seeded_names=''

# Only the temp THIS run created may ever be cleaned up: a name-pattern sweep
# would delete consumer-owned lookalikes (`CHECKLIST.md.tmp.notes`) and a
# concurrent seeder's live temp. The trap covers signal/unexpected exits;
# every regular path clears the variable after its own rm.
active_temporary_path=''
cleanup_active_temporary() {
  if [ -n "$active_temporary_path" ]; then
    rm -f "$active_temporary_path"
  fi
}
trap cleanup_active_temporary EXIT

copy_if_absent() {
  source_path="$1"
  destination_path="$2"
  display_name="$3"
  if [ -e "$destination_path" ] || [ -L "$destination_path" ]; then
    kept_count=$((kept_count + 1))
    return
  fi

  # mktemp (O_EXCL, random suffix) closes the pre-planted-temp race a
  # predictable `$$` name leaves open; the copy then writes only into a file
  # this run itself created.
  temporary_path=$(mktemp "$destination_path.tmp.XXXXXX") \
    || { echo "temp create failed: $display_name" >&2; exit "$EXIT_USAGE"; }
  active_temporary_path="$temporary_path"
  if ! cp "$source_path" "$temporary_path"; then
    rm -f "$temporary_path"; active_temporary_path=''
    echo "copy failed: $display_name" >&2
    exit "$EXIT_USAGE"
  fi
  chmod 644 "$temporary_path"
  # link(2) is the portable ATOMIC no-clobber publish: `mv -n` re-checks then
  # renames, so a destination created between its check and the rename is
  # silently overwritten. ln either publishes or fails; a destination that
  # appeared after the absence check is consumer-owned and wins.
  if ln "$temporary_path" "$destination_path" 2>/dev/null; then
    rm -f "$temporary_path"; active_temporary_path=''
  else
    rm -f "$temporary_path"; active_temporary_path=''
    if [ -e "$destination_path" ] || [ -L "$destination_path" ]; then
      kept_count=$((kept_count + 1))
      return
    fi
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

instance_index=0
while [ "$instance_index" -lt "$instance_doc_count" ]; do
  instance_template=${instance_template_files[$instance_index]}
  instance_name=${instance_destination_names[$instance_index]}
  copy_if_absent "$instance_template" "$instance_docs_dir/$instance_name" "$instance_name"
  instance_index=$((instance_index + 1))
done

if [ "$seeded_count" -gt 0 ]; then
  echo "seeded instance docs: $seeded_count ($seeded_names)"
else
  echo "seeded instance docs: 0"
fi
echo "kept instance docs: $kept_count"
