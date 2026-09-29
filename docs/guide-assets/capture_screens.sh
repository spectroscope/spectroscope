#!/usr/bin/env bash
# The main plate suite (capture_screens.mjs), both themes, from a cold start.
#
# Each themed pass gets a fresh COPY of the curated demo-home. Since 0.14.2 the
# session plates continue a stored session, and continuing appends to its file;
# a copy keeps the tracked demo-home byte for byte as committed, and the second
# pass sees the same seven rows the first one saw.
#
# The workspace is a copy of demo-workspace, as in capture_chat.sh, so the Files
# plates show a folder that ships with the script and nothing from this machine.
#
#   docs/guide-assets/capture_screens.sh
#
# Wants: a built server jar and ollama up with the model below (it must think
# and call tools: the thinking, gate and plan plates depend on both).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
JAR="${SPECTRO_SHOT_JAR:-$(ls -t "$ROOT"/spectro-server/build/libs/spectro-server-*.jar | grep -v -- "-plain" | head -1)}"
MODEL="${SPECTRO_SHOT_MODEL:-qwen3.5:35b-a3b-q4_K_M}"
HOME_DIR=/tmp/spectro-shots-screens-home
WS=/tmp/spectro-shots-screens-ws
PORT=8090

[ -f "$JAR" ] || { echo "no server jar at $JAR: ./gradlew :spectro-server:bootJar" >&2; exit 1; }
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken by another process; stop it first" >&2
  exit 1
fi

cleanup() {
  pkill -f "user.home=$HOME_DIR" 2>/dev/null || true
  sleep 1
  rm -rf "$HOME_DIR" "$WS"
}
trap cleanup EXIT

start_server() {
  pkill -f "user.home=$HOME_DIR" 2>/dev/null || true
  sleep 2
  rm -rf "$HOME_DIR" "$WS"
  mkdir -p "$HOME_DIR" "$WS"
  cp -R "$HERE/demo-home/.spectro" "$HOME_DIR/.spectro"
  cp -R "$HERE/demo-workspace/." "$WS/"
  # The copy's settings, never the tracked file: the backend for the live plates.
  cat >"$HOME_DIR/.spectro/settings.json" <<JSON
{ "provider": "ollama", "model": "$MODEL", "workspace": "$WS", "thinking": true }
JSON
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GEMINI_API_KEY -u OPENROUTER_API_KEY \
    java "-Duser.home=$HOME_DIR" -jar "$JAR" --server.port=$PORT \
    >/tmp/shots-screens.log 2>&1 &
  for _ in $(seq 1 60); do
    curl -fs --max-time 2 "http://localhost:$PORT/api/config" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server never came up on :$PORT" >&2
  exit 1
}

status=0
for theme in ${THEMES:-dark light}; do
  echo "=== $theme ==="
  start_server
  THEME=$theme BASE_URL="http://localhost:$PORT" node "$HERE/capture_screens.mjs" || status=1
done
exit $status
