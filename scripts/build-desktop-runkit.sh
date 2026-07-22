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
# SIGNING — two modes, auto-selected:
#   * Developer ID present (a "Developer ID Application" cert in the keychain, OR
#     SIGN_IDENTITY set): the app + the bundled JRE are signed with the hardened
#     runtime + entitlements, and — if a notarytool keychain profile is available
#     (NOTARY_PROFILE, default "spectro-notary") — the .dmg is notarized + stapled.
#     Result: double-click, ZERO warning, even offline. See docs/DESKTOP-SIGNING.md.
#   * No Developer ID: AD-HOC signed (free, no Apple account). Avoids the
#     "\"spectroscope.app\" is damaged" error; macOS shows the normal
#     "unidentified developer" prompt, so the user right-clicks → Open once.
#
# The Valtech corporate certificate is NEVER used, even if it appears in the
# keychain — spectroscope ships under its own identity only.
#
# PER-PLATFORM: electron-builder and the bundled JRE are OS/arch specific; this
# builds for the HOST you run on. Ship Windows/Linux/Intel by building there.
#
# Prereqs: a JDK (jlink), Node + npm, macOS codesign/hdiutil. Optional:
# rsvg-convert (regenerates the icon from icon.svg; otherwise the committed
# icon.icns is used). For the signed path: an Apple Developer ID + (for
# notarization) a stored notarytool profile.
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # spectroscope-harness/spectro
cd "$HARNESS"
D=spectro-desktop
ENT="$D/build/entitlements.mac.plist"

VERSION="${VERSION:-$(sed -nE 's/^version = "([^"]+)".*/\1/p' spectro-server/build.gradle.kts | head -1)}"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
echo "==> desktop run kit for spectro-server ${VERSION} (host: $(uname -s) ${ARCH})"

# 0) signing identity: explicit SIGN_IDENTITY wins; else auto-detect a
#    "Developer ID Application" cert — but NEVER the Valtech one. Empty => ad-hoc.
ID="${SIGN_IDENTITY:-}"
if [ -z "$ID" ]; then
  ID="$(security find-identity -v -p codesigning 2>/dev/null \
        | grep "Developer ID Application" | grep -vi valtech \
        | head -1 | sed -E 's/^[[:space:]]*[0-9]+\) [0-9A-F]+ "([^"]+)".*/\1/')"
fi
if [ -n "$ID" ]; then
  echo "$ID" | grep -qi valtech && { echo "!! refusing to sign with a Valtech identity"; exit 1; }
  [ -f "$ENT" ] || { echo "!! Developer ID present but $ENT is missing (see docs/DESKTOP-SIGNING.md step 4)"; exit 1; }
  echo "==> signing identity: $ID"
else
  echo "==> no Developer ID — ad-hoc signing (docs/DESKTOP-SIGNING.md for zero-warning)"
fi

# 1) server fat jar → the version-neutral path the app's extraResources points at
echo "==> [1/7] server bootJar"
./gradlew :spectro-server:bootJar --console=plain
JAR="spectro-server/build/libs/spectro-server-${VERSION}.jar"
[ -f "$JAR" ] || { echo "!! server jar not found: $JAR"; exit 1; }
mkdir -p "$D/build"; cp -f "$JAR" "$D/build/spectro-server.jar"

# 2) jlink a full runtime (ALL-MODULE-PATH so Spring Boot's reflection is safe)
echo "==> [2/7] jlink JRE"
JDK="$(/usr/libexec/java_home 2>/dev/null || dirname "$(dirname "$(command -v jlink)")")"
[ -d "$JDK/jmods" ] || { echo "!! no jmods under $JDK — need a full JDK"; exit 1; }
rm -rf "$D/jre"
jlink --module-path "$JDK/jmods" --add-modules ALL-MODULE-PATH \
      --strip-debug --no-header-files --no-man-pages --output "$D/jre"
echo -n "    bundled runtime: "; "$D/jre/bin/java" -version 2>&1 | head -1

# 2b) SIGNED path: sign every Mach-O in the runtime inside-out, BEFORE
#     electron-builder seals the app over it (a single unsigned dylib in the JRE
#     fails notarization). Ad-hoc path skips this — its --deep --sign - covers all.
if [ -n "$ID" ]; then
  echo "==> [2b/7] codesign bundled JRE (hardened runtime)"
  find "$D/jre" -type f \( -name '*.dylib' -o -perm +111 \) -print0 \
    | xargs -0 -I{} codesign --force --timestamp --options runtime \
        --entitlements "$ENT" --sign "$ID" "{}"
fi

# 3) app icon: regenerate icon.icns from icon.svg if rsvg-convert is present
echo "==> [3/7] app icon"
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

# 4) build the app ONLY (no installer yet), so we can seal it after the JRE.
#    SIGNED: electron-builder auto-discovers the identity (CSC_NAME pins it) and
#    signs the Electron framework + helper apps with the hardened runtime from
#    package.json. AD-HOC: disable discovery so it leaves the app unsigned.
echo "==> [4/7] electron-builder --dir"
( cd "$D" && { [ -d node_modules ] || npm ci; } && npm run build \
  && if [ -n "$ID" ]; then CSC_NAME="$ID" npx electron-builder --dir; \
     else CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --dir; fi )
APP="$D/release/mac-${ARCH}/spectroscope.app"
[ -d "$APP" ] || { echo "!! app not built: $APP"; exit 1; }

# 5) seal + verify the whole bundle
echo "==> [5/7] codesign app + verify"
if [ -n "$ID" ]; then
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$ENT" --sign "$ID" "$APP"
else
  codesign --force --deep --sign - "$APP"   # ad-hoc: fixes the "damaged" gate
fi
codesign --verify --deep --strict "$APP" || { echo "!! signature did not verify"; exit 1; }
echo "    $(codesign -dv "$APP" 2>&1 | grep -i 'Signature\|Authority' | head -1)"

# 6) package the signed app into a .dmg (hdiutil preserves the signature exactly)
echo "==> [6/7] package .dmg"
STAGE="$(mktemp -d)"; ditto "$APP" "$STAGE/spectroscope.app"; ln -s /Applications "$STAGE/Applications"
DMG="$D/release/spectroscope-${VERSION}-${ARCH}.dmg"; rm -f "$DMG"
hdiutil create -volname "spectroscope" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

# 7) SIGNED path: notarize + staple if a notarytool profile is available.
#    Submitting uploads the build to Apple — set NOTARY_PROFILE (default
#    "spectro-notary"; store it once with `xcrun notarytool store-credentials`).
NOTARY_PROFILE="${NOTARY_PROFILE:-spectro-notary}"
if [ -n "$ID" ] && xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  echo "==> [7/7] notarize + staple (profile: $NOTARY_PROFILE)"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG" && echo "    notarized + stapled — double-click, no warning"
elif [ -n "$ID" ]; then
  echo "==> [7/7] SKIP notarization — no notarytool profile '$NOTARY_PROFILE'"
  echo "    signed but NOT notarized: first-open still warns. Store a profile"
  echo "    (docs/DESKTOP-SIGNING.md step 3) and re-run for zero-warning."
else
  echo "==> [7/7] ad-hoc build — no notarization"
fi

echo ""
echo "==> done: $DMG ($(du -h "$DMG" | cut -f1))"
if [ -n "$ID" ]; then
  echo "    signed with: $ID"
else
  echo "    ad-hoc signed → no 'damaged' error; users right-click → Open once."
  echo "    zero-warning distribution needs an Apple Developer ID: docs/DESKTOP-SIGNING.md"
fi
