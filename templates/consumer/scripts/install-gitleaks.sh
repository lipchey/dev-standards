#!/usr/bin/env bash
set -euo pipefail

# ponytail: darwin/linux + arm64/x64 only — that's this repo's dev and CI matrix
GITLEAKS_VERSION="8.30.1"

REPO_ROOT="$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)"
cd "${REPO_ROOT}"

BIN_DIR=".tools"
BIN_PATH="${BIN_DIR}/gitleaks"
STAMP_PATH="${BIN_PATH}.version"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

# Idempotency via the stamp written after a verified install — never by
# executing whatever currently sits at BIN_PATH; exact-match on the full asset
# identity so neither 8.30.10 nor another platform's binary satisfies the pin.
ASSET_ID="${GITLEAKS_VERSION}_${OS}_${ARCH}"
if [ -f "${BIN_PATH}" ] && [ -x "${BIN_PATH}" ] && [ ! -d "${BIN_PATH}" ] \
  && [ -f "${STAMP_PATH}" ] && [ "$(cat "${STAMP_PATH}")" = "${ASSET_ID}" ]; then
  echo "==> gitleaks ${GITLEAKS_VERSION} already installed at ${BIN_PATH}"
  exit 0
fi

# Checksums copied from the v8.30.1 release checksums.txt, not re-fetched at
# install time — an install run trusts only what was pinned here, not
# whatever checksums.txt happens to contain today.
case "${OS}_${ARCH}" in
  darwin_arm64) SHA256="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5" ;;
  darwin_x64)   SHA256="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709" ;;
  linux_arm64)  SHA256="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080" ;;
  linux_x64)    SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" ;;
  *) echo "no pinned checksum for ${OS}_${ARCH}" >&2; exit 1 ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

ASSET="gitleaks_${GITLEAKS_VERSION}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${ASSET}"

BIN_STAGE=''
STAMP_STAGE=''
TMP_DIR="$(mktemp -d)"
# Clean up only this run's own temporaries (download dir + the two staged files),
# never a name-pattern sweep that could delete a concurrent install's staging.
cleanup() {
  rm -rf "${TMP_DIR}"
  [ -n "${BIN_STAGE}" ] && rm -f "${BIN_STAGE}"
  [ -n "${STAMP_STAGE}" ] && rm -f "${STAMP_STAGE}"
  return 0
}
trap cleanup EXIT

echo "==> downloading ${ASSET}"
curl -fsSL -o "${TMP_DIR}/${ASSET}" "${URL}"

ACTUAL_SHA256="$(sha256_of "${TMP_DIR}/${ASSET}")"
if [ "${ACTUAL_SHA256}" != "${SHA256}" ]; then
  echo "checksum mismatch for ${ASSET}: expected ${SHA256}, got ${ACTUAL_SHA256}" >&2
  exit 1
fi

tar -xzf "${TMP_DIR}/${ASSET}" -C "${TMP_DIR}" gitleaks

# Stage under BIN_DIR (same filesystem → the publish is an atomic rename, not a
# cross-device copy+unlink) with an unpredictable mktemp name.
mkdir -p "${BIN_DIR}"
BIN_STAGE="$(mktemp "${BIN_PATH}.stage.XXXXXX")"
mv "${TMP_DIR}/gitleaks" "${BIN_STAGE}"
chmod +x "${BIN_STAGE}"

# mv -f renames over the old binary with no missing-file window. A directory at
# BIN_PATH is a corrupt prior state mv would nest into — clear only that case.
if [ -d "${BIN_PATH}" ]; then
  rm -rf "${BIN_PATH}"
fi
mv -f "${BIN_STAGE}" "${BIN_PATH}"
BIN_STAGE=''

if [ ! -f "${BIN_PATH}" ] || [ ! -x "${BIN_PATH}" ] || [ -d "${BIN_PATH}" ]; then
  echo "install postcondition failed: ${BIN_PATH} is not an executable regular file" >&2
  exit 1
fi

# Publish the identity stamp last and atomically: a crash must never pair a new
# binary with a stale stamp that would wrongly satisfy the idempotency check.
STAMP_STAGE="$(mktemp "${STAMP_PATH}.stage.XXXXXX")"
printf '%s' "${ASSET_ID}" > "${STAMP_STAGE}"
# A directory at STAMP_PATH would make mv nest the stamp inside it (a false
# "installed"); clear it first, mirroring the BIN_PATH guard above.
if [ -d "${STAMP_PATH}" ]; then
  rm -rf "${STAMP_PATH}"
fi
mv -f "${STAMP_STAGE}" "${STAMP_PATH}"
STAMP_STAGE=''
echo "==> installed gitleaks ${GITLEAKS_VERSION} at ${BIN_PATH}"
