#!/usr/bin/env bash
# test-release-scripts.sh — run the release scripts' decision points in a
# directory created this second.
#
# The bug class this guards (card 174): a release step that passes on the
# maintainer's machine because of state an earlier run left behind, and fails for
# anyone following the documented ritual. The only test that can see it runs in a
# directory nothing has ever built in — so every case below stages its own
# throwaway tree under mktemp, copies in the script under test, and stubs the
# expensive parts (gradle, npm, the Electron build) so the assertion logic runs
# in seconds instead of forty minutes. The stubs are the POINT, not a shortcut:
# what is under test is what the script does with a missing or failed artifact,
# and a real build cannot be asked for that on demand.
#
# Usage:  scripts/test-release-scripts.sh
set -uo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -nE 's/^version = "([^"]+)".*/\1/p' "$HARNESS/spectro-server/build.gradle.kts" | head -1)"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ok    $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# A tree with no history: the scripts under test, a version to read, and stubs
# for everything that would take a JDK, a network or an Apple account.
#   $1  what the stubbed build-desktop-runkit.sh should do:
#       fail | nodmg | dmg | stale | (unused when SKIP_DESKTOP=1)
stage() {
  local mode="$1" d
  d="$(mktemp -d)"
  mkdir -p "$d/scripts" "$d/spectro-server" "$d/spectro-web" "$d/stub" "$d/spectro-desktop/release"
  cp "$HARNESS/scripts/build-release-assets.sh" "$d/scripts/"
  cp "$HARNESS/spectro-server/build.gradle.kts" "$d/spectro-server/"

  printf '#!/usr/bin/env bash\nexit 0\n' > "$d/stub/npm"

  cat > "$d/gradlew" <<GRADLE
#!/usr/bin/env bash
mkdir -p spectro-cli/build/distributions spectro-server/build/libs spectro-mcp-notes/build/distributions
echo cli    > "spectro-cli/build/distributions/spectro-${VERSION}.zip"
echo server > "spectro-server/build/libs/spectro-server-${VERSION}.jar"
echo notes  > "spectro-mcp-notes/build/distributions/spectro-mcp-notes-${VERSION}.zip"
GRADLE

  case "$mode" in
    # the 0.6.1 shape: the desktop build dies, three assets are already on disk
    fail)  printf '#!/usr/bin/env bash\necho "!! desktop build died"\nexit 1\n' \
             > "$d/scripts/build-desktop-runkit.sh" ;;
    # worse than dying: it reports success and produces nothing
    nodmg) printf '#!/usr/bin/env bash\nexit 0\n' \
             > "$d/scripts/build-desktop-runkit.sh" ;;
    dmg)   printf '#!/usr/bin/env bash\necho dmg > spectro-desktop/release/spectroscope-%s-%s.dmg\n' \
             "$VERSION" "$ARCH" > "$d/scripts/build-desktop-runkit.sh" ;;
    # the case no file list can see: an earlier run in this same tree left a dmg
    # behind, and today's desktop build dies (notarization, a revoked cert, a
    # stalled Apple queue). Four files are on disk, all four non-empty, so the
    # asset check is happy — only the carried exit status knows the dmg is from
    # yesterday. This is the shape the dmg is staged BEFORE the stub runs, and
    # the stub never touches it.
    stale) printf '#!/usr/bin/env bash\necho "!! notarization failed"\nexit 1\n' \
             > "$d/scripts/build-desktop-runkit.sh"
           echo "yesterday" > "$d/spectro-desktop/release/spectroscope-${VERSION}-${ARCH}.dmg" ;;
  esac
  chmod +x "$d/gradlew" "$d/stub/npm" "$d/scripts/build-desktop-runkit.sh" 2>/dev/null

  echo "$d"
}

run() {  # run build-release-assets.sh in $1; echoes the exit code, log in $LOG
  local d="$1"; shift
  ( cd "$d" && PATH="$d/stub:$PATH" env "$@" bash scripts/build-release-assets.sh ) > "$LOG" 2>&1
  echo $?
}

echo "== card 174: the artifact list survives a failed desktop build =="
D="$(stage fail)"; LOG="$D/out.log"
RC="$(run "$D")"
check "a failed desktop build is not a release" "$RC" "1"
if grep -q "collected assets" "$LOG"; then
  ok "the collected-assets block still prints"
else
  bad "no collected-assets block — the playbook tells the reader to check that block, and in the one case it matters it is absent"
fi
grep -q "MISSING  spectroscope-${VERSION}-${ARCH}.dmg" "$LOG" \
  && ok "the missing dmg is named" || bad "the missing dmg is not named"
grep -q "spectro-server-${VERSION}.jar" "$LOG" \
  && ok "the assets that DID build are named" || bad "the built assets are not named"

echo "== a desktop build that produces nothing and exits 0 =="
D="$(stage nodmg)"; LOG="$D/out.log"
RC="$(run "$D")"
check "silently producing no dmg fails the run" "$RC" "1"
grep -q "MISSING  spectroscope-${VERSION}-${ARCH}.dmg" "$LOG" \
  && ok "the missing dmg is named" || bad "the missing dmg is not named"

