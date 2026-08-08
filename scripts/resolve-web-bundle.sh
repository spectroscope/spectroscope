#!/usr/bin/env bash
# Resolve a conflicted web bundle by rebuilding it (card 184).
#
# The bundle in spectro-server/src/main/resources/static is generated output
# that happens to be tracked, so a conflict there is never two authors
# disagreeing -- it is two builds of different source. Picking a side is always
# wrong: the winner's index.html lists the winner's asset hashes and silently
# drops the other branch's work.
#
# The merged source is the only thing that knows the right answer, so this
# rebuilds from it. vite.config.ts sets emptyOutDir, so the build both writes
# the correct files and removes the losing branch's stale hashed assets;
# staging the directory then clears every conflicted path at once.
#
# Run it from a conflicted merge, after any conflicts in spectro-web itself
# have been resolved:
#
#     git merge some-branch          # conflicts in static/**
#     scripts/resolve-web-bundle.sh
#     git commit
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
static="spectro-server/src/main/resources/static"
cd "$root"

# Rebuilding from a half-merged source would produce a bundle nobody wrote, so
# refuse while spectro-web still has unresolved conflicts. This is the one case
# where a human has to go first.
if git ls-files --unmerged -- spectro-web | grep -q .; then
    echo "spectro-web still has unresolved conflicts:" >&2
    git diff --name-only --diff-filter=U -- spectro-web | sed 's/^/  /' >&2
    echo >&2
    echo "resolve those first -- the bundle is built FROM them." >&2
    exit 1
fi

echo "rebuilding $static from the merged source ..."
( cd spectro-web && { [ -d node_modules ] || npm ci; } && npm run build )

git add -A -- "$static"

echo
remaining=$(git diff --name-only --diff-filter=U -- "$static" | wc -l | tr -d ' ')
if [ "$remaining" != "0" ]; then
    echo "still conflicted (unexpected):" >&2
    git diff --name-only --diff-filter=U -- "$static" | sed 's/^/  /' >&2
    exit 1
fi
echo "bundle resolved and staged. it matches spectro-web, and carries both"
echo "branches' changes -- which is the thing picking a side cannot do."
