#!/usr/bin/env bash
# Scan this repo into the local SonarQube, without clicking anything.
#
#   ./ci/sonarqube/scan.sh              first run: makes a token, then scans
#   SONAR_TOKEN=squ_… ./…/scan.sh       reuse a token you already have
#
# The first-boot dance is the part the docs skip: admin/admin is forced to
# change, and a token can only be minted once you are past that. Both steps are
# done here through the API, so this file is the whole setup.
set -eu
cd "$(dirname "$0")/../.."   # the repo root

SONAR_URL=${SONAR_URL:-http://localhost:8882}
NEW_PASSWORD=${SONAR_PASSWORD:-spectro-local-dev}
PROJECT=${SONAR_PROJECT:-spectroscope}

wait_up() {
  local i
  for i in $(seq 1 80); do
    if curl -sf "$SONAR_URL/api/system/status" | grep -q '"status":"UP"'; then return 0; fi
    sleep 5
  done
  echo "sonar did not come up at $SONAR_URL" >&2; return 1
}

mint_token() {
  # admin/admin works exactly once; this changes it, then mints a token.
  curl -s -u admin:admin -X POST \
    "$SONAR_URL/api/users/change_password?login=admin&previousPassword=admin&password=$NEW_PASSWORD" \
    >/dev/null 2>&1 || true
  # A name that already exists is an error, so the old one is revoked first.
  curl -s -u "admin:$NEW_PASSWORD" -X POST \
    "$SONAR_URL/api/user_tokens/revoke?name=spectro-ci" >/dev/null 2>&1 || true
  curl -s -u "admin:$NEW_PASSWORD" -X POST \
    "$SONAR_URL/api/user_tokens/generate?name=spectro-ci" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

echo "waiting for sonar at $SONAR_URL …"
wait_up

TOKEN=${SONAR_TOKEN:-}
if [ -z "$TOKEN" ]; then
  TOKEN=$(mint_token)
  [ -n "$TOKEN" ] || { echo "could not mint a token — is the admin password already something else?" >&2; exit 1; }
  echo "token minted. To reuse it: export SONAR_TOKEN=$TOKEN"
fi

# The Java half. The Gradle plugin knows the module layout, so it needs no
# sonar.sources: it reports every subproject on its own.
echo "== java =="
./gradlew sonar \
  -Dsonar.host.url="$SONAR_URL" \
  -Dsonar.token="$TOKEN" \
  -Dsonar.projectKey="$PROJECT" \
  -Dsonar.projectName="spectroscope"

# The TypeScript half. vitest writes lcov when asked; without it Sonar reports
# 0% coverage, which is a number that reads as a finding rather than as an
# absence — so coverage is generated rather than skipped.
echo "== web =="
( cd spectro-web && npx vitest run --coverage --coverage.reporter=lcov --coverage.reporter=text-summary )
docker run --rm --network host \
  -v "$PWD/spectro-web:/usr/src" \
  sonarsource/sonar-scanner-cli:latest \
  -Dsonar.host.url="$SONAR_URL" \
  -Dsonar.token="$TOKEN" \
  -Dsonar.projectKey="$PROJECT-web" \
  -Dsonar.projectName="spectroscope-web" \
  -Dsonar.sources=src \
  -Dsonar.tests=src \
  -Dsonar.test.inclusions="**/*.test.ts,**/*.test.tsx" \
  -Dsonar.javascript.lcov.reportPaths=coverage/lcov.info

echo
echo "open $SONAR_URL — admin / $NEW_PASSWORD"
echo
echo "⚠️ Community edition analyses ONE branch. It has no PR decoration and no"
echo "   branch analysis, so this is 'what does main look like', never 'what did"
echo "   this PR change'. That is the edition's line, not a setup mistake."
