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
( cd spectro-web && { [ -d node_modules ] || npm ci; } && npm run build )

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
  cp -f spectro-desktop/release/spectroscope-${VERSION}-*.dmg "$OUT/" 2>/dev/null || \
    echo "    (no .dmg — desktop build may have been skipped on this platform)"
fi

echo ""
echo "==> [4/5] collected assets:"
ls -lh "$OUT" | awk 'NR>1 {print "     " $5 "  " $NF}'

echo ""
echo "==> [5/5] to attach them to the GitHub release:"
echo "     gh release upload v${VERSION} ${OUT}/* --clobber"
