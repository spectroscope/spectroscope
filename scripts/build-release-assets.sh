#!/usr/bin/env bash
# build-release-assets.sh — build ONE downloadable asset per module for a GitHub
# release, and collect them in build/release-assets/. The two libraries
# (spectro-core, spectro-orchestrator) go to Maven Central instead (see
# RELEASING.md) and are NOT built here.
#
# Produces (in build/release-assets/):
#   spectro-<v>.zip                     CLI distribution (bin/spectro)
#   spectro-server-<v>.jar              executable Spring Boot server
#   spectro-mcp-notes-<v>.zip           sample MCP notes server
#   spectroscope-<v>-<arch>.dmg         desktop run kit (bundled server + JRE)
#
# spectro-web is NOT shipped standalone: it is a single-page app that needs the
# server's REST/WebSocket API on the same origin, so a downloaded bundle can't
# run on its own. It is built here only so the server jar (and the desktop app)
# embed the current UI.
#
# The desktop .dmg is HOST-platform only (see build-desktop-runkit.sh). Pass
# SKIP_DESKTOP=1 to build everything except the desktop kit (e.g. on a machine
# without a full JDK/Node).
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS"

VERSION="${VERSION:-$(sed -nE 's/^version = "([^"]+)".*/\1/p' spectro-server/build.gradle.kts | head -1)}"
OUT="build/release-assets"
rm -rf "$OUT"; mkdir -p "$OUT"
echo "==> building release assets for ${VERSION} → ${OUT}/"

# 1) build the web UI FIRST — its output lands in spectro-server's static
#    resources, so the server jar below embeds the current UI. Not shipped as a
#    standalone asset (a SPA can't run without the server's API + same origin).
echo "==> [1/5] web UI build (embedded into the server jar; not a standalone asset)"
# The install is UNCONDITIONAL. It used to read `{ [ -d node_modules ] || npm ci; }`,
# which built the shipped UI out of whatever a previous session happened to leave
# installed. Not hypothetical: measured 2026-08-10 in the release checkout,
# node_modules held postcss 8.5.16 and nanoid 3.3.15 while package-lock.json
# pinned 8.5.23 and 3.3.16 — and this bundle goes into the server jar AND into the
# notarized dmg. The identical conditional is how v0.7.0 shipped Electron 39.8.5
# against a lock naming 39.8.10 (see build-desktop-runkit.sh step [4/7]); the two
# desktop scripts were fixed then and this one was missed. A release is built from
# the lock or it is not a release.
( cd spectro-web && npm ci && npm run build )

# 2) JVM apps: CLI dist, server bootJar, mcp-notes dist
echo "==> [2/5] cli + server + mcp-notes (gradle)"
./gradlew :spectro-cli:distZip :spectro-server:bootJar :spectro-mcp-notes:distZip --console=plain
cp -f "spectro-cli/build/distributions/spectro-${VERSION}.zip"                 "$OUT/"
cp -f "spectro-server/build/libs/spectro-server-${VERSION}.jar"                "$OUT/"
cp -f "spectro-mcp-notes/build/distributions/spectro-mcp-notes-${VERSION}.zip" "$OUT/"

# 3) desktop run kit (host platform; optional)
if [ "${SKIP_DESKTOP:-0}" = "1" ]; then
  echo "==> [3/5] desktop run kit SKIPPED (SKIP_DESKTOP=1)"
else
  echo "==> [3/5] desktop run kit"
  VERSION="$VERSION" ./scripts/build-desktop-runkit.sh
  # Deliberately not fatal on its own: step 4 below is the single place that
  # decides whether this build is a release, and it can name every miss at once
  # instead of dying on the first cp.
  cp -f spectro-desktop/release/spectroscope-${VERSION}-*.dmg "$OUT/" 2>/dev/null || true
fi

# 4) ASSERT the assets, do not merely list them. This was an `ls` of whatever
#    landed, and the cp above ended in `|| echo "(no .dmg …)"` — which returns 0,
#    so `set -e` never fired. A desktop build that produced nothing therefore got
#    a friendly note, three assets, a tidy listing and exit 0. That is the 0.6.1
#    shape precisely: three of four artifacts on disk, no dmg, and a green that
#    nobody could distinguish from a real one. A list is not a check, because
#    nobody diffs a list against a memory at the end of a forty-minute build.
#    No bash arrays here on purpose: /usr/bin/env bash on macOS is 3.2, where
#    "${arr[@]}" on an empty array is an unbound-variable error under `set -u`.
echo ""
echo "==> [4/5] collected assets:"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
EXPECTED="spectro-${VERSION}.zip spectro-server-${VERSION}.jar spectro-mcp-notes-${VERSION}.zip"
[ "${SKIP_DESKTOP:-0}" = "1" ] || EXPECTED="$EXPECTED spectroscope-${VERSION}-${ARCH}.dmg"
MISSING=0
for a in $EXPECTED; do
  # -s rather than -f: a zero-byte artifact is a failed build wearing a filename.
  if [ -s "$OUT/$a" ]; then
    echo "     $(du -h "$OUT/$a" | cut -f1)  $a"
  else
    echo "     MISSING  $a"
    MISSING=$((MISSING + 1))
  fi
done
if [ "$MISSING" -ne 0 ]; then
  echo ""
  echo "!! $MISSING expected asset(s) missing or empty — this is not a release, do not upload."
  exit 1
fi

echo ""
echo "==> [5/5] to attach them to the GitHub release:"
echo "     gh release upload v${VERSION} ${OUT}/* --clobber"
