#!/usr/bin/env bash
# Runs from inside the package (vendor/dev-standards/scripts) so the templates it
# lays down always match the checked-out submodule revision — no core-vs-pin skew.
# Every file is copy-if-absent: a filled consumer file is repo-owned and is never
# clobbered. Prints one `created:<abs-path>` line per file it creates so a caller
# (ds-install.sh) can journal them for rollback. Never commits.

set -euo pipefail
export LC_ALL=C

EXIT_USAGE=2
MARKER='dev-standards:managed-section'
REPO_NAME_TOKEN='__DS_REPO_NAME__'

usage() {
  echo "usage: seed-consumer.sh <consumer-root> [--repo-name <name>] [--eslint] [--check]" >&2
}

consumer_root=''
repo_name=''
want_eslint=false
check_mode=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-name)
      [ "$#" -ge 2 ] || { echo "--repo-name needs a value" >&2; usage; exit "$EXIT_USAGE"; }
      repo_name="$2"; shift 2 ;;
    --eslint) want_eslint=true; shift ;;
    --check) check_mode=true; shift ;;
    -*) echo "unknown flag: $1" >&2; usage; exit "$EXIT_USAGE" ;;
    *)
      if [ -z "$consumer_root" ]; then consumer_root="$1"; shift
      else echo "unexpected argument: $1" >&2; usage; exit "$EXIT_USAGE"; fi ;;
  esac
done

[ -n "$consumer_root" ] || { usage; exit "$EXIT_USAGE"; }
consumer_root_abs=$(cd "$consumer_root" 2>/dev/null && pwd -P) \
  || { echo "consumer-root is not a directory: $consumer_root" >&2; exit "$EXIT_USAGE"; }

script_dir=$(cd "$(dirname "$0")" && pwd -P)
package_root=$(cd "$script_dir/.." && pwd -P)
templates_dir="$package_root/templates/consumer"
[ -d "$templates_dir" ] \
  || { echo "consumer templates not found: $templates_dir (pin predates the adoption kit)" >&2; exit "$EXIT_USAGE"; }

vendor="$consumer_root_abs/vendor/dev-standards"

if [ "$check_mode" = true ]; then
  ok=true

  entry=$(git -C "$consumer_root_abs" ls-files -s -- vendor/dev-standards 2>/dev/null || true)
  if [ "$(printf '%s' "$entry" | awk '{print $1}')" != "160000" ]; then
    echo "check: vendor/dev-standards is not a tracked gitlink" >&2; ok=false
  fi

  for shim in scripts/verify scripts/deep-review scripts/ds-bootstrap.sh; do
    { [ -f "$consumer_root_abs/$shim" ] && [ -x "$consumer_root_abs/$shim" ]; } \
      || { echo "check: not an executable file: $shim" >&2; ok=false; }
  done

  "$package_root/scripts/seed-review-guides.sh" "$consumer_root_abs" --check || ok=false

  # A stamp that does not match the checked-out submodule means the bundles were
  # built for a different pin — the shims would refuse to run them.
  pinned=$(git -C "$vendor" rev-parse HEAD 2>/dev/null || echo unknown)

  # The recorded gitlink OID must equal the submodule's checked-out HEAD, or the
  # pin and the working submodule have drifted.
  index_oid=$(printf '%s' "$entry" | awk '{print $2}')
  if [ "$index_oid" != "$pinned" ]; then
    echo "check: index gitlink ($index_oid) != submodule HEAD ($pinned)" >&2; ok=false
  fi

  for built in runner deep-review; do
    stamp=$(cat "$vendor/$built/dist/.built-from" 2>/dev/null || echo none)
    if [ "$stamp" != "$pinned" ]; then
      echo "check: $built bundle stamp ($stamp) != submodule HEAD ($pinned) — run scripts/ds-bootstrap.sh" >&2
      ok=false
    fi
  done

  [ -f "$consumer_root_abs/quality.json" ] || { echo "check: missing quality.json" >&2; ok=false; }

  hooks_path=$(git -C "$consumer_root_abs" config --local --get core.hooksPath 2>/dev/null || true)
  [ "$hooks_path" = ".githooks" ] || { echo "check: core.hooksPath is '$hooks_path' (expected .githooks)" >&2; ok=false; }

  for x in .githooks/pre-commit .githooks/pre-push tools/run-gitleaks; do
    { [ -f "$consumer_root_abs/$x" ] && [ -x "$consumer_root_abs/$x" ]; } \
      || { echo "check: not an executable file: $x" >&2; ok=false; }
  done

  if [ "$ok" = true ]; then echo "consumer install: ok"; exit 0; fi
  echo "consumer install: incomplete" >&2
  exit 1
fi

# Validate the repo name BEFORE any managed write — a late rejection would leave
# a partial install behind when seed-consumer.sh is invoked directly.
[ -n "$repo_name" ] || repo_name=$(basename "$consumer_root_abs")
case "$repo_name" in
  ''|*[!A-Za-z0-9._-]*) echo "invalid repo name (allowed: A-Za-z0-9._-): $repo_name" >&2; exit "$EXIT_USAGE" ;;
