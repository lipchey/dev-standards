#!/usr/bin/env bash
# Manual acceptance harness for the adoption kit (plan v2 §Acceptance).
# Not part of `npm test`: it needs network access and ~10 min of runtime.
# Local fixture upstream (a bare clone of the working tree, uncommitted kit
# included) — no GitHub round-trip, no real-tag pollution.
# usage: tests/e2e-adoption-kit.sh [scratch-dir]   (default: a fresh mktemp -d)
set -euo pipefail
export LC_ALL=C

CORE=$(cd "$(dirname "$0")/.." && pwd -P)
# Never `rm -rf` a caller-supplied path (`.`/$HOME would be catastrophic):
# require it to be absent and create it fresh instead.
if [ -n "${1:-}" ]; then
  E2E="$1"
  [ -e "$E2E" ] && { echo "refusing to reuse existing scratch dir: $E2E" >&2; exit 2; }
  mkdir -p "$E2E"
else
  E2E=$(mktemp -d)
fi

# git blocks file-protocol submodules by default; scope the allowance to this
# run's processes only (never touches user git config).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.file.allow GIT_CONFIG_VALUE_0=always

pass=0; fail=0
ok()   { echo "PASS: $1"; pass=$((pass+1)); }
bad()  { echo "FAIL: $1"; fail=$((fail+1)); }
expect() { # expect <desc> <cmd...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
expect_fail() {
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$d (unexpectedly succeeded)"; else ok "$d"; fi
}

echo "=== setup: core-work clone + local bare upstream"
git clone -q "$CORE" "$E2E/core-work"
rsync -a --exclude .git --exclude node_modules --exclude .codegraph \
      --exclude .handoff "$CORE/" "$E2E/core-work/"
git -C "$E2E/core-work" add -A
git -C "$E2E/core-work" -c user.email=t@t -c user.name=t commit -qm "test: adoption kit snapshot"
git -C "$E2E/core-work" tag v0.9.0-test
git -C "$E2E/core-work" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "test: bump"
git -C "$E2E/core-work" tag v0.9.1-test
git clone -q --bare "$E2E/core-work" "$E2E/upstream.git"
git -C "$E2E/core-work" remote set-url origin "$E2E/upstream.git"
INSTALL="$E2E/core-work/scripts/ds-install.sh"

mkconsumer() { # mkconsumer <dir>
  git init -q "$1"
  git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  printf '# readme\n' > "$1/README.md"
  git -C "$1" add README.md
  git -C "$1" -c user.email=t@t -c user.name=t commit -qm docs
}

echo "=== A: fresh non-Node install, default ref"
mkconsumer "$E2E/consumer-a"
if "$INSTALL" "$E2E/consumer-a" > "$E2E/a-install.log" 2>&1; then ok "A install exit 0"; else bad "A install (see a-install.log)"; fi
A="$E2E/consumer-a"
expect "A --check green" "$INSTALL" "$A" --check
expect "A no leftover recovery state" test ! -e "$A/.git/ds-install.state"
expect "A node_modules exists" test -d "$A/node_modules"
expect "A overlay dir empty" test -z "$(ls -A "$A/.claude/review-guides" 2>/dev/null)"
expect "A CLAUDE.md managed marker" grep -q "dev-standards:managed-section" "$A/CLAUDE.md"
expect "A quality.json repo rendered" grep -q '"repo": "consumer-a"' "$A/quality.json"
staged_oid=$(git -C "$A" ls-files -s -- vendor/dev-standards | awk '{print $2}')
want_oid=$(git -C "$E2E/core-work" rev-parse 'v0.9.1-test^{commit}')
if [ "$staged_oid" = "$want_oid" ]; then ok "A gitlink staged at default (latest) tag"; else bad "A gitlink: $staged_oid != $want_oid"; fi
git -C "$A" add -A
git -C "$A" -c user.email=t@t -c user.name=t commit -qm "chore: adopt dev-standards"
if "$INSTALL" "$A" > "$E2E/a-rerun.log" 2>&1; then ok "A idempotent re-run exit 0"; else bad "A re-run (see a-rerun.log)"; fi
expect "A re-run created nothing" test -z "$(grep '^created:' "$E2E/a-rerun.log" || true)"

echo "=== B: failure paths"
mkconsumer "$E2E/consumer-dirty"; touch "$E2E/consumer-dirty/untracked.txt"
expect_fail "B dirty tree aborts" "$INSTALL" "$E2E/consumer-dirty"
expect "B dirty: no submodule added" test ! -e "$E2E/consumer-dirty/vendor"

mkconsumer "$E2E/consumer-badref"
expect_fail "B bad --ref aborts" "$INSTALL" "$E2E/consumer-badref" --ref does-not-exist
expect "B bad-ref: tree untouched" test -z "$(git -C "$E2E/consumer-badref" status --porcelain)"

mkconsumer "$E2E/consumer-old"
expect_fail "B predates-kit ref rejected" "$INSTALL" "$E2E/consumer-old" --ref v0.8.0
expect "B predates: state left for debugging" test -f "$E2E/consumer-old/.git/ds-install.state"
expect "B predates: --rollback succeeds" "$INSTALL" "$E2E/consumer-old" --rollback
expect "B predates: recovery state cleared" test ! -e "$E2E/consumer-old/.git/ds-install.state"
expect "B predates: clean rollback" test -z "$(git -C "$E2E/consumer-old" status --porcelain)"
expect "B predates: no .git/modules residue" test ! -e "$E2E/consumer-old/.git/modules/vendor/dev-standards"

echo "=== C: pin update"
mkconsumer "$E2E/consumer-b"
"$INSTALL" "$E2E/consumer-b" --ref v0.9.0-test > "$E2E/b-install.log" 2>&1 || { bad "C install at v0.9.0-test"; }
B="$E2E/consumer-b"
git -C "$B" add -A
git -C "$B" -c user.email=t@t -c user.name=t commit -qm "chore: adopt dev-standards"
if "$E2E/core-work/scripts/ds-update-pins.sh" --ref v0.9.1-test "$E2E" > "$E2E/c-bump.log" 2>&1; then ok "C bump exit 0"; else bad "C bump (see c-bump.log)"; fi
new=$(git -C "$B/vendor/dev-standards" rev-parse HEAD)
if [ "$new" = "$want_oid" ]; then ok "C pin at v0.9.1-test"; else bad "C pin: $new"; fi
msg=$(git -C "$B" log -1 --format=%s)
case "$msg" in "chore(dev-standards): bump submodule pin "*" -> "*) ok "C commit message format";; *) bad "C commit message: $msg";; esac
expect "C commit touches only gitlink" test "$(git -C "$B" show --name-only --format= HEAD | grep -v '^$')" = "vendor/dev-standards"
expect "C tree clean after bump" test -z "$(git -C "$B" status --porcelain)"

