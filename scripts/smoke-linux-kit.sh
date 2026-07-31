#!/usr/bin/env bash
# smoke-linux-kit.sh — boot smoke for the packaged Linux run kit (card 134).
#
# Proves, on a machine that never saw the build:
#   1. the bundled llama-server EXECUTES from the bundle and every library it
#      loads resolves in-bundle or from the documented system set (ldd quoted),
#   2. the Electron shell boots headless (xvfb), spawns its JVM child, and the
#      child's /api/health answers ok,
#   3. terminating the shell REAPS the JVM — no orphaned server process.
#
# Usage:  scripts/smoke-linux-kit.sh deb              # expects the .deb installed (/opt/spectroscope)
#         scripts/smoke-linux-kit.sh appimage FILE    # extracts FILE (no FUSE needed)
#
# Environment: xvfb-run, dbus-run-session, curl, pgrep must be present.
# Chromium flags: --no-sandbox (user namespaces are unavailable in default
# containers), --disable-gpu, --disable-dev-shm-usage (Docker's 64 MB /dev/shm).
# DBus warnings from Tray/Notification are noise, never a failure.
set -euo pipefail

MODE="${1:?usage: smoke-linux-kit.sh deb|appimage [file]}"
BOOT_BUDGET_S="${BOOT_BUDGET_S:-300}"   # generous: CI runners and emulated containers are slow
LOG="$(mktemp /tmp/spectro-smoke-XXXX.log)"

case "$MODE" in
  deb)
    EXE="/opt/spectroscope/spectroscope"
    RES="/opt/spectroscope/resources"
    # Anchored: the wrapper chain (dbus-run-session, xvfb-run) carries the same
    # path as an ARGUMENT, so an unanchored match + `pgrep -o` would pick the
    # oldest wrapper instead of the Electron main process.
    PGREP_PATTERN="^/opt/spectroscope/spectroscope"
    ;;
  appimage)
    FILE="$(cd "$(dirname "${2:?usage: smoke-linux-kit.sh appimage FILE}")" && pwd)/$(basename "$2")"
    [ -f "$FILE" ] || { echo "!! no such AppImage: $FILE"; exit 1; }
    WORK="$(mktemp -d /tmp/spectro-appimage-XXXX)"
    ( cd "$WORK" && "$FILE" --appimage-extract >/dev/null )
    EXE="$WORK/squashfs-root/AppRun"
    RES="$WORK/squashfs-root/resources"
    # Anchored for the same reason as the deb pattern; AppRun (a shell script)
    # execs $APPDIR/spectroscope, so argv[0] of the real main process is the
    # squashfs-root binary.
    PGREP_PATTERN="^[^ ]*squashfs-root/spectroscope"
    ;;
  *) echo "!! unknown mode: $MODE"; exit 1 ;;
esac
[ -x "$EXE" ] || { echo "!! shell executable missing: $EXE"; exit 1; }

echo "==> [1/4] bundled llama-server: resolve + execute from the bundle"
[ -x "$RES/bin/llama-server" ] || { echo "!! no bundled llama-server under $RES/bin"; exit 1; }
ldd "$RES/bin/llama-server"
NOTFOUND="$(ldd "$RES/bin/llama-server" 2>&1 | grep "not found" || true)"
[ -z "$NOTFOUND" ] || { echo "!! unresolved libraries:"; echo "$NOTFOUND"; exit 1; }
"$RES/bin/llama-server" --version 2>&1 | head -2

echo "==> [2/4] boot the shell under xvfb"
SPECTRO_HEALTH_BUDGET_MS="$((BOOT_BUDGET_S * 1000))" \
  dbus-run-session -- xvfb-run -a \
  "$EXE" --no-sandbox --disable-gpu --disable-dev-shm-usage \
  >"$LOG" 2>&1 &
WRAPPER_PID=$!

# The shell picks a random free port and passes --server.port to the JVM; the
# child's stdout is piped through the shell, so Spring Boot's bind line lands
# in our log. That line is the port oracle.
PORT=""
for _ in $(seq 1 "$BOOT_BUDGET_S"); do
  PORT="$(grep -oE 'Tomcat started on port [0-9]+' "$LOG" | grep -oE '[0-9]+$' | head -1 || true)"
  [ -n "$PORT" ] && break
  kill -0 "$WRAPPER_PID" 2>/dev/null || { echo "!! shell exited before the server bound — log tail:"; tail -30 "$LOG"; exit 1; }
  sleep 1
done
[ -n "$PORT" ] || { echo "!! no Tomcat bind line within ${BOOT_BUDGET_S}s — log tail:"; tail -30 "$LOG"; exit 1; }
echo "    server bound on port $PORT"

echo "==> [3/4] /api/health"
HEALTH="$(curl -fsS "http://127.0.0.1:${PORT}/api/health")"
echo "    GET /api/health -> $HEALTH"

echo "==> [4/4] quit + reap"
EPID="$(pgrep -o -f "$PGREP_PATTERN" || true)"
[ -n "$EPID" ] || { echo "!! could not find the Electron main process ($PGREP_PATTERN)"; exit 1; }
kill -TERM "$EPID"
for _ in $(seq 1 30); do
  pgrep -f 'spectro-server\.jar' >/dev/null || break
  sleep 1
done
if pgrep -f 'spectro-server\.jar' >/dev/null; then
  echo "!! the JVM survived the shell's exit — orphaned server:"
  pgrep -af 'spectro-server\.jar'
  exit 1
fi
if pgrep -f "$PGREP_PATTERN" >/dev/null; then
  echo "!! the shell itself is still running:"; pgrep -af "$PGREP_PATTERN"; exit 1
fi
echo "    JVM reaped, shell gone — clean shutdown"
echo "==> smoke green ($MODE)"
