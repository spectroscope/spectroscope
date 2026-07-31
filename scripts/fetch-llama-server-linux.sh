#!/usr/bin/env bash
# fetch-llama-server-linux.sh — stage llama.cpp's `llama-server` and its .so
# closure into spectro-desktop/bin-linux-x64, so the packaged Linux app
# (AppImage / .deb) can run the built-in model with nothing else installed.
# The Linux edition of scripts/fetch-llama-server.sh — same pin discipline,
# same "any load path that leaves the bundle fails the build" guarantee
# (card 100), ported from otool/dylibs to readelf+ldd/.so.
#
# WHAT DIFFERS FROM THE macOS BUNDLE (all measured 2026-07-31, card 134):
#   * Every ELF in the official ubuntu-x64 build carries RUNPATH [$ORIGIN] —
#     the Linux equivalent of @loader_path. Copy-and-go, no patchelf.
#   * Unlike the macOS build, OpenSSL IS linked: libllama-server-impl.so and
#     libllama-common.so NEED libssl.so.3 + libcrypto.so.3. Those stay SYSTEM
#     libraries (allowlisted below): the .deb declares them as a dependency,
#     and every mainstream 2022+ distro ships OpenSSL 3 (measured present on
#     bare ubuntu:24.04 and debian:12).
#   * libgomp.so.1 (GNU OpenMP) is NEEDED by libggml-base and the CPU
#     backends but is ABSENT on a bare ubuntu:24.04 — so it is BUNDLED here,
#     copied from the build machine; $ORIGIN makes the loader prefer the
#     bundled copy. (GCC runtime library, GPL with the GCC Runtime Library
#     Exception — redistributable in this bundle.)
#   * THE DLOPEN TRAP: the CPU backend ships as ~14 march variants
#     (libggml-cpu-sse42.so … libggml-cpu-zen4.so) that appear in NO NEEDED
#     entry anywhere; ggml probes them at runtime from the executable's own
#     directory (proven with LD_DEBUG=libs). A NEEDED-closure walk alone
#     would ship a bundle with no CPU backend, so they are staged explicitly.
#
# Pinned by build tag AND sha256, and the staged tree carries a byte manifest
# exactly like the macOS script (card 107): the skip path re-verifies the
# staged bytes on every run, never just a stamp.
#
# Output:  spectro-desktop/bin-linux-x64/{llama-server, *.so*, LICENSE-llama.cpp}
# Usage:   scripts/fetch-llama-server-linux.sh [--force|--verify-only]
set -euo pipefail

LLAMA_BUILD="${LLAMA_BUILD:-b10107}"
# sha256 of llama-b10107-bin-ubuntu-x64.tar.gz — GitHub API digest,
# re-measured locally on the downloaded bytes 2026-07-31.
LLAMA_SHA256="${LLAMA_SHA256:-afe1ae0b706c4a0830b218a9249037b7a6cc723f81deb78825662128b25453e6}"

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS"

[ "$(uname -s)" = "Linux" ] || { echo "!! Linux only — on macOS use scripts/fetch-llama-server.sh"; exit 1; }
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz" ;;
  aarch64) ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-arm64.tar.gz"
           echo "!! the pinned sha256 is the x64 asset; set LLAMA_SHA256 for arm64"; exit 1 ;;
  *) echo "!! no llama.cpp asset mapped for $ARCH"; exit 1 ;;
esac

OUT="spectro-desktop/bin-linux-x64"
STAMP="$OUT/.llama-build"
MANIFEST="$OUT/.llama-manifest"
CACHE="${TMPDIR:-/tmp}/spectro-llama-cache"
# Stamp value carries os+arch so a tree staged by THIS script can never satisfy
# the macOS script's skip check, and vice versa (they stage different bytes).
STAMP_VALUE="${LLAMA_BUILD}-linux-${ARCH}"

# glibc + toolchain runtime + the declared system TLS pair. Everything else a
# staged ELF references must resolve INSIDE the bundle or the build fails.
SYSTEM_ALLOWLIST="libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 librt.so.1 \
libgcc_s.so.1 libstdc++.so.6 ld-linux-x86-64.so.2 libssl.so.3 libcrypto.so.3"

# sha256 of every staged file + the target of every staged symlink, sorted —
# what the skip path verifies (same scheme as the macOS script).
stage_manifest() {
  (cd "$OUT" && {
    find . -type f ! -name '.llama-build' ! -name '.llama-manifest' \
      -exec sha256sum {} \;
    find . -type l | while read -r l; do
      printf 'link %s -> %s\n' "$l" "$(readlink "$l")"
    done
  } | LC_ALL=C sort)
}

