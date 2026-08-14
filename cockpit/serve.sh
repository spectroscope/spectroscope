#!/usr/bin/env bash
# Serve the cockpit, in the foreground. The page cannot be opened as a file:
# it reads /api/estate from its own origin, and that origin is serve.py —
# the small stdlib server that gathers what runs on this machine.
#
#   ./cockpit/serve.sh          serve on 8890 and open it
#   PORT=9999 ./cockpit/serve.sh
#
# ./spectro-cockpit (repository root) is the background way in: start, stop,
# status, logs. This script stays for a terminal you want to hold open.
set -eu
cd "$(dirname "$0")"
export PORT=${PORT:-8890}

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken — set PORT=… to pick another"; exit 1
fi

( sleep 1; open "http://localhost:$PORT" ) &
exec python3 serve.py
