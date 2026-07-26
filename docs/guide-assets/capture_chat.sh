#!/usr/bin/env bash
# The chat plates, both themes, from a cold start.
#
# Each themed pass gets its own pristine home. The ladder's intro is asked once
# per home and the conversation is typed for real, so a second pass against a
# used home would find neither the clean header nor an empty chat.
#
# The workspace is built here rather than pointed at something on the machine:
# the plates show the Files panel and a real command running, and a demo that
# ships with the script is the only way that frame stays reproducible.
#
#   docs/guide-assets/capture_chat.sh
#
# Wants: a built server jar and ollama up with the model below.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
JAR="$ROOT/spectro-server/build/libs/spectro-server-0.3.0.jar"
MODEL="${SPECTRO_SHOT_MODEL:-qwen3.5:27b-q4_K_M}"
HOME_DIR=/tmp/spectro-shots-home
WS=/tmp/spectro-shots-ws
PORT=8160

[ -f "$JAR" ] || { echo "no server jar at $JAR — ./gradlew :spectro-server:bootJar" >&2; exit 1; }

cleanup() { pkill -f "user.home=$HOME_DIR" 2>/dev/null || true; }
trap cleanup EXIT

build_workspace() {
  [ -f "$WS/run_checks.py" ] && return
  echo "the demo workspace is missing — see the session that created it, or rebuild $WS" >&2
  exit 1
}

start_server() {
  pkill -f "user.home=$HOME_DIR" 2>/dev/null || true
  sleep 2
  rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/.spectro"
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GEMINI_API_KEY -u OPENROUTER_API_KEY \
    SPECTRO_PROVIDER=ollama SPECTRO_MODEL="$MODEL" SPECTRO_WORKSPACE="$WS" \
    java "-Duser.home=$HOME_DIR" -jar "$JAR" --server.port=$PORT \
    >/tmp/shots-ui.log 2>&1 &
  for _ in $(seq 1 60); do
    curl -fs --max-time 2 "http://localhost:$PORT/api/config" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server never came up on :$PORT" >&2
  exit 1
}

build_workspace
for theme in dark light; do
  echo "=== $theme ==="
  start_server
  THEME=$theme BASE_URL="http://localhost:$PORT" node "$HERE/capture_chat_shots.mjs"
done
cleanup
echo "all chat plates captured"
