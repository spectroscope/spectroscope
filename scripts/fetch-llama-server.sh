#!/usr/bin/env bash
# fetch-llama-server.sh — stage llama.cpp's `llama-server` and its dylib closure
# into spectro-desktop/bin, so the packaged app can run the built-in model with
# nothing else installed.
#
# WHY THE OFFICIAL RELEASE, not the Homebrew build: brew's llama-server wires
# libggml, libggml-base and OpenSSL to ABSOLUTE /opt/homebrew paths, which exist
# on no user's machine, so bundling it would have meant rewriting load paths with
# install_name_tool. The official macOS build references every library as
# @rpath/... with an LC_RPATH of @loader_path, links no OpenSSL at all, and
# compiles the Metal shaders into libggml-metal. Measured 2026-07-26: zero
# absolute non-system references across the whole set, and a real run loads
# nothing from /opt/homebrew. Nothing to rewrite; copy and sign.
#
# Pinned by build tag AND sha256: an unpinned fetch would put unreviewed code
# into a signed, notarized artifact under our Developer ID. The pin covers the
# STAGED TREE too (card 107): a manifest of the staged bytes is written at
# stage time and verified on every later run — a stamp alone skipped the sha
# check forever after the first build, so a tampered dylib in bin/ would have
# ridden into the next signed dmg unexamined. Because the runkit build signs
# bin/ in place afterwards (and adds the PTY helper), its next run always
# restages from the verified tarball — deliberate: every build starts from
# bytes that match the pin. Offline builds therefore need the tarball cache.
#
# Output:  spectro-desktop/bin/{llama-server, *.dylib, LICENSE-llama.cpp}
# Usage:   scripts/fetch-llama-server.sh [--force]
set -euo pipefail

LLAMA_BUILD="${LLAMA_BUILD:-b10107}"
LLAMA_SHA256="${LLAMA_SHA256:-b9554ab4c9f6e91199f48387cb4ab27466fb1d724881f81463ef03f6370cfa32}"

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS"
OUT="spectro-desktop/bin"
STAMP="$OUT/.llama-build"
MANIFEST="$OUT/.llama-manifest"
CACHE="${TMPDIR:-/tmp}/spectro-llama-cache"

# sha256 of every staged file + the target of every staged symlink, sorted —
# what the skip path verifies. The stamp alone said only "a run finished once";
# it never looked at the bytes again, so anything that changed a staged dylib
# between builds rode silently into the next signed, notarized artifact.
stage_manifest() {
  (cd "$OUT" && {
    find . -type f ! -name '.llama-build' ! -name '.llama-manifest' \
      -exec shasum -a 256 {} \;
    find . -type l | while read -r l; do
      printf 'link %s -> %s\n' "$l" "$(readlink "$l")"
    done
  } | LC_ALL=C sort)
}

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ASSET="llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz" ;;
  x86_64) ASSET="llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz"
          echo "!! the pinned sha256 is the arm64 asset; set LLAMA_SHA256 for x64"; exit 1 ;;
  *) echo "!! no llama.cpp asset mapped for $ARCH"; exit 1 ;;
esac

if [ "${1:-}" != "--force" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$LLAMA_BUILD" ]; then
  # The stamp says a stage finished; the manifest says the bytes are still the
  # ones that were verified. Only both together skip the restage.
  if [ -f "$MANIFEST" ] && stage_manifest | cmp -s - "$MANIFEST"; then
    echo "==> llama-server ${LLAMA_BUILD} already staged and verified in $OUT (--force to redo)"
    exit 0
  fi
  echo "==> staged tree in $OUT does not match its manifest — restaging from the pinned tarball"
fi

echo "==> [1/4] fetch llama.cpp ${LLAMA_BUILD} (${ARCH})"
mkdir -p "$CACHE"
TAR="$CACHE/$ASSET"
if [ ! -f "$TAR" ]; then
  curl -fsSL --retry 3 -o "$TAR.part" \
    "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${ASSET}"
  mv "$TAR.part" "$TAR"
fi

echo "==> [2/4] verify sha256"
GOT="$(shasum -a 256 "$TAR" | awk '{print $1}')"
if [ "$GOT" != "$LLAMA_SHA256" ]; then
  echo "!! sha256 mismatch for $ASSET"
  echo "   expected $LLAMA_SHA256"
  echo "   got      $GOT"
  echo "   refusing to bundle an unverified binary into a signed artifact"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar xzf "$TAR" -C "$WORK"
SRC="$WORK/llama-${LLAMA_BUILD}"
[ -x "$SRC/llama-server" ] || { echo "!! llama-server not in $ASSET"; exit 1; }

# 3) transitive closure over @rpath/@loader_path references. The release ships
#    ~30 tools we do not need; only llama-server's own graph is bundled. Bash 3.2
#    has no associative arrays (macOS ships 3.2), so the worklist is two files.
echo "==> [3/4] resolve dylib closure"
SEEN="$WORK/seen"; QUEUE="$WORK/queue"
: > "$SEEN"; echo "llama-server" > "$QUEUE"
while [ -s "$QUEUE" ]; do
  NAME="$(head -1 "$QUEUE")"; sed -i '' '1d' "$QUEUE"
  grep -qxF "$NAME" "$SEEN" && continue
  echo "$NAME" >> "$SEEN"
  otool -L "$SRC/$NAME" | tail -n +2 | awk '{print $1}' \
    | grep -E '^@(rpath|loader_path)/' | sed -E 's#^@[a-z_]+/##' >> "$QUEUE" || true
done

rm -rf "$OUT"; mkdir -p "$OUT"
while read -r NAME; do
  if [ -L "$SRC/$NAME" ]; then
    # keep the versioned target AND the symlink: the install names point at the link
    TARGET="$(readlink "$SRC/$NAME")"
    cp -p "$SRC/$TARGET" "$OUT/$TARGET"
    ln -sf "$TARGET" "$OUT/$NAME"
  else
    cp -p "$SRC/$NAME" "$OUT/$NAME"
  fi
done < "$SEEN"
cp -p "$SRC/LICENSE" "$OUT/LICENSE-llama.cpp"

# 4) prove the closure is closed: any absolute reference outside /usr/lib and
#    /System means the app would run here and nowhere else. That is THE defect
#    this whole step exists to prevent, so it fails the build rather than warn.
echo "==> [4/4] verify no path escapes the bundle"
LEAKS="$(for f in "$OUT"/llama-server "$OUT"/*.dylib; do
           [ -L "$f" ] && continue
           otool -L "$f" | tail -n +2 | awk '{print $1}'
         done | sort -u | grep -v '^@' | grep -v '^/usr/lib' | grep -v '^/System' || true)"
if [ -n "$LEAKS" ]; then
  echo "!! these references point outside the bundle:"
  echo "$LEAKS" | sed 's/^/     /'
  exit 1
fi

stage_manifest > "$MANIFEST"
echo "$LLAMA_BUILD" > "$STAMP"
echo "    staged $(grep -c . "$SEEN") Mach-O files, $(du -sh "$OUT" | awk '{print $1}') in $OUT"
