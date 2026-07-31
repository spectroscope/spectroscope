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

VERSION="${VERSION:-$(sed -nE 's/^version = "([^"]+)".*/\1/p' spectro-server/build.gradle.kts | head -1)}"
echo "==> linux run kit for spectro-server ${VERSION} (host: $(uname -sm))"

# 1) server fat jar -> the version-neutral path extraResources points at
if [ "${SKIP_BOOTJAR:-0}" = "1" ] && [ -f "$D/build/spectro-server.jar" ]; then
  echo "==> [1/5] bootJar SKIPPED (SKIP_BOOTJAR=1) — using staged $D/build/spectro-server.jar"
else
  echo "==> [1/5] server bootJar"
  ./gradlew :spectro-server:bootJar --console=plain
  JAR="spectro-server/build/libs/spectro-server-${VERSION}.jar"
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
( cd "$D" && { [ -d node_modules ] || npm ci; } && npm run build \
  && npx electron-builder --linux --x64 )

APPIMAGE="$D/release/spectroscope-${VERSION}-x86_64.AppImage"
DEB="$D/release/spectroscope_${VERSION}_amd64.deb"
[ -f "$APPIMAGE" ] || { echo "!! AppImage not built: $APPIMAGE"; exit 1; }
[ -f "$DEB" ] || { echo "!! deb not built: $DEB"; exit 1; }

echo ""
echo "==> done:"
for f in "$APPIMAGE" "$DEB"; do
  echo "    $f ($(du -h "$f" | cut -f1))"
  sha256sum "$f" | sed 's/^/      sha256 /'
done
echo "    unsigned by design — Linux has no Gatekeeper; provenance comes from CI provenance + the sha256s above"