echo "== a complete build =="
D="$(stage dmg)"; LOG="$D/out.log"
RC="$(run "$D")"
check "a complete build passes" "$RC" "0"
for a in "spectro-${VERSION}.zip" "spectro-server-${VERSION}.jar" \
         "spectro-mcp-notes-${VERSION}.zip" "spectroscope-${VERSION}-${ARCH}.dmg"; do
  grep -q "  $a\$" "$LOG" && ok "named: $a" || bad "not named: $a"
done

echo "== SKIP_DESKTOP=1 expects three assets, not four =="
D="$(stage nodmg)"; LOG="$D/out.log"
RC="$(run "$D" SKIP_DESKTOP=1)"
check "the three-asset build passes" "$RC" "0"
grep -q "spectroscope-" "$LOG" \
  && bad "a dmg is still expected under SKIP_DESKTOP=1" || ok "no dmg expected"

echo "== a zero-byte artifact is a failed build wearing a filename =="
D="$(stage dmg)"; LOG="$D/out.log"
cat > "$D/gradlew" <<GRADLE
#!/usr/bin/env bash
mkdir -p spectro-cli/build/distributions spectro-server/build/libs spectro-mcp-notes/build/distributions
echo cli   > "spectro-cli/build/distributions/spectro-${VERSION}.zip"
: >        "spectro-server/build/libs/spectro-server-${VERSION}.jar"
echo notes > "spectro-mcp-notes/build/distributions/spectro-mcp-notes-${VERSION}.zip"
GRADLE
chmod +x "$D/gradlew"
RC="$(run "$D")"
check "an empty jar fails the run" "$RC" "1"
grep -q "MISSING  spectro-server-${VERSION}.jar" "$LOG" \
  && ok "the empty jar is named" || bad "the empty jar is not named"

echo "== a dmg left by an earlier run does not launder a failed desktop build =="
D="$(stage stale)"; LOG="$D/out.log"
RC="$(run "$D")"
# The premise first: if the stale dmg were NOT collected this whole case would
# pass for the wrong reason, and the exit-status verdict below would be pinned by
# nothing again. So assert that the asset check is satisfied, then assert that
# the run fails anyway.
grep -q "MISSING" "$LOG" \
  && bad "the stale dmg was not collected — this case no longer tests the exit status" \
  || ok "all four assets are present, so the file list alone would call this green"
check "a failed desktop build with a stale dmg is not a release" "$RC" "1"
grep -q "the desktop run kit exited 1" "$LOG" \
  && ok "the desktop exit status is reported" \
  || bad "nothing tells the reader WHY a build with four assets on disk failed"
grep -q "this is not a release" "$LOG" \
  && ok "the verdict is stated" || bad "no verdict — a stale dmg would ship"

echo "== the entitlements plist exists in a directory nobody has signed in =="
D="$(mktemp -d)"
mkdir -p "$D/scripts" "$D/spectro-server"
cp "$HARNESS/scripts/build-desktop-runkit.sh" "$D/scripts/"
cp "$HARNESS/spectro-server/build.gradle.kts" "$D/spectro-server/"
printf '#!/usr/bin/env bash\nexit 9\n' > "$D/gradlew"; chmod +x "$D/gradlew"
ENT="$D/spectro-desktop/build/entitlements.mac.plist"
[ -e "$ENT" ] && bad "the staged tree already had the plist — this test proves nothing"
( cd "$D" && SIGN_IDENTITY="Developer ID Application: test (TESTTEAM)" \
    bash scripts/build-desktop-runkit.sh ) > "$D/out.log" 2>&1
if [ -s "$ENT" ]; then
  ok "written without anything copied in by hand"
else
  bad "still absent — a signed build works only where somebody signed before"
fi
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$ENT" >/dev/null 2>&1 && ok "it is a valid plist" || bad "it is not a valid plist"
fi
# The doc prints the same bytes. Two copies drift the moment one is edited alone,
# and the drift is invisible until a notarized build behaves oddly in the field.
DOC="$HARNESS/docs/DESKTOP-SIGNING.md"
python3 - "$DOC" "$D/from-doc.xml" <<'PY'
import re, sys
doc = open(sys.argv[1]).read()
sec = doc[doc.index("## 4. Entitlements"):doc.index("## 5. Sign")]
blocks = re.findall(r"```xml\n(.*?)```", sec, re.S)
if len(blocks) != 1:
    sys.exit(f"expected one xml block in DESKTOP-SIGNING.md section 4, found {len(blocks)}")
open(sys.argv[2], "w").write(blocks[0])
PY
if [ -s "$D/from-doc.xml" ] && cmp -s "$D/from-doc.xml" "$ENT"; then
  ok "byte-identical to docs/DESKTOP-SIGNING.md section 4"
else
  bad "the script and docs/DESKTOP-SIGNING.md no longer write the same bytes"
fi

echo "== the playbook sends the reader to the artifact list, not the exit code =="
PB="$HARNESS/docs/RELEASE-PLAYBOOK.md"
grep -q "collected assets\` block, not the exit code" "$PB" \
  && ok "step 7 names the block" || bad "step 7 still points at the exit code"

echo ""
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
