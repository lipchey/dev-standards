#!/usr/bin/env bash
# Thin launcher: preflight a target repo, add the vendor/dev-standards submodule
# at a resolved pin, STAGE the gitlink, then hand off to that pin's
# seed-consumer.sh for all templating/bootstrapping. Every mutation is journaled
# so a failure left in place can be undone on demand with --rollback. Never commits.

set -euo pipefail
export LC_ALL=C

EXIT_USAGE=2
SUBMODULE_PATH='vendor/dev-standards'
HOOKS_TARGET='.githooks'

usage() {
  echo "usage: ds-install.sh [target-dir] [--ref <tag|sha>] [--eslint] [--check] [--rollback]" >&2
}

core_script_dir=$(cd "$(dirname "$0")" && pwd -P)
core_root=$(cd "$core_script_dir/.." && pwd -P)

target='.'
ref=''
want_eslint=false
check_mode=false
rollback_mode=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) [ "$#" -ge 2 ] || { echo "--ref needs a value" >&2; usage; exit "$EXIT_USAGE"; }
           ref="$2"; shift 2 ;;
    --eslint) want_eslint=true; shift ;;
    --check) check_mode=true; shift ;;
    --rollback) rollback_mode=true; shift ;;
    -*) echo "unknown flag: $1" >&2; usage; exit "$EXIT_USAGE" ;;
    *) target="$1"; shift ;;
  esac
done

target_abs=$(cd "$target" 2>/dev/null && pwd -P) \
  || { echo "target is not a directory: $target" >&2; exit "$EXIT_USAGE"; }

git_top=$(git -C "$target_abs" rev-parse --show-toplevel 2>/dev/null || true)
[ "$git_top" = "$target_abs" ] \
  || { echo "target is not a git repository root: $target_abs" >&2; exit "$EXIT_USAGE"; }

