#!/usr/bin/env bash
# Concourse's three keypairs, generated once.
#
# Without them the web node exits with a message about a missing session signing
# key that does not tell you to run this. The keys are the cluster's identity:
#
#   session_signing_key   signs the tokens the web node issues
#   tsa_host_key          the worker gateway's host key, like an ssh server's
#   worker_key            the worker's own key; its PUBLIC half must sit in the
#                         web node's authorized_worker_keys or the worker is
#                         refused and simply never appears
#
# `concourse generate-key` inside the image is used rather than ssh-keygen,
# because Concourse wants a specific format and the ssh-keygen recipes on the
# internet produce keys that are quietly rejected.
set -eu
cd "$(dirname "$0")"

if [ -f keys/web/session_signing_key ] && [ -f keys/worker/worker_key ]; then
  exit 0 # already generated; regenerating would orphan the running worker
fi

echo "generating Concourse's three keypairs …"
mkdir -p keys/web keys/worker

gen() { # type out-path
  docker run --rm -v "$PWD/keys:/keys" concourse/concourse:8.2.5 \
    generate-key -t "$1" -f "/keys/$2"
}

gen rsa    web/session_signing_key
gen ssh    web/tsa_host_key
gen ssh    worker/worker_key

# The worker's public key is what the web node checks; the worker needs the web
# node's public host key to know it is talking to the right gateway.
cp keys/worker/worker_key.pub keys/web/authorized_worker_keys
cp keys/web/tsa_host_key.pub  keys/worker/tsa_host_key.pub

echo "keys are in ci/concourse/keys — gitignored, and regenerating them means"
echo "every existing worker has to be recreated."
