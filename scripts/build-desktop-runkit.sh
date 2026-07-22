#!/usr/bin/env bash
# build-desktop-runkit.sh — build the spectroscope desktop run kit.
#
# The Electron shell (spectro-desktop) spawns and supervises the spectro-server
# JVM. This script makes it SELF-CONTAINED: it bundles the server jar AND a
# jlink'd Java runtime into the app, so the target machine needs no Java at all.
# Double-click the result, the server starts with it, the cockpit opens.
#
# Output:  spectro-desktop/release/spectroscope-<version>-<arch>.dmg   (+ -mac.zip)
#
# IMPORTANT — per-platform: electron-builder and the bundled JRE are both
# platform + architecture specific. This builds for the HOST you run it on
# (e.g. macOS arm64 → an arm64 .dmg). To ship Windows/Linux/Intel, run this on
# (or cross-build for) each target. The build is UNSIGNED: on download, macOS
# Gatekeeper blocks first launch → right-click the app → Open.
#
# Prereqs: a JDK (for jlink), Node + npm. Run from anywhere.
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # spectroscope-harness/spectro
cd "$HARNESS"

# Version follows the server module unless overridden: VERSION=0.1.1 ./scripts/build-desktop-runkit.sh
VERSION="${VERSION:-$(sed -nE 's/^version = "([^"]+)".*/\1/p' spectro-server/build.gradle.kts | head -1)}"
echo "==> desktop run kit for spectro-server ${VERSION} (host: $(uname -s) $(uname -m))"

# 1) the server fat jar — the app supervises this process
echo "==> [1/4] server bootJar"
./gradlew :spectro-server:bootJar --console=plain
JAR="spectro-server/build/libs/spectro-server-${VERSION}.jar"
[ -f "$JAR" ] || { echo "!! server jar not found: $JAR (is the version right?)"; exit 1; }

# Copy to the version-neutral path the app's extraResources points at, so
# package.json never has to name a version.
mkdir -p spectro-desktop/build
cp -f "$JAR" spectro-desktop/build/spectro-server.jar

# 2) jlink a full runtime (ALL-MODULE-PATH so Spring Boot's reflection is safe)
echo "==> [2/4] jlink JRE"
JDK="$(/usr/libexec/java_home 2>/dev/null || dirname "$(dirname "$(command -v jlink)")")"
[ -d "$JDK/jmods" ] || { echo "!! no jmods under $JDK — need a full JDK, not a JRE"; exit 1; }
rm -rf spectro-desktop/jre
jlink --module-path "$JDK/jmods" --add-modules ALL-MODULE-PATH \
      --strip-debug --no-header-files --no-man-pages \
      --output spectro-desktop/jre
echo -n "    bundled runtime: "; spectro-desktop/jre/bin/java -version 2>&1 | head -1

# 3) node deps
echo "==> [3/4] npm deps"
( cd spectro-desktop && { [ -d node_modules ] || npm ci; } )

# 4) electron-builder (unsigned — CSC_IDENTITY_AUTO_DISCOVERY=false skips cert lookup)
echo "==> [4/4] electron-builder (unsigned, host arch)"
( cd spectro-desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist )

echo ""
echo "==> done. artifacts:"
ls -lh spectro-desktop/release/*.dmg spectro-desktop/release/*-mac.zip 2>/dev/null \
  | awk '{print "     " $5 "  " $NF}' || echo "     (see spectro-desktop/release/)"
