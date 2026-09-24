#!/usr/bin/env bash
# verify-build-label.sh: the staged server jar carries the build label this
# build computed (card 398), read out of the jar.
#
#   usage: scripts/verify-build-label.sh <jar> [<expected label>]
#
# The label is stamped by processResources into starter/spectro-version.properties,
# which a Spring Boot fat jar holds at BOOT-INF/classes/.
#
# With an expected label the jar must carry exactly that label, compared as one
# string. The label names the branch, the short commit and the minute
# (dd.MM. HH:mm), so a jar whose label differs in any of them fails. A jar built
# from the same branch and commit in the same minute passes.
#
# With no expected label (build-label.sh printed none) the jar must carry no
# label. Only that absence is checked, so an older jar without a label passes.
set -euo pipefail

JAR="${1:-}"
EXPECTED="${2:-}"
ENTRY="BOOT-INF/classes/starter/spectro-version.properties"

[ -n "$JAR" ] || { echo "usage: $0 <jar> [<expected label>]"; exit 2; }
[ -f "$JAR" ] || { echo "!! jar not found: $JAR"; exit 1; }

if ! STAMP="$(unzip -p "$JAR" "$ENTRY" 2>/dev/null)"; then
  echo "!! $JAR carries no $ENTRY."
  echo "!! that is not a spectro-server jar with a version stamp. refusing to package it."
  exit 1
fi
if ! grep -qE '^version=[0-9]' <<< "$STAMP"; then
  echo "!! $JAR has a stamp without a version line:"
  echo "$STAMP"
  exit 1
fi

ACTUAL="$(awk '/^label=/ { sub(/^label=/, ""); print; exit }' <<< "$STAMP")"

if [ -z "$EXPECTED" ]; then
  if [ -n "$ACTUAL" ]; then
    echo "!! this build computed no label, but the staged jar carries the label '$ACTUAL'."
    echo "!! refusing to package a label this build did not compute."
    exit 1
  fi
  echo "    the staged jar carries no label, as expected"
  exit 0
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "!! the staged jar carries the label '${ACTUAL}'"
  echo "!! this build computed           '${EXPECTED}'"
  echo "!! the staged jar was not built with this label. refusing to package it."
  exit 1
fi
echo "    the staged jar carries the label $ACTUAL"
