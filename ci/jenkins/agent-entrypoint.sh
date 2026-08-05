#!/usr/bin/env bash
# The agent fetches its own secret, then becomes the normal agent.
#
# Jenkins DERIVES a node's secret from its name and the controller's instance
# identity, so it cannot be declared in JCasC — the first version of this stack
# tried and the controller refused to boot with
# "Invalid configuration elements ... : agentSecret". The controller does serve
# it, though, on the node's own JNLP descriptor, and that is what makes an
# unattended attach possible.
set -eu

: "${JENKINS_URL:?}" "${JENKINS_AGENT_NAME:?}" "${JENKINS_ADMIN_ID:?}" "${JENKINS_ADMIN_PASSWORD:?}"

echo "waiting for $JENKINS_URL …"
for i in $(seq 1 120); do
  if curl -fsS -o /dev/null "$JENKINS_URL/login"; then break; fi
  sleep 2
done

# The node has to exist before it has a secret; JCasC creates it during boot, so
# a fast agent can arrive first.
echo "asking for ${JENKINS_AGENT_NAME}'s secret …"
SECRET=""
for i in $(seq 1 60); do
  SECRET=$(curl -fsS -u "$JENKINS_ADMIN_ID:$JENKINS_ADMIN_PASSWORD" \
    "$JENKINS_URL/computer/$JENKINS_AGENT_NAME/jenkins-agent.jnlp" 2>/dev/null \
    | sed -n 's/.*<argument>\([a-f0-9]\{64\}\)<\/argument>.*/\1/p' | head -1) || true
  [ -n "$SECRET" ] && break
  sleep 2
done

if [ -z "$SECRET" ]; then
  echo "could not read the agent secret — is the node '$JENKINS_AGENT_NAME' declared in casc/jenkins.yaml?" >&2
  exit 1
fi
echo "got it (${#SECRET} chars). connecting."

# The stock image's entrypoint takes it from here.
exec /usr/local/bin/jenkins-agent -url "$JENKINS_URL" "$SECRET" "$JENKINS_AGENT_NAME"
