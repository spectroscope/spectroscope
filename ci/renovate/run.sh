#!/usr/bin/env bash
# See what an updater WOULD do, without it doing anything.
#
#   ./ci/renovate/run.sh                 dry run against the GitHub repo
#   RENOVATE_DRY_RUN= ./ci/renovate/run.sh   let it actually open PRs
#
# Needs a GitHub token with repo scope in GITHUB_TOKEN. `gh auth token` prints
# one if you are already logged in, which you are.
set -eu
cd "$(dirname "$0")"

TOKEN=${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}
if [ -z "$TOKEN" ]; then
  echo "no GITHUB_TOKEN and gh is not logged in." >&2
  exit 1
fi

MODE=${RENOVATE_DRY_RUN-full}
if [ -n "$MODE" ]; then
  echo "DRY RUN — nothing will be created. Unset RENOVATE_DRY_RUN to act."
else
  echo "⚠️ LIVE — this will open pull requests on spectroscope/spectroscope."
  printf 'type yes to continue: '; read -r a; [ "$a" = "yes" ] || exit 1
fi

GITHUB_TOKEN="$TOKEN" RENOVATE_DRY_RUN="$MODE" docker compose run --rm renovate