rollback() {
  # Terminal handler: disable errexit so a failing cleanup step cannot abort the
  # remaining restoration, and so no rm re-enters the ERR trap.
  set +e
  [ "$rolled_back" = true ] && return 0
  rolled_back=true
  echo "==> install failed — rolling back" >&2

  # A signal mid-seed arrives before the normal post-pipeline harvest; ingest
  # the live seeder output now or its created files would survive rollback.
  if [ -n "$raw" ] && [ -f "$raw" ]; then
    grep '^created:' "$raw" 2>/dev/null | sed 's/^created://' >> "$journal" || true
  fi

  # The journal is fed by child-process stdout, so a `created:` line could name
  # an unrelated path. Delete only lines canonically confined beneath the target;
  # refuse anything outside $target_abs or containing a `/../` traversal.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      "$target_abs"/*) ;;
      *) echo "rollback: refusing unconfined journal path: $f" >&2; continue ;;
    esac
    case "$f" in
      */../*) echo "rollback: refusing journal path with /../: $f" >&2; continue ;;
    esac
    rm -f "$f"
  done < "$journal"

  # A failing child can leave untracked byproducts the journal never captured.
  # The preflight tree was clean, so any of these present-and-untracked was
  # created by this run and is safe to drop (tracked ones are restored below).
  for p in \
    .claude/CHECKLIST.md .claude/code-conventions.md .claude/gate-misses.md .claude/project-facts.md \
    package-lock.json eslint.config.js quality.json; do
    [ -e "$target_abs/$p" ] || continue
    git -C "$target_abs" ls-files --error-unmatch -- "$p" >/dev/null 2>&1 || rm -f "$target_abs/$p"
  done

  # Resolve the module store via plumbing — in a linked worktree $target_abs/.git
  # is a file, not a directory holding modules/.
  git_dir=$(git -C "$target_abs" rev-parse --absolute-git-dir 2>/dev/null || echo "$target_abs/.git")
  if [ "$skip_add" = true ]; then
    # This run did NOT create the submodule; tearing down its repo/metadata could
    # destroy local branches or unpushed objects. Only restore the pre-existing
    # checkout — the gitlink bump is unstaged below.
    git -C "$target_abs/$SUBMODULE_PATH" -c advice.detachedHead=false checkout -q "$old_sub_oid" >/dev/null 2>&1 || true
  else
    git -C "$target_abs" submodule deinit -f -- "$SUBMODULE_PATH" >/dev/null 2>&1 || true
    git -C "$target_abs" rm -q -f -- "$SUBMODULE_PATH" >/dev/null 2>&1 \
      || git -C "$target_abs" rm -q -f --cached -- "$SUBMODULE_PATH" >/dev/null 2>&1 || true
    rm -rf "${target_abs:?}/$SUBMODULE_PATH" "${git_dir:?}/modules/$SUBMODULE_PATH"
  fi

  if [ "$gitmodules_preexisted" = true ]; then
    git -C "$target_abs" restore --staged --worktree -- .gitmodules >/dev/null 2>&1 || true
  else
    git -C "$target_abs" rm -q -f --cached -- .gitmodules >/dev/null 2>&1 || true
    rm -f "$target_abs/.gitmodules"
  fi
  git -C "$target_abs" restore --staged -- "$SUBMODULE_PATH" >/dev/null 2>&1 || true

  if [ "$hooks_preset" != true ] \
     && [ "$(git -C "$target_abs" config --local --get core.hooksPath 2>/dev/null || true)" = "$HOOKS_TARGET" ]; then
    git -C "$target_abs" config --local --unset core.hooksPath >/dev/null 2>&1 || true
  fi

  # Drop install byproducts so `git status` returns to the clean baseline. They
  # are gitignored only while the .gitignore append stands, so remove them
  # explicitly rather than relying on the (now-reverted) ignore rules.
  [ "$node_modules_preexisted" = true ] || rm -rf "${target_abs:?}/node_modules"
  [ "$tools_preexisted" = true ]        || rm -rf "${target_abs:?}/.tools"
  [ "$artifacts_preexisted" = true ]    || rm -rf "${target_abs:?}/.artifacts"
  # Restore only the tracked files the installer may have appended to — never a
  # repo-wide checkout, which would also erase edits made during the long bootstrap.
  for p in .gitignore CLAUDE.md package.json package-lock.json; do
    if git -C "$target_abs" ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
      git -C "$target_abs" checkout -q -- "$p" >/dev/null 2>&1 || true
    fi
  done
}

# --check delegates to the seeder's own verifier; no install, no rollback state.
if [ "$check_mode" = true ]; then
  seeder="$target_abs/$SUBMODULE_PATH/scripts/seed-consumer.sh"
  [ -x "$seeder" ] \
    || { echo "no seeded dev-standards at $target_abs/$SUBMODULE_PATH (install first)" >&2; exit "$EXIT_USAGE"; }
  exec "$seeder" "$target_abs" --check
fi

# --rollback undoes an install a prior failure left in place. A failed install
# leaves a dirty tree, so there is NO clean-tree preflight here — it replays the
# transaction that run persisted under the git dir, then clears the state.
if [ "$rollback_mode" = true ]; then
  git_dir=$(git -C "$target_abs" rev-parse --absolute-git-dir 2>/dev/null || echo "$target_abs/.git")
  state_file="$git_dir/ds-install.state"
  [ -f "$state_file" ] || { echo "nothing to roll back (no $state_file)" >&2; exit "$EXIT_USAGE"; }
  # shellcheck disable=SC1090 # sourced state is written by this same script
  . "$state_file"
  journal="$git_dir/ds-install.journal"
  raw=''
  rolled_back=false
  rollback
  # rollback() is best-effort (set +e inside); only a clean tree proves the
  # baseline is restored — otherwise keep the recovery files for another try.
  if [ -n "$(git -C "$target_abs" status --porcelain 2>/dev/null)" ]; then
    echo "==> rollback incomplete — recovery state kept: $state_file" >&2
    echo "    inspect 'git -C $target_abs status', resolve, re-run --rollback" >&2
    exit 1
  fi
  rm -f "$state_file" "$journal"
  echo "==> rolled back"
  exit 0
fi

# A clean tree is what makes a full rollback achievable.
[ -z "$(git -C "$target_abs" status --porcelain)" ] \
  || { echo "target tree is dirty — commit or stash first: $target_abs" >&2; exit "$EXIT_USAGE"; }

command -v node >/dev/null 2>&1 || { echo "node not found on PATH" >&2; exit "$EXIT_USAGE"; }
command -v npm  >/dev/null 2>&1 || { echo "npm not found on PATH"  >&2; exit "$EXIT_USAGE"; }

core_origin=$(git -C "$core_root" config --get remote.origin.url || true)
[ -n "$core_origin" ] || { echo "core repo has no remote.origin.url: $core_root" >&2; exit "$EXIT_USAGE"; }

# The submodule clones over HTTPS; rewrite the two ssh forms, leave everything
# else (https, local path, file://) untouched.
normalize_url() {
  case "$1" in
    git@*:*) rest="${1#git@}"; printf 'https://%s/%s' "${rest%%:*}" "${rest#*:}" ;;
    ssh://git@*) rest="${1#ssh://git@}"; printf 'https://%s/%s' "${rest%%/*}" "${rest#*/}" ;;
    *) printf '%s' "$1" ;;
  esac
}
submodule_url=$(normalize_url "$core_origin")

