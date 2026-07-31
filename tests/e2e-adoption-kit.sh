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
# core-work is a clone of the real repo, so it carries the real v* tags
# (v0.9.3 > v0.9.1-test); ds-install's default-ref sort -V would pick one and
# install a stale snapshot. Delete every inherited tag, then re-tag v0.8.0
# synthetically on the root commit: section B needs a resolvable
# predates-the-kit ref, and the ambient v0.8.0 may be absent in a shallow or
# tag-filtered checkout. It never wins sort -V (v0.8.0 < every fixture tag).
for t in $(git -C "$E2E/core-work" tag); do
  git -C "$E2E/core-work" tag -d "$t" > /dev/null
done
git -C "$E2E/core-work" tag v0.8.0 \
  "$(git -C "$E2E/core-work" rev-list --max-parents=0 HEAD | tail -n1)"
rsync -a --exclude .git --exclude node_modules --exclude .codegraph \
      --exclude .handoff "$CORE/" "$E2E/core-work/"
git -C "$E2E/core-work" add -A
# --allow-empty: the kit is committed on a clean tree, so the rsync snapshot has
# nothing new to stage; the tree at v0.9.0-test still carries the kit either way.
git -C "$E2E/core-work" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "test: adoption kit snapshot"
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
expect "A CLAUDE.md names the owner-invoked Claude skill" grep -q \
  '`/deep-review-refactor` in Claude' "$A/CLAUDE.md"
expect "A CLAUDE.md keeps the Codex skill slash-only" grep -q \
  '`/deep-review-refactor-codex` in Codex' "$A/CLAUDE.md"
expect "A quality.json repo rendered" grep -q '"repo": "consumer-a"' "$A/quality.json"
# The --full fix-verify default needs headroom inside the run deadline: the seeded
# budget must stay 1800 (a silent revert to 900 starves the deep-review full tier).
expect "A deep_review budget seeded at 1800" python3 -c "import json,sys; m=json.load(open(sys.argv[1])); sys.exit(0 if m['deep_review']['budget']['seconds']==1800 else 1)" "$A/quality.json"
expect "A deep_review fix verify seeded --full" python3 -c "import json,sys; m=json.load(open(sys.argv[1])); sys.exit(0 if m['deep_review']['verify_after_fix']=='--full' else 1)" "$A/quality.json"
expect "A dependabot.yml seeded" test -f "$A/.github/dependabot.yml"
expect "A AGENTS.md pointer seeded" grep -q "CLAUDE.md" "$A/AGENTS.md"
expect "A original Claude deep-review skill wrapper preserved" grep -q \
  "vendor/dev-standards/agents/skill-sources/deep-review-refactor.md" \
  "$A/.claude/skills/deep-review-refactor/SKILL.md"
expect "A Codex deep-review skill wrapper seeded under explicit name" grep -q \
  "../../../vendor/dev-standards/agents/skill-sources/deep-review-refactor-codex.md" \
  "$A/.agents/skills/deep-review-refactor-codex/SKILL.md"
expect "A Codex deep-review skill pointer resolves" test -f \
  "$A/.agents/skills/deep-review-refactor-codex/../../../vendor/dev-standards/agents/skill-sources/deep-review-refactor-codex.md"
expect "A Codex deep-review slash command metadata seeded" grep -q \
  '/deep-review-refactor-codex' \
  "$A/.agents/skills/deep-review-refactor-codex/agents/openai.yaml"
expect "A Codex deep-review implicit invocation disabled" grep -q \
  'allow_implicit_invocation: false' \
  "$A/.agents/skills/deep-review-refactor-codex/agents/openai.yaml"
# The guides-read gate (ADR-016) is only armed if its hooks are wired + required_reads seeded.
expect "A settings.json guides-read Stop/SubagentStop hooks wired" python3 -c "import json,sys; s=json.load(open(sys.argv[1])); h=s.get('hooks',{}); cmd=lambda e: any(x.get('command')=='\"\$CLAUDE_PROJECT_DIR\"/scripts/deep-review guides-read --hook-stdin' for g in h.get(e,[]) for x in g.get('hooks',[])); sys.exit(0 if cmd('Stop') and cmd('SubagentStop') else 1)" "$A/.claude/settings.json"
expect "A deep_review required_reads seeded (all three)" python3 -c "import json,sys; m=json.load(open(sys.argv[1])); r=m['deep_review'].get('required_reads',[]); sys.exit(0 if sorted(r)==sorted(['.claude/project-facts.md','.claude/code-conventions.md','.claude/CHECKLIST.md']) else 1)" "$A/quality.json"
staged_oid=$(git -C "$A" ls-files -s -- vendor/dev-standards | awk '{print $2}')
want_oid=$(git -C "$E2E/core-work" rev-parse 'v0.9.1-test^{commit}')
if [ "$staged_oid" = "$want_oid" ]; then ok "A gitlink staged at default (latest) tag"; else bad "A gitlink: $staged_oid != $want_oid"; fi
git -C "$A" add -A
git -C "$A" -c user.email=t@t -c user.name=t commit -qm "chore: adopt dev-standards"
if "$INSTALL" "$A" > "$E2E/a-rerun.log" 2>&1; then ok "A idempotent re-run exit 0"; else bad "A re-run (see a-rerun.log)"; fi
expect "A re-run created nothing" test -z "$(grep '^created:' "$E2E/a-rerun.log" || true)"
mv "$A/.github/dependabot.yml" "$A/.github/dependabot.yml.bak"
expect_fail "A --check red without dependabot.yml" "$INSTALL" "$A" --check
mv "$A/.github/dependabot.yml.bak" "$A/.github/dependabot.yml"
expect "A --check green after restore" "$INSTALL" "$A" --check
mv "$A/.claude/settings.json" "$A/.claude/settings.json.bak"
expect_fail "A --check red without guides-read hooks" "$INSTALL" "$A" --check
mv "$A/.claude/settings.json.bak" "$A/.claude/settings.json"
printf '\nconsumer-local fork\n' >> "$A/.agents/skills/deep-review-refactor-codex/SKILL.md"
expect_fail "A --check red on forked Codex skill wrapper" "$INSTALL" "$A" --check
git -C "$A" restore -- .agents/skills/deep-review-refactor-codex/SKILL.md
printf '\n# consumer-local metadata drift\n' >> "$A/.agents/skills/deep-review-refactor-codex/agents/openai.yaml"
expect_fail "A --check red on drifted Codex skill metadata" "$INSTALL" "$A" --check
git -C "$A" restore -- .agents/skills/deep-review-refactor-codex/agents/openai.yaml

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