echo "=== D: forced-red bump rolls back"
git -C "$E2E/core-work" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "test: bump2"
git -C "$E2E/core-work" tag v0.9.2-test
git -C "$E2E/core-work" push -q origin HEAD:main v0.9.2-test 2>/dev/null || git -C "$E2E/core-work" push -q origin HEAD:master v0.9.2-test
python3 - "$B/quality.json" <<'PY'
import json,sys
p=sys.argv[1]; m=json.load(open(p))
m["tiers"]["fast"].append({"name":"always-red","argv":["false"],"timeout_seconds":5})
json.dump(m,open(p,"w"),indent=2)
PY
git -C "$B" add quality.json
git -C "$B" -c user.email=t@t -c user.name=t commit -qm "test: red gate" --no-verify
old_pin=$(git -C "$B/vendor/dev-standards" rev-parse HEAD)
expect_fail "D red bump exits non-zero" "$E2E/core-work/scripts/ds-update-pins.sh" --ref v0.9.2-test "$E2E/consumer-b"
after=$(git -C "$B/vendor/dev-standards" rev-parse HEAD)
if [ "$after" = "$old_pin" ]; then ok "D rollback restored old pin"; else bad "D pin after red: $after"; fi
stamp=$(cat "$B/vendor/dev-standards/runner/dist/.built-from")
if [ "$stamp" = "$old_pin" ]; then ok "D rollback restored stamps"; else bad "D stamp: $stamp"; fi
expect "D tree clean after rollback" test -z "$(git -C "$B" status --porcelain)"

echo "=== D2: --keep-on-failure leaves the failed bump in place"
# B still carries D's committed red gate and sits at old_pin (v0.9.1-test).
want92=$(git -C "$E2E/core-work" rev-parse 'v0.9.2-test^{commit}')
expect_fail "D2 keep red bump exits non-zero" \
  "$E2E/core-work/scripts/ds-update-pins.sh" --ref v0.9.2-test --keep-on-failure "$E2E/consumer-b"
kept=$(git -C "$B/vendor/dev-standards" rev-parse HEAD)
if [ "$kept" = "$want92" ]; then ok "D2 failed pin kept, not rolled back"; else bad "D2 pin: $kept != $want92"; fi
# Manual restore per the printed recipe: unstage FIRST (bootstrap's submodule
# update would otherwise reset the checkout to the staged new gitlink).
git -C "$B" restore --staged -- vendor/dev-standards
git -C "$B/vendor/dev-standards" -c advice.detachedHead=false checkout -q "$old_pin"
( cd "$B" && ./scripts/ds-bootstrap.sh ) >/dev/null 2>&1
expect "D2 tree clean after manual restore" test -z "$(git -C "$B" status --porcelain)"

echo "=== E: dirty consumer is skipped by update-pins"
touch "$B/dirty.marker"
if "$E2E/core-work/scripts/ds-update-pins.sh" --ref v0.9.2-test "$E2E/consumer-b" > "$E2E/e-skip.log" 2>&1; then
  if grep -q "skip: tree is dirty" "$E2E/e-skip.log"; then ok "E dirty consumer skipped"; else bad "E no skip message"; fi
else
  bad "E update-pins errored on dirty consumer (see e-skip.log)"
fi
rm -f "$B/dirty.marker"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