# Idempotent re-run: an existing gitlink with a matching URL is fine (skip add).
existing_entry=$(git -C "$target_abs" ls-files -s -- "$SUBMODULE_PATH" 2>/dev/null || true)
skip_add=false
if [ -n "$existing_entry" ]; then
  [ "$(printf '%s' "$existing_entry" | awk '{print $1}')" = "160000" ] \
    || { echo "$SUBMODULE_PATH exists but is not a gitlink" >&2; exit "$EXIT_USAGE"; }
  configured_url=$(git -C "$target_abs" config -f "$target_abs/.gitmodules" \
    --get "submodule.$SUBMODULE_PATH.url" 2>/dev/null || true)
  # A gitlink with no resolvable .gitmodules URL is an unverifiable origin (a
  # locally registered submodule from an unknown source) — refuse it.
  [ -n "$configured_url" ] \
    || { echo "$SUBMODULE_PATH is a gitlink but .gitmodules has no submodule.$SUBMODULE_PATH.url" >&2; exit "$EXIT_USAGE"; }
  if [ "$configured_url" != "$submodule_url" ] && [ "$configured_url" != "$core_origin" ]; then
    echo "$SUBMODULE_PATH already configured with a different URL: $configured_url" >&2
    exit "$EXIT_USAGE"
  fi
  skip_add=true
fi

existing_hooks=$(git -C "$target_abs" config --local --get core.hooksPath 2>/dev/null || true)
if [ -n "$existing_hooks" ] && [ "$existing_hooks" != "$HOOKS_TARGET" ]; then
  echo "core.hooksPath already set to '$existing_hooks' (expected unset or $HOOKS_TARGET)" >&2
  exit "$EXIT_USAGE"
fi
hooks_preset=false
[ "$existing_hooks" = "$HOOKS_TARGET" ] && hooks_preset=true

# Resolve the ref to a full OID from core's origin exactly once (Gate P F10):
# everything downstream pins the OID, never the mutable ref name.
git -C "$core_root" fetch -q --tags origin || { echo "failed to fetch core origin" >&2; exit "$EXIT_USAGE"; }
if [ -z "$ref" ]; then
  ref=$(git -C "$core_root" ls-remote --tags --refs origin 'v*' 2>/dev/null \
        | awk '{print $2}' | sed 's#refs/tags/##' | sort -V | tail -n1)
  [ -n "$ref" ] || { echo "no version tag on origin; pass --ref explicitly" >&2; exit "$EXIT_USAGE"; }
fi
oid=$(git -C "$core_root" rev-parse --verify --end-of-options "${ref}^{commit}" 2>/dev/null) \
  || { echo "cannot resolve --ref '$ref' to a commit" >&2; exit "$EXIT_USAGE"; }

# --- transaction start: persist state + open the journal under the git dir so a
# failure left in place can be undone later with `--rollback`. Both must outlive
# this process, so they live in the git dir, not /tmp. ---
git_dir=$(git -C "$target_abs" rev-parse --absolute-git-dir 2>/dev/null || echo "$target_abs/.git")
state_file="$git_dir/ds-install.state"
journal="$git_dir/ds-install.journal"
# Recovery files live in the git dir, so the clean-tree preflight cannot see
# them: guard explicitly or a second run would overwrite the first failure's
# old_sub_oid/journal and make it unrecoverable.
if [ -e "$state_file" ] || [ -e "$journal" ]; then
  echo "an earlier failed install left recovery state: $state_file" >&2
  echo "run 'scripts/ds-install.sh $target_abs --rollback' first" >&2
  exit "$EXIT_USAGE"
fi
raw=''
old_sub_oid=''
gitmodules_preexisted=false
[ -f "$target_abs/.gitmodules" ] && gitmodules_preexisted=true
# Byproduct dirs that pre-exist (e.g. an adopting Node repo's node_modules) are
# consumer-owned — rollback must only remove what this run brought into being.
node_modules_preexisted=false; [ -e "$target_abs/node_modules" ] && node_modules_preexisted=true
tools_preexisted=false;        [ -e "$target_abs/.tools" ]       && tools_preexisted=true
artifacts_preexisted=false;    [ -e "$target_abs/.artifacts" ]   && artifacts_preexisted=true
rolled_back=false

