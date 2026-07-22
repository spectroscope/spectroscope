#!/usr/bin/env bash
# build-desktop-runkit.sh — build the spectroscope desktop run kit.
#
# The Electron shell (spectro-desktop) spawns and supervises the spectro-server
# JVM. This script makes it SELF-CONTAINED: it bundles the server jar AND a
# jlink'd Java runtime into the app, so the target machine needs no Java at all.
# Double-click the result, the server starts with it, the cockpit opens.
#
# Output:  spectro-desktop/release/spectroscope-<version>-<arch>.dmg
#
# SIGNING: the app is AD-HOC signed (free, no Apple account). That is enough to
# avoid the "\"spectroscope.app\" is damaged" error on download — macOS instead
# shows the normal "unidentified developer" prompt, so the user right-clicks the
# app → Open (or runs `xattr -cr spectroscope.app`) once. For a ZERO-warning,
# double-click experience you need a paid Apple Developer ID + notarization:
# see docs/DESKTOP-SIGNING.md.
#
# PER-PLATFORM: electron-builder and the bundled JRE are OS/arch specific; this
# builds for the HOST you run on. Ship Windows/Linux/Intel by building there.
#
# Prereqs: a JDK (jlink), Node + npm, macOS codesign/hdiutil. Optional:
# rsvg-convert (regenerates the icon from icon.svg; otherwise the committed
# icon.icns is used).
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # spectroscope-harness/spectro
cd "$HARNESS"
D=spectro-desktop

VERSION="${VERSION:-$(sed -nE 's/^version = "([^"]+)".*/\1/p' spectro-server/build.gradle.kts | head -1)}"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
echo "==> desktop run kit for spectro-server ${VERSION} (host: $(uname -s) ${ARCH})"

# 1) server fat jar → the version-neutral path the app's extraResources points at
echo "==> [1/6] server bootJar"
./gradlew :spectro-server:bootJar --console=plain
JAR="spectro-server/build/libs/spectro-server-${VERSION}.jar"
[ -f "$JAR" ] || { echo "!! server jar not found: $JAR"; exit 1; }
mkdir -p "$D/build"; cp -f "$JAR" "$D/build/spectro-server.jar"

# 2) jlink a full runtime (ALL-MODULE-PATH so Spring Boot's reflection is safe)
echo "==> [2/6] jlink JRE"
JDK="$(/usr/libexec/java_home 2>/dev/null || dirname "$(dirname "$(command -v jlink)")")"
[ -d "$JDK/jmods" ] || { echo "!! no jmods under $JDK — need a full JDK"; exit 1; }
rm -rf "$D/jre"
jlink --module-path "$JDK/jmods" --add-modules ALL-MODULE-PATH \
      --strip-debug --no-header-files --no-man-pages --output "$D/jre"
echo -n "    bundled runtime: "; "$D/jre/bin/java" -version 2>&1 | head -1

# 3) app icon: regenerate icon.icns from icon.svg if rsvg-convert is present
echo "==> [3/6] app icon"
if command -v rsvg-convert >/dev/null && command -v iconutil >/dev/null; then
  ISET="$(mktemp -d)/spectroscope.iconset"; mkdir -p "$ISET"
  rsvg-convert -w 1024 -h 1024 "$D/icon.svg" -o "$ISET/base.png"
  for s in 16 32 128 256 512; do
    sips -z $s $s        "$ISET/base.png" --out "$ISET/icon_${s}x${s}.png"     >/dev/null
    sips -z $((s*2)) $((s*2)) "$ISET/base.png" --out "$ISET/icon_${s}x${s}@2x.png" >/dev/null
  done
  rm -f "$ISET/base.png"
  iconutil -c icns "$ISET" -o "$D/icon.icns"
  echo "    regenerated $D/icon.icns"
else
  echo "    rsvg-convert/iconutil missing — using committed $D/icon.icns"
fi

# 4) build the app ONLY (no installer yet), so we can sign before packaging
echo "==> [4/6] electron-builder --dir"
( cd "$D" && { [ -d node_modules ] || npm ci; } && npm run build && npx electron-builder --dir )
APP="$D/release/mac-${ARCH}/spectroscope.app"
[ -d "$APP" ] || { echo "!! app not built: $APP"; exit 1; }

# 5) AD-HOC sign the whole bundle (fixes the "damaged" gate) and verify hard
echo "==> [5/6] ad-hoc codesign + verify"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" || { echo "!! signature did not verify"; exit 1; }
echo "    $(codesign -dv "$APP" 2>&1 | grep -i signature) — valid"

# 6) package the signed app into a .dmg (hdiutil preserves the signature exactly)
echo "==> [6/6] package .dmg"
STAGE="$(mktemp -d)"; ditto "$APP" "$STAGE/spectroscope.app"; ln -s /Applications "$STAGE/Applications"
DMG="$D/release/spectroscope-${VERSION}-${ARCH}.dmg"; rm -f "$DMG"
hdiutil create -volname "spectroscope" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo ""
echo "==> done: $DMG ($(du -h "$DMG" | cut -f1))"
echo "    ad-hoc signed → no 'damaged' error; users right-click → Open once."
echo "    zero-warning distribution needs an Apple Developer ID: docs/DESKTOP-SIGNING.md"
