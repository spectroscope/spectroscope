#!/usr/bin/env bash
# Serve the cockpit. It has to be SERVED rather than opened as a file: a
# file:// page has an opaque origin, and the liveness probes are cross-origin
# fetches that a null origin is not allowed to make — the page would open fine
# and report every single server as down.
#
#   ./cockpit/serve.sh          serve on 8890 and open it
#   PORT=9999 ./cockpit/serve.sh
set -eu
cd "$(dirname "$0")"
PORT=${PORT:-8890}

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken — set PORT=… to pick another"; exit 1
fi

echo "cockpit on http://localhost:$PORT  (ctrl-c to stop)"
( sleep 1; open "http://localhost:$PORT" ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
