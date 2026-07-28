#!/usr/bin/env bash
# build-spectro-pty.sh — compile the PTY helper into spectro-desktop/bin, the
# same directory fetch-llama-server.sh stages into and the same one
# build-desktop-runkit.sh signs inside-out with the Developer ID before
# electron-builder seals the app. That is deliberate: dropping the helper there
# means the DMG story needs no change to the signing block at all, and card 100
# already measured that a binary of ours needs no extra entitlement under the
# hardened runtime.
#
# In dev the server finds the same file by walking up from its working directory
# (HelperPtyProvider.locate), so building once is enough for `bootRun`, the jar
# and the tests.
#
# Output:  spectro-desktop/bin/spectro-pty
# Usage:   scripts/build-spectro-pty.sh [--force]
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS"

SRC="native/spectro-pty.c"
OUT="spectro-desktop/bin"
BIN="$OUT/spectro-pty"

[ -f "$SRC" ] || { echo "!! $SRC missing"; exit 1; }

if [ "${1:-}" != "--force" ] && [ -x "$BIN" ] && [ "$BIN" -nt "$SRC" ]; then
  echo "==> spectro-pty is already current in $OUT (--force to rebuild)"
  exit 0
fi

CC_BIN="${CC:-cc}"
command -v "$CC_BIN" >/dev/null || {
  echo "!! no C compiler ($CC_BIN). On macOS: xcode-select --install"
  exit 1
}

mkdir -p "$OUT"
echo "==> compile $SRC ($(uname -m))"
# -Os because this is a relay, not a hot loop; the warnings are on because the
# one thing in here that can hurt somebody is a buffer arithmetic slip.
"$CC_BIN" -std=c11 -Os -Wall -Wextra -Werror -o "$BIN" "$SRC"

echo "==> verify"
# The usage line goes to stderr and the exit code is 2, so capture both without
# letting `set -e -o pipefail` mistake a correct refusal for a build failure.
USAGE="$("$BIN" 2>&1 || true)"
case "$USAGE" in
  *"usage: spectro-pty"*) ;;
  *) echo "!! the built helper does not answer its own usage line"; exit 1 ;;
esac
# A real end-to-end check: a shell on a real terminal answers `tty` with a tty.
# stdin is held open for a moment on purpose — closing it is the helper's signal
# that its caller died, and it takes the shell down immediately when it comes.
PROBE="$({ printf '\x00\x00\x00\x00\x04tty\n'; sleep 1; } \
  | "$BIN" 24 80 -- /bin/sh -c 'tty' 2>/dev/null || true)"
case "$PROBE" in
  *"/dev/tty"*) echo "    a child of the helper sees a real terminal" ;;
  *) echo "!! the helper's child has no tty (got: ${PROBE:-<nothing>})"; exit 1 ;;
esac

echo "    built $BIN ($(du -h "$BIN" | awk '{print $1}'))"
