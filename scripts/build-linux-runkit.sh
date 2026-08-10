#!/usr/bin/env bash
# build-linux-runkit.sh — build the spectroscope Linux desktop run kit.
#
# The Linux leg of scripts/build-desktop-runkit.sh (which stays macOS-only and
# untouched): same shape — server jar + jlink'd JRE + llama-server closure +
# PTY helper into the Electron shell — but the outputs are an AppImage and a
# .deb, and NOTHING is signed at this layer (no Gatekeeper on Linux; a CI
# runner can build the whole kit, unlike the DMG that needs the Developer ID).
#
# Output:  spectro-desktop/release/spectroscope-<version>-x86_64.AppImage
#          spectro-desktop/release/spectroscope_<version>_amd64.deb
#
# Staging dirs are OS/arch-suffixed (jre-linux-x64, bin-linux-x64) so a Linux
# build can never contaminate the macOS dirs (jre/, bin/) and vice versa; the
# electron-builder `linux` block in spectro-desktop/package.json maps them to
# the same resources/{jre,bin} layout the shell already resolves via
# process.resourcesPath — main.ts needs no per-OS path branch.
#
# Naming, stated once because two of these are derived by default and both
# defaults are wrong here: package.json's build.linux.executableName and
# build.deb.packageName are BOTH pinned to "spectroscope". Left alone,
# electron-builder takes them from the npm package name (spectro-desktop) and
# a user would apt-install one spelling and type another. The values live in
# package.json because electron-builder validates its config object and
# rejects any commentary key next to them.
#
# Prereqs: a Linux machine (or container), JDK 21 (jlink + jmods), Node + npm,
# a C compiler (PTY helper), binutils (readelf). electron-builder downloads
# its own fpm and AppImage tooling. Env:
#   SKIP_BOOTJAR=1  reuse an already-staged spectro-desktop/build/spectro-server.jar
#                   (e.g. built on another machine — Java bytecode is portable)
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS"
D=spectro-desktop

[ "$(uname -s)" = "Linux" ] || { echo "!! this is the Linux leg — on macOS use scripts/build-desktop-runkit.sh"; exit 1; }
ARCH="$(uname -m)"
[ "$ARCH" = "x86_64" ] || { echo "!! only x86_64 is wired (asset pin + artifact names) — extend the pins for $ARCH"; exit 1; }

