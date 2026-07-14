#!/usr/bin/env bash
# Bump the vendor/dev-standards submodule pin across local consumers to a target
# ref, one atomic transaction per consumer. Continue-on-error: a per-consumer
# failure rolls that consumer back to its old pin (and re-bootstraps its stamps),
# the run exits non-zero, and other consumers are untouched. No pushes.

# NOT set -e: per-consumer failures are caught and the run continues.
set -uo pipefail
export LC_ALL=C

EXIT_USAGE=2
SUBMODULE_PATH='vendor/dev-standards'

usage() { echo "usage: ds-update-pins.sh [--ref <tag|sha>] [--dry-run] [--keep-on-failure] [roots...]" >&2; }

core_script_dir=$(cd "$(dirname "$0")" && pwd -P)
core_root=$(cd "$core_script_dir/.." && pwd -P)

ref=''
dry_run=false
keep_on_failure=false
roots=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) [ "$#" -ge 2 ] || { echo "--ref needs a value" >&2; usage; exit "$EXIT_USAGE"; }
           ref="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --keep-on-failure) keep_on_failure=true; shift ;;
    -*) echo "unknown flag: $1" >&2; usage; exit "$EXIT_USAGE" ;;
    *) roots+=("$1"); shift ;;
  esac
done

[ "${#roots[@]}" -gt 0 ] || roots=("$HOME/Projects")
worktrees_dir="$HOME/Projects/worktrees"

# Default ref = the highest vX.Y.Z tag on origin; every consumer's submodule
# shares that origin, so one resolution names the same commit everywhere.
if [ -z "$ref" ]; then
  git -C "$core_root" fetch -q --tags origin 2>/dev/null || true
  ref=$(git -C "$core_root" ls-remote --tags --refs origin 'v*' 2>/dev/null \
        | awk '{print $2}' | sed 's#refs/tags/##' | sort -V | tail -n1)
  [ -n "$ref" ] || { echo "no version tag on origin; pass --ref explicitly" >&2; exit "$EXIT_USAGE"; }
fi
echo "target ref: $ref"

