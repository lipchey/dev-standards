#!/usr/bin/env bash
set -euo pipefail

# ds-bootstrap.sh — the single setup entrypoint for the dev-standards quality
# gate. Run after a fresh clone and after every submodule SHA bump.
#
#   1. init/update the vendor/dev-standards submodule
#   2. build its runner bundles (dist/ is gitignored — built on demand)
#   3. wire git to the repo's hand-authored hooks
#
# After this, ./scripts/verify --doctor / --fast / --full work locally.

REPO_ROOT="$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)"
cd "${REPO_ROOT}"

echo "==> updating submodules"
git submodule update --init --recursive

echo "==> building dev-standards runner bundles"
(cd vendor/dev-standards && npm ci && npm run build)

# Stamp the built bundles with the submodule commit they came from so ./scripts/verify
# and ./scripts/deep-review can reject stale bundles after a pin bump (dist/ is
# gitignored, built here).
DS_SHA="$(git -C vendor/dev-standards rev-parse HEAD)"
echo "${DS_SHA}" > vendor/dev-standards/runner/dist/.built-from
echo "${DS_SHA}" > vendor/dev-standards/deep-review/dist/.built-from

# Seed the four instance docs into .claude/ (copy-if-absent — filled docs are
# repo-owned and never overwritten). Generic review guides are NOT copied:
# deep-review reads them in place from the submodule package. Completeness of
# the instance docs is gated by the fast-tier --check.
echo "==> seeding instance docs"
vendor/dev-standards/scripts/seed-review-guides.sh "${REPO_ROOT}"

# npm ci needs the lockfile, not just package.json: run it only when a root
# package-lock.json is present. pnpm/yarn or metadata-only repos self-manage
# their root install — print a note rather than guess the package manager.
echo "==> installing root dependencies"
if [[ -f package-lock.json ]]; then
  npm ci
elif [[ -f package.json ]]; then
  echo "    note: root package.json without package-lock.json — install root deps yourself (npm/pnpm/yarn)"
fi

# deep-review symlinks root node_modules into its worktree unconditionally
# (worktree.ts), so the dir must exist even for non-Node consumers.
mkdir -p node_modules

echo "==> installing gitleaks"
scripts/install-gitleaks.sh

echo "==> wiring git hooks (core.hooksPath -> .githooks)"
git config core.hooksPath .githooks

echo "==> done. Try: ./scripts/verify --doctor"
