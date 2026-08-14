#!/usr/bin/env bash
# verify-staged-server-jar.sh — THE STAGED JAR IS BUILT FROM THIS TREE,
# asserted, not assumed.
#
#   usage: scripts/verify-staged-server-jar.sh <staged-jar>
#
# The desktop run kits copy a server fat jar to the version-neutral path the
# Electron shell's extraResources points at (spectro-desktop/build/
# spectro-server.jar). Everything downstream trusts that copy blindly:
# electron-builder packs it, codesign signs it, notarization blesses it.
# Nothing between the copy and the .dmg ever asks whether the jar matches the
# tree it is packaged from — and the Linux kit's SKIP_BOOTJAR path never
# builds it at all, it takes whatever is lying there. That is the same
# accident class as the v0.7.0 Electron runtime (see build-desktop-runkit.sh
# step 4b): a stale artifact goes green, gets sealed, and ships an old UI
# nobody chose.
#
# The check mirrors step 4b's lock read-back, and it follows the house rule
# for bundle identity: read the hash OUT OF the artifact, never off a build
# log. The web bundle's content-hashed asset names (assets/index-<hash>.js)
# are read from the index.html INSIDE the staged jar and compared against the
# tree's own copy under spectro-server/src/main/resources/static/. Any
# difference — stale jar, foreign jar, a jar with no web face at all — is a
# loud refusal before a byte is packaged.
#
# Review 2026-08-14, finding 20 (konzept/CODE-REVIEW-2026-08-14.md): the
# electron runtime had a read-back guard, the server jar had none.
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # spectroscope-harness/spectro
TREE_INDEX="$HARNESS/spectro-server/src/main/resources/static/index.html"

STAGED="${1:-}"
[ -n "$STAGED" ] || { echo "usage: $0 <staged-server-jar>"; exit 2; }
[ -f "$STAGED" ] || { echo "!! staged server jar not found: $STAGED"; exit 1; }
[ -f "$TREE_INDEX" ] || { echo "!! tree bundle index not found: $TREE_INDEX"; exit 1; }

# The content-hashed asset references are the bundle's identity; sorted so the
# comparison is order-independent, one per line so a mismatch names itself.
bundle_refs() {
  grep -oE 'assets/index-[A-Za-z0-9_-]+\.(js|css)' | sort -u
}

TREE_BUNDLE="$(bundle_refs < "$TREE_INDEX" || true)"
JAR_BUNDLE="$(unzip -p "$STAGED" BOOT-INF/classes/static/index.html 2>/dev/null | bundle_refs || true)"

[ -n "$TREE_BUNDLE" ] || { echo "!! no hashed bundle refs in $TREE_INDEX — the guard's extraction went stale, fix it here"; exit 1; }
if [ -z "$JAR_BUNDLE" ]; then
  echo "!! $STAGED carries no web bundle index (BOOT-INF/classes/static/index.html)."
  echo "!! that is not a spectro-server fat jar built from this tree. refusing to package it."
  exit 1
fi

if [ "$JAR_BUNDLE" != "$TREE_BUNDLE" ]; then
  echo "!! the staged server jar's web bundle does not match this tree:"
  echo "!!   staged jar: $(echo "$JAR_BUNDLE" | tr '\n' ' ')"
  echo "!!   this tree:  $(echo "$TREE_BUNDLE" | tr '\n' ' ')"
  echo "!! a stale staged jar ships an old UI under a fresh version — the server-jar"
  echo "!! twin of the v0.7.0 Electron accident. rebuild it (or drop SKIP_BOOTJAR)."
  exit 1
fi
echo "    staged jar bundle matches the tree: $(echo "$JAR_BUNDLE" | tr '\n' ' ')"
