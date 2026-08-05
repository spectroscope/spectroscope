#!/usr/bin/env bash
# Build a CycloneDX SBOM for both halves of this repo and upload it.
#
#   ./ci/dependency-track/upload-sbom.sh
#
# The Gradle half needs the cyclonedx plugin, and it is deliberately NOT added to
# the repo's build files by this script: a CI experiment must not change the
# thing it measures. The plugin block to paste is printed at the end, and the
# npm half works with no repo change at all.
set -eu
cd "$(dirname "$0")/../.."

DT_URL=${DT_URL:-http://localhost:8884}
PROJECT_NAME=${DT_PROJECT:-spectroscope}
VERSION=${DT_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}

# The API key. Dependency-Track ships a default admin/admin that must be changed;
# everything after that is one API call.
key() {
  local pw=${DT_PASSWORD:-spectro-local-dev}
  curl -s -X POST "$DT_URL/api/v1/user/forceChangePassword" \
    --data-urlencode "username=admin" --data-urlencode "password=admin" \
    --data-urlencode "newPassword=$pw" --data-urlencode "confirmPassword=$pw" >/dev/null 2>&1 || true
  local jwt
  jwt=$(curl -s -X POST "$DT_URL/api/v1/user/login" \
        --data-urlencode "username=admin" --data-urlencode "password=$pw")
  [ -n "$jwt" ] || { echo "could not log in to Dependency-Track" >&2; return 1; }
  # The Automation team exists out of the box and its key is what a CI run uses.
  curl -s -H "Authorization: Bearer $jwt" "$DT_URL/api/v1/team" \
    | sed -n 's/.*"apiKeys":\[{"key":"\([^"]*\)".*/\1/p' | head -1
}

API_KEY=${DT_API_KEY:-$(key)}
[ -n "$API_KEY" ] || { echo "no API key — is the server up at $DT_URL?" >&2; exit 1; }

upload() { # name sbom-file
  echo "uploading $2 as $1 / $VERSION"
  curl -s -X POST "$DT_URL/api/v1/bom" \
    -H "X-Api-Key: $API_KEY" \
    -F "autoCreate=true" \
    -F "projectName=$1" \
    -F "projectVersion=$VERSION" \
    -F "bom=@$2" | head -c 200
  echo
}

# --- the npm half: no repo change needed --------------------------------------
echo "== spectro-web =="
( cd spectro-web && npx --yes @cyclonedx/cyclonedx-npm --output-file /tmp/sbom-web.json --omit dev )
upload "$PROJECT_NAME-web" /tmp/sbom-web.json

# --- the Gradle half ----------------------------------------------------------
if ./gradlew tasks --all 2>/dev/null | grep -q cyclonedxBom; then
  echo "== gradle =="
  ./gradlew cyclonedxBom
  # The aggregate lands in the root build dir for a multi-module build.
  SBOM=$(ls build/reports/bom.json build/reports/application.cdx.json 2>/dev/null | head -1 || true)
  [ -n "$SBOM" ] && upload "$PROJECT_NAME" "$SBOM" || echo "no aggregated bom.json found"
else
  cat <<'NOTE'

The Gradle side needs the CycloneDX plugin, and this script does not add it —
a CI experiment must not modify the build it is measuring. To turn it on, in the
ROOT build.gradle.kts:

    plugins {
        id("org.cyclonedx.bom") version "2.3.1"
    }
    tasks.cyclonedxBom {
        includeConfigs.set(listOf("runtimeClasspath"))
        projectType.set("application")
        destination.set(file("build/reports"))
    }

then run this script again. Until then only the npm half is uploaded, which is
honest: the report says what it read.
NOTE
fi

echo
echo "open $DT_URL (frontend on http://localhost:8883) — admin / ${DT_PASSWORD:-spectro-local-dev}"