esac

# Only the temp THIS run created may be cleaned up; the trap covers signal exits,
# every regular path clears the variable after its own rm (seed-review-guides idiom).
active_tmp=''
cleanup_active_tmp() { [ -n "$active_tmp" ] && rm -f "$active_tmp"; return 0; }
trap cleanup_active_tmp EXIT

# A managed write's parent dir must resolve inside the consumer root; a symlinked
# ancestor (e.g. `.claude -> ~/.claude`, `scripts -> /outside`) would route the
# write and its rollback outside the target. Mirrors seed-review-guides.sh.
confine_dir() {
  # Walk up to the nearest EXISTING ancestor so confinement runs BEFORE mkdir -p
  # — checking after would already have created dirs through a symlinked parent.
  d="$1"
  while [ ! -e "$d" ]; do d=$(dirname "$d"); done
  d=$(cd "$d" 2>/dev/null && pwd -P) \
    || { echo "confine: unreadable dir: $1" >&2; exit "$EXIT_USAGE"; }
  case "$d" in
    "$consumer_root_abs"|"$consumer_root_abs"/*) ;;
    *) echo "confine: managed write escapes consumer root: $d" >&2; exit "$EXIT_USAGE" ;;
  esac
}

# Append targets must be regular files: appending through a symlinked
# .gitignore/CLAUDE.md would write outside the consumer despite a confined parent.
reject_symlink() {
  [ -L "$1" ] && { echo "confine: refusing symlinked append target: $1" >&2; exit "$EXIT_USAGE"; }
  return 0
}

# Copy $src -> $dest (mode $mode) only when $dest is absent. Optional $render is a
# sed program applied during the copy (token substitution). Emits `created:<dest>`
# when it actually creates the file. Publish is atomic no-clobber via ln: a file
# that appeared after the absence check is consumer-owned and wins.
copy_if_absent() {
  src="$1"; dest="$2"; mode="$3"; render="${4:-}"
  if [ -e "$dest" ] || [ -L "$dest" ]; then return 0; fi
  confine_dir "$(dirname "$dest")"
  mkdir -p "$(dirname "$dest")"
  active_tmp=$(mktemp "$dest.tmp.XXXXXX") \
    || { echo "temp create failed: $dest" >&2; exit "$EXIT_USAGE"; }
  if [ -n "$render" ]; then
    sed "$render" "$src" > "$active_tmp" \
      || { rm -f "$active_tmp"; active_tmp=''; echo "render failed: $dest" >&2; exit "$EXIT_USAGE"; }
  else
    cp "$src" "$active_tmp" \
      || { rm -f "$active_tmp"; active_tmp=''; echo "copy failed: $dest" >&2; exit "$EXIT_USAGE"; }
  fi
  chmod "$mode" "$active_tmp"
  if ln "$active_tmp" "$dest" 2>/dev/null; then
    rm -f "$active_tmp"; active_tmp=''
    printf 'created:%s\n' "$dest"
  else
    rm -f "$active_tmp"; active_tmp=''
    if [ -e "$dest" ] || [ -L "$dest" ]; then return 0; fi
    echo "publish failed: $dest" >&2; exit "$EXIT_USAGE"
  fi
}

# Executable shims/hooks get 755; data files 644. Exec bit is set on the temp
# before ln (a hard link shares the inode mode).
copy_if_absent "$templates_dir/scripts/ds-bootstrap.sh"     "$consumer_root_abs/scripts/ds-bootstrap.sh"      755
copy_if_absent "$templates_dir/scripts/verify"              "$consumer_root_abs/scripts/verify"               755
copy_if_absent "$templates_dir/scripts/deep-review"         "$consumer_root_abs/scripts/deep-review"          755
copy_if_absent "$templates_dir/scripts/install-gitleaks.sh" "$consumer_root_abs/scripts/install-gitleaks.sh"  755
copy_if_absent "$templates_dir/tools/run-gitleaks"          "$consumer_root_abs/tools/run-gitleaks"           755
copy_if_absent "$templates_dir/githooks/pre-commit"         "$consumer_root_abs/.githooks/pre-commit"         755
copy_if_absent "$templates_dir/githooks/pre-push"           "$consumer_root_abs/.githooks/pre-push"           755
copy_if_absent "$templates_dir/github/verify.yml"           "$consumer_root_abs/.github/workflows/verify.yml" 644
copy_if_absent "$templates_dir/claude-skills/deep-review-refactor/SKILL.md" \
               "$consumer_root_abs/.claude/skills/deep-review-refactor/SKILL.md" 644

# Render __DS_REPO_NAME__ into the starter manifest (validated before any write).
# Escape sed-special chars so a name with & / \ cannot break the substitution.
repo_name_escaped=$(printf '%s' "$repo_name" | sed 's/[&/\]/\\&/g')
copy_if_absent "$templates_dir/quality.starter.json" "$consumer_root_abs/quality.json" 644 \
  "s/$REPO_NAME_TOKEN/$repo_name_escaped/g"

# .gitignore: append each snippet line only when absent (exact-line match),
# preserving the consumer's own entries. Report creation only if the file did
# not exist before (a pre-existing file is a modification, restored by the
# caller's rollback, not removed).
gitignore_dest="$consumer_root_abs/.gitignore"
confine_dir "$(dirname "$gitignore_dest")"
reject_symlink "$gitignore_dest"
gitignore_created=false
[ -e "$gitignore_dest" ] || gitignore_created=true
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  if [ -f "$gitignore_dest" ] && grep -qxF -- "$line" "$gitignore_dest"; then continue; fi
  printf '%s\n' "$line" >> "$gitignore_dest"
done < "$templates_dir/gitignore.snippet"
if [ "$gitignore_created" = true ] && [ -f "$gitignore_dest" ]; then
  printf 'created:%s\n' "$gitignore_dest"
fi

# CLAUDE.md: append the managed section only when its marker is absent (creates
# the file if missing). Same modification-vs-creation reporting rule.
claude_dest="$consumer_root_abs/CLAUDE.md"
confine_dir "$(dirname "$claude_dest")"
reject_symlink "$claude_dest"
if [ -f "$claude_dest" ] && grep -qF -- "$MARKER" "$claude_dest"; then
  : # managed section already present — leave it as-is
else
  claude_created=false
  [ -e "$claude_dest" ] || claude_created=true
  [ -s "$claude_dest" ] && printf '\n' >> "$claude_dest"
  cat "$templates_dir/claude-md-section.md" >> "$claude_dest"
  if [ "$claude_created" = true ] && [ -f "$claude_dest" ]; then
    printf 'created:%s\n' "$claude_dest"
  fi
fi

# Additive-overlay location; empty by default. Empty dirs don't show in git
# status, so this is not journaled.
confine_dir "$consumer_root_abs/.claude/review-guides"
mkdir -p "$consumer_root_abs/.claude/review-guides"

# --eslint: seed shared presets + toolchain deps BEFORE the root install so the
# injected devDependencies are picked up (Gate P F5).
if [ "$want_eslint" = true ]; then
  [ -f "$consumer_root_abs/package.json" ] \
    || { echo "--eslint requires a root package.json at $consumer_root_abs" >&2; exit "$EXIT_USAGE"; }
  eslint_created=false
  [ -e "$consumer_root_abs/eslint.config.js" ] || eslint_created=true
  lock_created=false
  [ -e "$consumer_root_abs/package-lock.json" ] || lock_created=true
  "$package_root/scripts/seed-eslint-config.sh" "$consumer_root_abs"
  if [ "$eslint_created" = true ] && [ -f "$consumer_root_abs/eslint.config.js" ]; then
    printf 'created:%s\n' "$consumer_root_abs/eslint.config.js"
  fi
  ( cd "$consumer_root_abs" && npm install )
  if [ "$lock_created" = true ] && [ -f "$consumer_root_abs/package-lock.json" ]; then
    printf 'created:%s\n' "$consumer_root_abs/package-lock.json"
  fi
fi

# Record which instance docs are absent so the ones ds-bootstrap creates (via
# seed-review-guides.sh) can be reported for the rollback journal too.
instance_doc_names=(CHECKLIST.md code-conventions.md gate-misses.md project-facts.md)
instance_doc_absent=()
i=0
while [ "$i" -lt "${#instance_doc_names[@]}" ]; do
  if [ -e "$consumer_root_abs/.claude/${instance_doc_names[i]}" ]; then
    instance_doc_absent[i]=no
  else
    instance_doc_absent[i]=yes
  fi
  i=$((i + 1))
done

echo "==> running scripts/ds-bootstrap.sh"
"$consumer_root_abs/scripts/ds-bootstrap.sh"

i=0
while [ "$i" -lt "${#instance_doc_names[@]}" ]; do
  name=${instance_doc_names[$i]}
  if [ "${instance_doc_absent[$i]}" = yes ] && [ -f "$consumer_root_abs/.claude/$name" ]; then
    printf 'created:%s\n' "$consumer_root_abs/.claude/$name"
  fi
  i=$((i + 1))
done

echo "==> validating quality manifest"
node "$vendor/runner/dist/validate-quality-manifest.mjs" --manifest "$consumer_root_abs/quality.json"

echo "==> checking instance docs"
"$package_root/scripts/seed-review-guides.sh" "$consumer_root_abs" --check

echo "==> verify --doctor"
( cd "$consumer_root_abs" && ./scripts/verify --doctor )

echo "==> verify --fast"
( cd "$consumer_root_abs" && ./scripts/verify --fast )

cat <<EOF

==> dev-standards seeded into $consumer_root_abs
Next steps:
  1. Fill your project gates in quality.json (only the project-specific gates
     start empty — keep the seeded instance-docs-seeded check in fast+full) and
     switch "stack" from "meta-docs" to your real stack; complete the .claude/
     instance docs.
  2. Review the appended CLAUDE.md managed section and .gitignore entries.
  3. Commit the result, e.g.:
       git -C "$consumer_root_abs" add -A
       git -C "$consumer_root_abs" commit -m "chore: adopt dev-standards"
EOF