echo "=== F: mid-seed install failure leaves recoverable state (no auto-rollback)"
# Fault injection: a PATH-shadowed npm that passes ds-install's existence-only
# preflight (command -v npm) but exits 1 at ds-bootstrap's submodule `npm ci`,
# aborting seeding mid-way. node stays real (stub dir holds only npm). The stub
# is scoped to just this call so A/C keep the real npm.
mkdir -p "$E2E/stub-fail-npm"
cat > "$E2E/stub-fail-npm/npm" <<'STUB'
#!/usr/bin/env bash
# Record cwd+arg of the npm call we fail on, so the test can assert the fault
# landed on the vendor `npm ci` — not some other npm call added earlier, which
# would bypass the mid-seed seed|tee journal path this scenario exercises.
printf '%s %s\n' "$PWD" "${1:-}" > "$DS_FIRED"
exit 1
STUB
chmod +x "$E2E/stub-fail-npm/npm"
mkconsumer "$E2E/consumer-fault"
CF="$E2E/consumer-fault"; CFG="$CF/.git"
expect_fail "F mid-seed install exits non-zero" \
  env PATH="$E2E/stub-fail-npm:$PATH" DS_FIRED="$E2E/f.fired" "$INSTALL" "$CF"
expect "F fault fired at vendor npm ci" grep -q "/vendor/dev-standards ci$" "$E2E/f.fired"
# Post-v0.9.1: a failed install is LEFT in place (state+journal persist), never
# auto-rolled-back — undo is manual via --rollback.
expect "F state left"                test -f "$CFG/ds-install.state"
expect "F journal left"              test -f "$CFG/ds-install.journal"
expect "F tree left dirty"           test -n "$(git -C "$CF" status --porcelain)"
expect "F submodule was checked out" test -d "$CF/vendor/dev-standards"
expect "F --rollback succeeds"          "$INSTALL" "$CF" --rollback
expect "F rollback clean tree"          test -z "$(git -C "$CF" status --porcelain)"
expect "F rollback cleared state"       test ! -e "$CFG/ds-install.state"
expect "F rollback cleared journal"     test ! -e "$CFG/ds-install.journal"
expect "F rollback no module residue"   test ! -e "$CFG/modules/vendor/dev-standards"
expect "F rollback no vendor residue"   test ! -e "$CF/vendor/dev-standards"
expect "F rollback no node_modules"     test ! -e "$CF/node_modules"

echo "=== G: SIGINT mid-seed takes the INT-trap path, leaving recoverable state"
# A stub npm that, when ds-bootstrap runs `npm ci`, sends SIGINT to the ds-install
# process (whose pid the foreground wrapper exports) and then exits — so the blocked
# seed|tee pipeline completes and ds-install's PENDING INT trap fires (exit 130,
# fail_handler harvests the live journal). ds-install MUST run in the FOREGROUND:
# an async (&) process in this non-interactive harness inherits SIGINT=SIG_IGN and
# cannot trap it, so an external kill -INT would be ignored (verified). The wrapper
# runs it in the foreground and the stub triggers the signal from inside.
mkdir -p "$E2E/stub-sigint-npm"
cat > "$E2E/stub-sigint-npm/npm" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$PWD" "${1:-}" > "$DS_FIRED"
kill -INT "$DS_INSTALL_PID"
exit 1
STUB
chmod +x "$E2E/stub-sigint-npm/npm"
mkconsumer "$E2E/consumer-sigint"
CS="$E2E/consumer-sigint"; CSG="$CS/.git"
set +e
PATH="$E2E/stub-sigint-npm:$PATH" DS_FIRED="$E2E/g.fired" \
  bash -c 'export DS_INSTALL_PID=$$; exec "$0" "$1"' "$INSTALL" "$CS" > "$E2E/g-install.log" 2>&1
g_rc=$?
set -e
[ "$g_rc" -eq 130 ] && ok "G SIGINT mid-seed exits 130 (INT trap)" || bad "G exit code: $g_rc (want 130)"
expect "G signal fired at vendor npm ci" grep -q "/vendor/dev-standards ci$" "$E2E/g.fired"
expect "G state left"       test -f "$CSG/ds-install.state"
expect "G journal left"     test -f "$CSG/ds-install.journal"
expect "G tree left dirty"  test -n "$(git -C "$CS" status --porcelain)"
expect "G undo hint printed" grep -q -- "--rollback" "$E2E/g-install.log"
expect "G --rollback succeeds"          "$INSTALL" "$CS" --rollback
expect "G rollback clean tree"          test -z "$(git -C "$CS" status --porcelain)"
expect "G rollback cleared state"       test ! -e "$CSG/ds-install.state"
expect "G rollback no module residue"   test ! -e "$CSG/modules/vendor/dev-standards"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