# The card-100 guarantee, Linux edition: run the real dynamic loader (ldd) over
# every staged ELF. Every resolved dependency must land inside the bundle
# ($ORIGIN RUNPATH) or be one of the allowlisted system libraries under
# /lib | /usr/lib. Any "not found", any resolution outside those two sets —
# LD_LIBRARY_PATH leakage, a homedir lib, a /opt path — fails the build. Loud.
verify_closure() {
  local out_abs leaks f dep resolved base ok
  out_abs="$(cd "$OUT" && pwd)"
  leaks=""
  for f in "$out_abs"/*; do
    [ -L "$f" ] && continue
    [ -f "$f" ] || continue
    head -c 4 "$f" | grep -q $'\x7fELF' || continue
    while IFS= read -r line; do
      case "$line" in
        *linux-vdso.so*) continue ;;
        *"not found"*)
          leaks="${leaks}    $(basename "$f"): ${line# }"$'\n'; continue ;;
      esac
      if printf '%s' "$line" | grep -q '=>'; then
        dep="$(printf '%s' "$line" | awk '{print $1}')"
        resolved="$(printf '%s' "$line" | awk '{print $3}')"
      else
        # the interpreter line: "/lib64/ld-linux-x86-64.so.2 (0x...)"
        dep="$(printf '%s' "$line" | awk '{print $1}')"
        resolved="$dep"
      fi
      case "$resolved" in
        "$out_abs"/*) continue ;;                       # inside the bundle — good
        /lib/*|/lib64/*|/usr/lib/*)
          base="$(basename "$dep")"
          ok=0
          for a in $SYSTEM_ALLOWLIST; do [ "$base" = "$a" ] && ok=1; done
          [ "$ok" = 1 ] && continue
          leaks="${leaks}    $(basename "$f"): $dep => $resolved (system lib not on the allowlist)"$'\n' ;;
        *)
          leaks="${leaks}    $(basename "$f"): $dep => $resolved (outside bundle and system dirs)"$'\n' ;;
      esac
    done < <(ldd "$f" 2>&1 | sed 's/^[[:space:]]*//')
  done
  if [ -n "$leaks" ]; then
    echo "!! closure check FAILED — these load paths leave the bundle:"
    printf '%s' "$leaks"
    echo "   the built-in model would run on this machine and nowhere else — refusing to package"
    return 1
  fi
  echo "    closure closed: every dependency resolves in-bundle or on the system allowlist"
}

if [ "${1:-}" = "--verify-only" ]; then
  [ -d "$OUT" ] || { echo "!! nothing staged in $OUT"; exit 1; }
  echo "==> verify staged closure in $OUT"
  verify_closure
  exit $?
fi

if [ "${1:-}" != "--force" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$STAMP_VALUE" ]; then
  if [ -f "$MANIFEST" ] && stage_manifest | cmp -s - "$MANIFEST"; then
    echo "==> llama-server ${LLAMA_BUILD} (linux-${ARCH}) already staged and verified in $OUT (--force to redo)"
    exit 0
  fi
  echo "==> staged tree in $OUT does not match its manifest — restaging from the pinned tarball"
fi

echo "==> [1/4] fetch llama.cpp ${LLAMA_BUILD} (linux-${ARCH})"
mkdir -p "$CACHE"
TAR="$CACHE/$ASSET"
if [ ! -f "$TAR" ]; then
  curl -fsSL --retry 3 -o "$TAR.part" \
    "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${ASSET}"
  mv "$TAR.part" "$TAR"
fi

echo "==> [2/4] verify sha256"
GOT="$(sha256sum "$TAR" | awk '{print $1}')"
if [ "$GOT" != "$LLAMA_SHA256" ]; then
  echo "!! sha256 mismatch for $ASSET"
  echo "   expected $LLAMA_SHA256"
  echo "   got      $GOT"
  echo "   refusing to bundle an unverified binary"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar xzf "$TAR" -C "$WORK"
SRC="$WORK/llama-${LLAMA_BUILD}"
[ -x "$SRC/llama-server" ] || { echo "!! llama-server not in $ASSET"; exit 1; }

# 3) the staging set: NEEDED-walk from llama-server (readelf), following only
#    names that live in the tarball (system libs are checked later by ldd),
#    PLUS the dlopen'd CPU/RPC backends no NEEDED entry ever names.
echo "==> [3/4] resolve .so closure"
SEEN="$WORK/seen"; QUEUE="$WORK/queue"
: > "$SEEN"; echo "llama-server" > "$QUEUE"
for b in "$SRC"/libggml-cpu-*.so "$SRC"/libggml-rpc.so; do
  [ -e "$b" ] && basename "$b" >> "$QUEUE"
done
while [ -s "$QUEUE" ]; do
  NAME="$(head -1 "$QUEUE")"; sed -i '1d' "$QUEUE"
  grep -qxF "$NAME" "$SEEN" && continue
  [ -e "$SRC/$NAME" ] || continue        # not in the tarball -> system, ldd judges it
  echo "$NAME" >> "$SEEN"
  readelf -d "$SRC/$NAME" 2>/dev/null \
    | awk '/\(NEEDED\)/ {n=$NF; gsub(/[\[\]]/,"",n); print n}' >> "$QUEUE" || true
done

rm -rf "$OUT"; mkdir -p "$OUT"
while read -r NAME; do
  if [ -L "$SRC/$NAME" ]; then
    # keep the versioned target AND the symlink: the NEEDED names point at the link
    TARGET="$(readlink "$SRC/$NAME")"
    cp -p "$SRC/$TARGET" "$OUT/$TARGET"
    ln -sf "$TARGET" "$OUT/$NAME"
  else
    cp -p "$SRC/$NAME" "$OUT/$NAME"
  fi
done < "$SEEN"
cp -p "$SRC/LICENSE" "$OUT/LICENSE-llama.cpp"

# bundle libgomp.so.1 (see header): $ORIGIN makes the bundled copy win even
# where a system one exists. -L dereferences the ldconfig symlink.
GOMP="$(ldconfig -p 2>/dev/null | awk '/libgomp\.so\.1 \(/ {print $NF; exit}')"
[ -n "$GOMP" ] && [ -f "$GOMP" ] || { echo "!! libgomp.so.1 not found on the build machine (install gcc's runtime)"; exit 1; }
cp -L "$GOMP" "$OUT/libgomp.so.1"

echo "==> [4/4] verify no load path escapes the bundle"
verify_closure

stage_manifest > "$MANIFEST"
echo "$STAMP_VALUE" > "$STAMP"
echo "    staged $(grep -c . "$SEEN") ELF files (+libgomp.so.1), $(du -sh "$OUT" | awk '{print $1}') in $OUT"