# Shell-sourceable transaction record read back by `--rollback` in a later run.
write_state() {
  # ref is user input — escape ' for safe re-sourcing; temp+rename so a crash
  # mid-write cannot leave a half-readable record (oids are hex, no escaping).
  local tmp ref_esc
  ref_esc=$(printf '%s' "$ref" | sed "s/'/'\\\\''/g")
  tmp=$(mktemp "$state_file.tmp.XXXXXX") || { echo "cannot write state" >&2; exit 1; }
  cat > "$tmp" <<EOF
skip_add=$skip_add
old_sub_oid='$old_sub_oid'
hooks_preset=$hooks_preset
gitmodules_preexisted=$gitmodules_preexisted
node_modules_preexisted=$node_modules_preexisted
tools_preexisted=$tools_preexisted
artifacts_preexisted=$artifacts_preexisted
oid='$oid'
ref='$ref_esc'
EOF
  mv -f "$tmp" "$state_file"
}
write_state
: > "$journal"

# Terminal FAILURE handler: NO auto-rollback — every mutation is left in place
# for debugging. Ingest any live seeder output into the persistent journal (a
# signal mid-seed arrives before the normal harvest) so `--rollback` can still
# undo, then point the user at the state and the undo command.
fail_handler() {
  set +e
  local rc="$1"
  if [ -n "$raw" ] && [ -f "$raw" ]; then
    grep '^created:' "$raw" 2>/dev/null | sed 's/^created://' >> "$journal" || true
  fi
  echo "==> install failed (exit $rc) — state left in place for debugging" >&2
  echo "    seeder output was streamed above; journal: $journal" >&2
  echo "    undo: scripts/ds-install.sh $target_abs --rollback" >&2
}
# The explicit exit is load-bearing: fail_handler's `set +e` cancels the pending
# errexit termination, so without it the script would CONTINUE past the failed
# command against half-applied state (verified empirically). set -e alone must
# not be relied on.
# shellcheck disable=SC2154 # rc is assigned inside this same trap string
trap 'rc=$?; fail_handler "$rc"; exit "$rc"' ERR
trap 'fail_handler 130; exit 130' INT TERM

if [ "$skip_add" = true ]; then
  git -C "$target_abs" submodule update --init -- "$SUBMODULE_PATH"
  # Capture the pin being replaced so rollback can restore it without tearing
  # down a submodule repo this run did not create, then re-persist the state.
  old_sub_oid=$(git -C "$target_abs/$SUBMODULE_PATH" rev-parse HEAD)
  write_state
else
  git -C "$target_abs" submodule add "$submodule_url" "$SUBMODULE_PATH"
fi
git -C "$target_abs/$SUBMODULE_PATH" -c advice.detachedHead=false checkout "$oid"
# Stage the gitlink BEFORE bootstrap (Gate P F1) so `git submodule update` inside
# bootstrap keeps this OID and verify's index-gitlink guard passes.
git -C "$target_abs" add -- "$SUBMODULE_PATH"
[ -f "$target_abs/.gitmodules" ] && git -C "$target_abs" add -- .gitmodules

seeder="$target_abs/$SUBMODULE_PATH/scripts/seed-consumer.sh"
if [ ! -x "$seeder" ]; then
  echo "--ref '$ref' predates the adoption kit (no scripts/seed-consumer.sh — needs >= v0.9.0)" >&2
  fail_handler 1
  exit 1
fi

seed_args=("$target_abs" --repo-name "$(basename "$target_abs")")
[ "$want_eslint" = true ] && seed_args+=(--eslint)

# Capture the seeder's output live (tee) and harvest its `created:` lines into
# the journal for rollback. PIPESTATUS keeps the seeder's real exit past tee.
raw=$(mktemp "${TMPDIR:-/tmp}/ds-install-seed.XXXXXX")
set +e
"$seeder" "${seed_args[@]}" 2>&1 | tee "$raw"
seed_status=${PIPESTATUS[0]}
set -e
grep '^created:' "$raw" | sed 's/^created://' >> "$journal" || true
rm -f "$raw"
if [ "$seed_status" -ne 0 ]; then
  echo "seed-consumer failed (exit $seed_status)" >&2
  fail_handler "$seed_status"
  exit "$seed_status"
fi

trap - ERR INT TERM
rm -f "$state_file" "$journal"
echo
echo "==> dev-standards installed into $target_abs at $ref ($oid)"
echo "    The gitlink is staged (not committed) — review, then commit."
