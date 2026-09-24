#!/usr/bin/env bash
# build-label.sh: print the label a test build carries, or nothing for a release
# build (card 398).
#
#   usage: scripts/build-label.sh
#
# A test build prints one line:
#
#   <next minor>.0-beta (<branch or "detached">, <short commit>, <dd.MM. HH:mm>)
#   0.13.0-beta (merge-2026-09-24, a1b2c3d, 24.09. 14:05)
#
# The next minor comes from the version spectro-server/build.gradle.kts
# declares (0.12.0 gives 0.13.0). The time is the local time of the build.
#
# A release build prints nothing. A build is a release build when
#   - SPECTRO_RELEASE=1 is set (build-release-assets.sh sets it), or
#   - HEAD carries the tag v<version> for the version the tree declares.
# It prints nothing as well when git is not on the PATH, or when git cannot read
# a checkout here; the second case passes on git's own error text.
# The reason goes to stderr in every case; stdout carries the label and nothing
# else.
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # spectroscope-harness/spectro
cd "$HARNESS"

VERSION="$(sed -nE 's/^version = "([^"]+)".*/\1/p' spectro-server/build.gradle.kts | head -1)"
if ! [[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "!! build-label: spectro-server/build.gradle.kts declares '${VERSION}', not a plain X.Y.Z" >&2
  exit 1
fi
NEXT="${BASH_REMATCH[1]}.$((10#${BASH_REMATCH[2]} + 1)).0"

if [ "${SPECTRO_RELEASE:-}" = "1" ]; then
  echo "build-label: SPECTRO_RELEASE=1, a release build carries no label" >&2
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "build-label: git not found on the PATH, so the build carries no label" >&2
  exit 0
fi
if ! GIT_ERR="$(git rev-parse --is-inside-work-tree 2>&1 >/dev/null)"; then
  echo "build-label: git cannot read a checkout here, so the build carries no label. git says: ${GIT_ERR}" >&2
  exit 0
fi

# Captured first and matched without a pipe: grep -q in a pipe can exit before
# git has written everything, and under pipefail git's SIGPIPE would turn a
# match into a miss.
TAGS="$(git tag --points-at HEAD)"
if grep -qxF "v${VERSION}" <<< "$TAGS"; then
  echo "build-label: HEAD is tag v${VERSION}, a release build carries no label" >&2
  exit 0
fi

BRANCH="$(git symbolic-ref --quiet --short HEAD || echo detached)"
COMMIT="$(git rev-parse --short HEAD)"
WHEN="$(date +'%d.%m. %H:%M')"
echo "build-label: test build on ${BRANCH} at ${COMMIT}" >&2
printf '%s-beta (%s, %s, %s)\n' "$NEXT" "$BRANCH" "$COMMIT" "$WHEN"
