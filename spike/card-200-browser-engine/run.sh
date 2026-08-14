#!/usr/bin/env bash
# Runs the card 200 spike on the Electron the desktop app already ships.
# No install: it borrows spectro-desktop/node_modules/.bin/electron on purpose,
# because "costs no new download" is one of the claims under test.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# This checkout first; a worktree has no node_modules of its own, so fall back
# to the main checkout's install rather than making the spike need one.
candidates=(
  "$here/../../spectro-desktop/node_modules/.bin/electron"
  "${SPECTRO_ELECTRON:-}"
  "$HOME/Spectroscope/spectroscope-harness/spectro/spectro-desktop/node_modules/.bin/electron"
)
electron=""
for c in "${candidates[@]}"; do
  if [ -n "$c" ] && [ -x "$c" ]; then electron="$c"; break; fi
done
if [ -z "$electron" ]; then
  echo "electron not found — run npm install in spectro-desktop, or set SPECTRO_ELECTRON" >&2
  exit 127
fi
echo "using electron: $electron"
exec "$electron" "$here" "$@"