# Two versions, deliberately separate: SERVER_VERSION is what Gradle builds
# and therefore what the jar on disk is called; KIT_VERSION is what the
# packaged artifacts claim to be. They differ on every build that is not a
# release cut (the first CI run conflated them and looked for a jar Gradle
# never wrote).
SERVER_VERSION="$(sed -nE 's/^version = "([^"]+)".*/\1/p' spectro-server/build.gradle.kts | head -1)"

# KIT_VERSION stamps the artifacts with something other than the tree's release
# version. A build off main is NOT the release whose number the tree carries:
# pooling bytes labelled 0.4.1 next to the real 0.4.1 gives two different
# artifacts the same identity, and apt would have to pick one by hash. The
# caller passes a build-metadata form (0.4.1+dev.<sha>): npm accepts it after
# the plus, and dpkg sorts it above 0.4.1 and below 0.4.2, so a later release
# still upgrades over it. electron-builder names both artifacts from
# package.json, so the version has to land there before it runs.
VERSION="${KIT_VERSION:-$SERVER_VERSION}"
if [ -n "${KIT_VERSION:-}" ]; then
  ( cd "$D" && npm version --no-git-tag-version --allow-same-version "$KIT_VERSION" >/dev/null )
  echo "==> stamped $D/package.json with KIT_VERSION $KIT_VERSION (not a release build)"
fi
echo "==> linux run kit for spectro-server ${VERSION} (host: $(uname -sm))"

# 1) server fat jar -> the version-neutral path extraResources points at
if [ "${SKIP_BOOTJAR:-0}" = "1" ] && [ -f "$D/build/spectro-server.jar" ]; then
  echo "==> [1/5] bootJar SKIPPED (SKIP_BOOTJAR=1) — using staged $D/build/spectro-server.jar"
else
  echo "==> [1/5] server bootJar"
  ./gradlew :spectro-server:bootJar --console=plain
  JAR="spectro-server/build/libs/spectro-server-${SERVER_VERSION}.jar"
  [ -f "$JAR" ] || { echo "!! server jar not found: $JAR"; exit 1; }
  mkdir -p "$D/build"; cp -f "$JAR" "$D/build/spectro-server.jar"
fi

# 2) jlink a full runtime from this machine's JDK (ALL-MODULE-PATH so Spring
#    Boot's reflection is safe — same recipe as the macOS kit)
echo "==> [2/5] jlink JRE (linux-x64)"
JDK="${JAVA_HOME:-$(dirname "$(dirname "$(command -v jlink)")")}"
[ -d "$JDK/jmods" ] || { echo "!! no jmods under $JDK — need a full JDK 21"; exit 1; }
rm -rf "$D/jre-linux-x64"
jlink --module-path "$JDK/jmods" --add-modules ALL-MODULE-PATH \
      --strip-debug --no-header-files --no-man-pages --output "$D/jre-linux-x64"
echo -n "    bundled runtime: "; "$D/jre-linux-x64/bin/java" -version 2>&1 | head -1

# 3) llama-server closure (pinned + closure-checked) and the PTY helper.
#    build-spectro-pty.sh compiles into $D/bin (its fixed output, harmless on a
#    Linux checkout); the helper is then MOVED into the Linux staging dir.
#    Moving it in invalidates the fetch manifest ON PURPOSE: the next run
#    restages from the pinned tarball, so every build starts from bytes that
#    match the pin — the same discipline the macOS runkit has around signing.
echo "==> [3/5] bundled llama-server + spectro-pty"
./scripts/fetch-llama-server-linux.sh
./scripts/build-spectro-pty.sh --force
mv -f "$D/bin/spectro-pty" "$D/bin-linux-x64/spectro-pty"

# 4) icon: Linux wants a PNG (icon.icns serves macOS only). The committed
#    icon.png is the fallback; regenerate from icon.svg when rsvg-convert is
#    around so the three icons can never drift apart silently.
echo "==> [4/5] app icon"
if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 512 -h 512 "$D/icon.svg" -o "$D/icon.png"
  echo "    regenerated $D/icon.png from icon.svg"
else
  [ -f "$D/icon.png" ] || { echo "!! no rsvg-convert and no committed $D/icon.png"; exit 1; }
  echo "    rsvg-convert missing — using committed $D/icon.png"
fi

# 5) electron-builder: AppImage + deb, x64. No signing, no post-packaging step
#    — the artifacts come out of electron-builder finished.
echo "==> [5/5] electron-builder --linux (AppImage, deb)"
# Unconditional for the reason spelled out in build-desktop-runkit.sh: a
#    reused node_modules ships a runtime the lockfile does not name.
( cd "$D" && npm ci && npm run build \
  && npx electron-builder --linux --x64 )

# Find the artifacts rather than predict their names: electron-builder does
# its own sanitising of a version string (a build-metadata "+" is exactly the
# kind of character that gets rewritten), and a build that succeeded must not
# fail on a guessed filename. What the artifacts CLAIM is checked where the
# claim actually lives, in the deb's own Version field (see linux-kit.yml).
APPIMAGE="$(ls "$D"/release/spectroscope-*-x86_64.AppImage 2>/dev/null | head -1)"
DEB="$(ls "$D"/release/spectroscope_*_amd64.deb 2>/dev/null | head -1)"
[ -n "$APPIMAGE" ] && [ -f "$APPIMAGE" ] || { echo "!! no AppImage in $D/release"; exit 1; }
[ -n "$DEB" ] && [ -f "$DEB" ] || { echo "!! no deb in $D/release"; exit 1; }

echo ""
echo "==> done:"
for f in "$APPIMAGE" "$DEB"; do
  echo "    $f ($(du -h "$f" | cut -f1))"
  sha256sum "$f" | sed 's/^/      sha256 /'
done
echo "    unsigned by design — Linux has no Gatekeeper; provenance comes from CI provenance + the sha256s above"