# Discover consumers: any repo under the roots whose .gitmodules wires the
# dev-standards submodule path. Shallow scan — repos live near the top.
consumers=()
for root in "${roots[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r gm; do
    dir=$(dirname "$gm")
    case "$dir/" in "$worktrees_dir"/*) continue ;; esac
    [ "$dir" = "$core_root" ] && continue
    grep -q "path *= *$SUBMODULE_PATH" "$gm" 2>/dev/null && consumers+=("$dir")
  done < <(find "$root" -maxdepth 4 -type f -name .gitmodules 2>/dev/null)
done

if [ "${#consumers[@]}" -eq 0 ]; then
  echo "no dev-standards consumers found under: ${roots[*]}"
  exit 0
fi

updated_count=0
skipped_count=0
fail_count=0

# Roll the in-flight consumer back to its old pin, then PROVE the restoration:
# index gitlink, submodule HEAD, and both dist stamps must all equal old_oid, or
# the old pin could be paired with new/missing bundles. Reads the globals set
# just before the transaction so the signal trap can reuse it.
rollback_consumer() {
  echo "  rolling back to ${old_oid:0:7}"
  git -C "$consumer" restore --staged -- "$SUBMODULE_PATH" >/dev/null 2>&1 || true
  git -C "$sub" -c advice.detachedHead=false checkout -q "$old_oid" >/dev/null 2>&1 || true
  ( cd "$consumer" && ./scripts/ds-bootstrap.sh ) >/dev/null 2>&1 || true

  local idx head runner_stamp dr_stamp
  idx=$(git -C "$consumer" ls-files -s -- "$SUBMODULE_PATH" 2>/dev/null | awk '{print $2}')
  head=$(git -C "$sub" rev-parse HEAD 2>/dev/null || true)
  runner_stamp=$(cat "$sub/runner/dist/.built-from" 2>/dev/null || true)
  dr_stamp=$(cat "$sub/deep-review/dist/.built-from" 2>/dev/null || true)
  if [ "$idx" != "$old_oid" ] || [ "$head" != "$old_oid" ] \
     || [ "$runner_stamp" != "$old_oid" ] || [ "$dr_stamp" != "$old_oid" ]; then
    echo "  ROLLBACK FAILED: $consumer — restore by hand (checkout $old_oid in vendor/dev-standards, re-run scripts/ds-bootstrap.sh)" >&2
  fi
}

# On a caught transaction failure: default rolls the in-flight consumer back to
# its old pin; --keep-on-failure instead leaves the half-applied state in place
# for debugging and just prints the manual restore recipe. Either way the caller
# counts the consumer failed.
handle_failure() {
  if [ "$keep_on_failure" = true ]; then
    echo "  kept for debugging (log: $boot_log)"
    # Unstage FIRST: bootstrap runs `git submodule update`, which resets the
    # checkout to the staged gitlink — restoring after it would undo the checkout.
    printf '  restore: git -C %q restore --staged %s && git -C %q checkout %s && (cd %q && scripts/ds-bootstrap.sh)\n' \
      "$consumer" "$SUBMODULE_PATH" "$sub" "$old_oid" "$consumer"
  else
    rollback_consumer
  fi
}

# An interrupt mid-transaction must resolve the in-flight consumer before
# exiting; `started` is true only while one is under mutation.
started=false
consumer=''; sub=''; old_oid=''; boot_log=''
trap 'if [ "$started" = true ]; then echo "  interrupted"; handle_failure; fi; exit 130' INT TERM

for consumer in "${consumers[@]}"; do
  echo "--- $consumer"
  sub="$consumer/$SUBMODULE_PATH"
  if [ ! -d "$sub" ]; then
    echo "  skip: $SUBMODULE_PATH not initialized (run scripts/ds-bootstrap.sh)"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  git -C "$sub" fetch -q --tags origin 2>/dev/null || true
  new_oid=$(git -C "$sub" rev-parse --verify --end-of-options "${ref}^{commit}" 2>/dev/null || true)
  if [ -z "$new_oid" ]; then
    echo "  FAIL: cannot resolve ref '$ref' in $sub"
    fail_count=$((fail_count + 1))
    continue
  fi
  old_oid=$(git -C "$sub" rev-parse HEAD 2>/dev/null || true)
  if [ "$old_oid" = "$new_oid" ]; then
    echo "  ok: already at ${new_oid:0:7}"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  # The dirty check is a non-mutating preflight, so run it before the dry-run
  # branch too. A failed probe (index/permission/corruption) is not proof of a
  # clean tree — count it as a failure instead of proceeding.
  if ! status_out=$(git -C "$consumer" status --porcelain 2>/dev/null); then
    echo "  FAIL: cannot probe tree status"
    fail_count=$((fail_count + 1))
    continue
  fi
  tree_dirty=false
  [ -n "$status_out" ] && tree_dirty=true

  if [ "$dry_run" = true ]; then
    if [ "$tree_dirty" = true ]; then
      echo "  would skip: tree dirty"
      skipped_count=$((skipped_count + 1))
    else
      echo "  would bump ${old_oid:0:7} -> ${new_oid:0:7}"
    fi
    continue
  fi

  if [ "$tree_dirty" = true ]; then
    echo "  skip: tree is dirty"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  echo "  bumping ${old_oid:0:7} -> ${new_oid:0:7}"
  ok=true
  # --absolute-git-dir resolves the real store even in a linked worktree, where
  # $consumer/.git is a file, not a directory. Set before started=true so an
  # early signal's keep-on-failure message never prints an empty log path.
  boot_log="$(git -C "$consumer" rev-parse --absolute-git-dir)/ds-bump-bootstrap.log"
  started=true

  # One transaction: checkout NEW -> stage gitlink BEFORE bootstrap (so the
  # submodule update inside bootstrap keeps NEW) -> rebuild/stamp -> verify ->
  # commit only the gitlink. Any failure trips the rollback below.
  git -C "$sub" -c advice.detachedHead=false checkout -q "$new_oid" 2>/dev/null \
    || { echo "  FAIL: checkout $new_oid"; ok=false; }
  [ "$ok" = true ] && { git -C "$consumer" add -- "$SUBMODULE_PATH" || { echo "  FAIL: staging gitlink"; ok=false; }; }
  [ "$ok" = true ] && { ( cd "$consumer" && ./scripts/ds-bootstrap.sh ) >"$boot_log" 2>&1 || { echo "  FAIL: ds-bootstrap (log: $boot_log)"; ok=false; }; }
  [ "$ok" = true ] && { ( cd "$consumer" && ./scripts/verify --fast ) || { echo "  FAIL: verify --fast"; ok=false; }; }
  if [ "$ok" = true ]; then
    # Only the gitlink is staged, so a plain commit records only the pin; the
    # consumer's own hooks run normally on it.
    # Pathspec-confined: hooks or gates that staged something else during the
    # transaction cannot ride into the pin commit.
    if git -C "$consumer" commit -q -m "chore(dev-standards): bump submodule pin ${old_oid:0:7} -> ${new_oid:0:7}" -- "$SUBMODULE_PATH"; then
      started=false
      echo "  updated -> ${new_oid:0:7}"
      updated_count=$((updated_count + 1))
    else
      echo "  FAIL: commit"; ok=false
    fi
  fi

  if [ "$ok" != true ]; then
    handle_failure
    fail_count=$((fail_count + 1))
  fi
  started=false
done

echo
if [ "$dry_run" = true ]; then
  echo "dry-run: no changes made"
  # Resolution/probe failures were still counted during the read-only pass.
  [ "$fail_count" -eq 0 ]
  exit
fi
echo "summary: $updated_count updated, $skipped_count skipped, $fail_count failed"
[ "$fail_count" -eq 0 ]
