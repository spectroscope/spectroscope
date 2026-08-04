#!/usr/bin/env bash
# The whole tutorial capture, from a cold start to eight plates in both themes.
#
# The plates need states a used home cannot be put back into, so this stands up
# two servers on pristine homes rather than resetting one:
#
#   :8151  no bundled model, nothing configured  -> genuinely at the dark frame
#   :8150  bundled model + ollama                -> climbs, with a real run in it
#
# Each themed pass gets its own fresh pair, because the intro is asked once per
# home and `first-run-complete` can only be earned by a live run — a reset walks
# the tutorial back down but cannot un-ask the question or re-run the agent.
#
# Usage (from the repo root of spectro/):
#   docs/guide-assets/capture_leveling.sh
#
# Wants: a built spectro-server jar, ollama running with the model below.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
JAR="$ROOT/spectro-server/build/libs/spectro-server-0.3.0.jar"
MODEL="${SPECTRO_SHOT_MODEL:-qwen3.5:27b-q4_K_M}"
DARK_HOME=/tmp/spectro-shots-dark
CLIMB_HOME=/tmp/spectro-shots
DARK_PORT=8151
CLIMB_PORT=8150

[ -f "$JAR" ] || { echo "no server jar at $JAR — ./gradlew :spectro-server:bootJar" >&2; exit 1; }

pids=()
cleanup() { for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 60); do
    curl -fs --max-time 2 "http://localhost:$1/api/leveling" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server on :$1 never came up" >&2
  return 1
}

start_dark() {
  rm -rf "$DARK_HOME"; mkdir -p "$DARK_HOME/.spectro"
  # No model, no key, no SPECTRO_PROVIDER: nothing reports "ready", so the home
  # sits at the dark frame instead of leaving it before the first paint.
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GEMINI_API_KEY -u OPENROUTER_API_KEY \
    java "-Duser.home=$DARK_HOME" -jar "$JAR" --server.port=$DARK_PORT \
    >/tmp/shots-dark.log 2>&1 &
  pids+=($!)
  wait_up $DARK_PORT
}

start_climb() {
  rm -rf "$CLIMB_HOME"; mkdir -p "$CLIMB_HOME/.spectro/models"
  # The bundled model is what makes the keyless path work: it is the one local
  # thing that reports "ready", which is what settles provider-ready.
  local real
  real="$(readlink "$HOME/.spectro/models/vibethinker-3b-Q4_K_M.gguf" 2>/dev/null || true)"
  [ -n "$real" ] && ln -s "$real" "$CLIMB_HOME/.spectro/models/vibethinker-3b-Q4_K_M.gguf"
  # Env only, never a seeded settings.json: a home that already has a settings
  # file is grandfathered into checklist, and checklist locks nothing — which
  # would leave the teaser plate with nothing to photograph.
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GEMINI_API_KEY -u OPENROUTER_API_KEY \
    SPECTRO_PROVIDER=ollama SPECTRO_MODEL="$MODEL" \
    java "-Duser.home=$CLIMB_HOME" -jar "$JAR" --server.port=$CLIMB_PORT \
    >/tmp/shots-climb.log 2>&1 &
  pids+=($!)
  wait_up $CLIMB_PORT
}

stop_all() {
  pkill -f "user.home=$DARK_HOME" 2>/dev/null || true
  pkill -f "user.home=$CLIMB_HOME" 2>/dev/null || true
  sleep 2
}

for theme in dark light; do
  echo "=== $theme ==="
  stop_all
  start_dark
  start_climb
  echo "--- a real run, so the receipts point at something ---"
  BASE_URL="http://localhost:$CLIMB_PORT" node "$HERE/leveling_real_run.mjs"
  THEME=$theme MODE=fresh BASE_URL="http://localhost:$DARK_PORT" node "$HERE/capture_leveling_shots.mjs"
  THEME=$theme MODE=climb BASE_URL="http://localhost:$CLIMB_PORT" node "$HERE/capture_leveling_shots.mjs"
done
stop_all
echo "all plates captured"
