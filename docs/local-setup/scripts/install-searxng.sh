#!/usr/bin/env bash
#
# Starts a SearXNG instance next to this script that ANSWERS JSON, then hands
# its address to spectroscope.
#
# It does exactly three things, in this order:
#   1. configure  write ./searxng/settings.yml with a secret key generated on
#                 this machine and the json output format switched ON
#   2. start      docker compose up -d
#   3. hand over  write SPECTRO_SEARXNG_URL into ~/.spectro/.env (0600), but
#                 only after a real format=json query has come back with results
#
# It runs on its own. The app serves this file at
# /local-setup/scripts/install-searxng.sh, and when no docker-compose.yml is
# beside it, step 1 first writes the pinned one it carries (the same bytes as
# samples/09-searxng/docker-compose.yml). A compose file already there is kept
# only when it runs one image, SearXNG pinned by digest, as the one this script
# writes does. Any other compose file belongs to another stack, and the script
# stops instead of starting it.
#
# Why a script and not a docker line: stock SearXNG lists only `html` under
# `search.formats`, and asks for an unlisted format are answered 403. A bare
# `docker run searxng/searxng` therefore gives a browsable search page and an
# API that answers nothing; web_search falls back to reading that page (card
# 448), whose markup changes between SearXNG releases. The settings file below
# turns the API on, and generating a secret key per machine is the other half.
#
# Nothing in spectroscope runs this for you. The app prints the command; you
# read it and start the container.
#
# Re-running is safe. An existing ./searxng/settings.yml is reused as is: its
# secret key is this instance's identity, and rotating it on a second run would
# invalidate every preferences cookie the instance has handed out. A compose
# file an older copy of this script wrote is kept, and the script says when it
# pins another digest than this one; delete it and run again to take this pin.
#
# Usage, with the name this file has on your disk:
#   bash <this file>
#       configure, start, hand over
#   bash <this file> --configure-only
#       write the compose and settings files, touch no container
#   bash <this file> --help
#
# Environment:
#   SEARXNG_PORT        host port           (default 8888)
#   SEARXNG_CONTAINER   container name      (default spectro-searxng)
#
# Every file it writes, docker-compose.yml and ./searxng/settings.yml, lands in
# the folder this script is in, whatever folder you run it from. Give it a
# folder of its own, for example ~/spectro-searxng.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
me="$(basename "${BASH_SOURCE[0]}")"
compose_file="$here/docker-compose.yml"
# The image the compose file below pins. A docker-compose.yml found beside this
# script is used only when this repository, pinned by some digest, is the one
# image it runs.
searxng_image="docker.io/searxng/searxng@sha256:c2dc2d9e6b910653e8628361c23443222490e4cabbb9e02667b7847143db843b"
searxng_repo="${searxng_image%@*}"
state_dir="$here"
settings_dir="$state_dir/searxng"
settings_file="$settings_dir/settings.yml"

configure_only=0
case "${1:-}" in
    --configure-only) configure_only=1 ;;
    --help|-h) sed -n '3,/^$/p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//' -e "s|<this file>|$me|g"; exit 0 ;;
    "") ;;
    *) echo "$me: unknown argument \"$1\" (try --help)" >&2; exit 2 ;;
esac

die() { echo "$me: $*" >&2; exit 1; }

if [ -f "$compose_file" ]; then
    # A file this script wrote gives compose exactly one thing to run: the
    # SearXNG image, pinned by digest, on an image line of its own. A comment
    # that names the image does not count, and neither does a file with a
    # second image, a build, an extends or an include.
    sources="$(grep -cE '^[[:space:]]*(image|build|extends|include):' "$compose_file" || true)"
    found="$(sed -nE "s|^[[:space:]]*image:[[:space:]]*[\"']?(${searxng_repo//./\\.}@sha256:[0-9a-f]{64})[\"']?[[:space:]]*\$|\1|p" "$compose_file")"
    if [ "$sources" != 1 ] || [ -z "$found" ]; then
        die "$compose_file belongs to another stack.
The compose file this script writes runs one image, $searxng_repo
pinned by digest, and this one does not, so this script does not start it.
Put the script in a folder of its own, for example ~/spectro-searxng, and run
it there."
    fi
    if [ "$found" = "$searxng_image" ]; then
        echo "keeping existing $compose_file"
    else
        echo "keeping existing $compose_file (it pins ${found##*@}, this script pins ${searxng_image##*@}; delete the file and run again to take this script's pin)"
    fi
else
    echo "writing $compose_file (none was beside this script)"
    [ -w "$here" ] || die "cannot write $compose_file; move this script to a folder you can write to"
    cat > "$compose_file" <<'COMPOSE'
# The SearXNG instance spectroscope's web_search tier talks to, shipped so that
# a first boot answers JSON without editing anything.
#
# Stock SearXNG does NOT answer an API client. Its shipped settings.yml lists
# only `html` under `search.formats`, and a request for an unlisted format is
# answered 403, so a bare `docker run searxng/searxng` gives a perfectly good
# search page and an API that answers nothing. web_search then reads that
# search page instead (card 448), but the page's markup changes between SearXNG
# releases and the API's fields do not. That is the reason this directory
# exists instead of a one-line command in the settings page: the install script
# beside it writes a settings.yml that turns `json` on (and generates this
# machine's own secret key), and THIS file mounts it.
#
# Four deliberate choices, each one a thing that bites otherwise:
#
#   1. settings.yml is a bind mount of ./searxng, written by the install
#      script. The image generates its own settings.yml when that directory is empty, and
#      the generated one has json off, which is the state we are here to leave.
#   2. One published port, configurable. Nothing else is on the host.
#   3. `cap_drop: ALL` plus the two capabilities the image's own entrypoint
#      needs to drop privileges. A metasearch proxy is a thing that fetches
#      attacker-influenced URLs for a living.
#   4. The image is pinned by DIGEST. searxng/searxng:latest is a rolling tag
#      that moves several times a week, and "the version that worked yesterday"
#      is not a version.
#
#   pinned 2026-08-13, linux/arm64, SearXNG 2026.8.12-cdfdaa5a8
#   searxng/searxng:latest -> c2dc2d9e
#
# Run the install script beside this file first (install-searxng.sh when the
# app served it); it writes the settings this file mounts.

services:
  searxng:
    image: docker.io/searxng/searxng@sha256:c2dc2d9e6b910653e8628361c23443222490e4cabbb9e02667b7847143db843b
    container_name: ${SEARXNG_CONTAINER:-spectro-searxng}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${SEARXNG_PORT:?set SEARXNG_PORT, or run the install script beside this file}:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    environment:
      # The instance's own idea of where it lives. It goes into the HTML pages
      # SearXNG renders; the JSON this product reads does not depend on it.
      SEARXNG_BASE_URL: http://localhost:${SEARXNG_PORT}/
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID
      - SETUID
    logging:
      driver: json-file
      options:
        max-size: "1m"
        max-file: "1"
COMPOSE
fi
command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the instance secret"

SEARXNG_PORT="${SEARXNG_PORT:-8888}"
export SEARXNG_PORT
export SEARXNG_CONTAINER="${SEARXNG_CONTAINER:-spectro-searxng}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-searxng-spectro}"

# ---------------------------------------------------------------- 1. configure

if [ -f "$settings_file" ]; then
    echo "reusing the existing $settings_file (the secret key is never rotated on a re-run)"
    # A settings file from before this script, or hand-edited since, is exactly
    # the case that ends as "why does spectroscope say 403". Say it here.
    grep -qE '^[[:space:]]*-[[:space:]]*json[[:space:]]*$' "$settings_file" || die \
        "$settings_file exists but does not list \"json\" under search.formats.
That is the one setting this whole directory is about: SearXNG answers 403 to
format=json until it is there. Add it, or delete the file and run again."
else
    echo "writing $settings_file"
    mkdir -p "$settings_dir"
    umask 077
    cat > "$settings_file" <<EOF
# Generated by $me on $(date -u +%Y-%m-%dT%H:%M:%SZ). The secret key below
# was created on this machine and is not shared with any other installation.
#
# use_default_settings keeps every upstream default and overrides only what is
# written here, so a SearXNG upgrade brings its new engines along.
use_default_settings: true

server:
  # SearXNG refuses to start on the shipped placeholder.
  secret_key: "$(openssl rand -hex 32)"
  # The bot wall, off on purpose for an instance that only you and one local
  # program reach. spectroscope sends a real User-Agent and browser-shaped
  # Accept headers either way, so turning this on later does not break it,
  # but off is the honest default for a private instance and one less thing
  # between a paste and a working search.
  limiter: false
  public_instance: false

search:
  # THE reason this file exists. Stock SearXNG ships this list with html and
  # nothing else, and answers HTTP 403 to every request for a format that is
  # not on it, which is every request an API client makes.
  formats:
    - html
    - json
EOF
fi
chmod 600 "$settings_file"

if [ "$configure_only" -eq 1 ]; then
    echo
    echo "configure only: no container was started."
    exit 0
fi

# -------------------------------------------------------------------- 2. start

case "${DOCKER_HOST:-}" in
    tcp://*|ssh://*)
        die "DOCKER_HOST points at a remote daemon (${DOCKER_HOST%%:*}://...); this instance is meant to run on this machine, and the address handed to spectroscope below is localhost" ;;
esac
docker compose version >/dev/null 2>&1 \
    || die "docker compose is not available (install Docker Desktop, or the compose CLI plugin)"

echo
echo "starting one container as project \"$COMPOSE_PROJECT_NAME\" on port $SEARXNG_PORT"
docker compose -f "$compose_file" --project-directory "$state_dir" up -d

# ---------------------------------------------------------------- 3. hand over

url="http://localhost:$SEARXNG_PORT"

# The wait is for the ANSWER SHAPE, not for the port. A container that has
# booted with json off answers this URL instantly, with 403, and a check that
# only asked "is it up" would call that a success and write a dead address into
# a 0600 file. So the probe is a real format=json query, and it has to come back
# as JSON carrying a results array.
echo -n "waiting for $url/search?format=json "
answered=0
for _ in $(seq 1 60); do
    body="$(curl -fsS -H 'User-Agent: Mozilla/5.0 (compatible; spectro-web-search)' \
        -H 'Accept: application/json' -H 'Accept-Encoding: gzip, deflate' --compressed \
        "$url/search?q=spectroscope&format=json" 2>/dev/null || true)"
    case "$body" in
        *'"results"'*) answered=1; break ;;
    esac
    echo -n "."
    sleep 2
done
echo

[ "$answered" -eq 1 ] || die "the instance at $url did not answer format=json within two minutes.
Look at: docker compose -f \"$compose_file\" --project-directory \"$state_dir\" logs searxng
A 403 there means settings.yml lost its \"json\" line; anything else means the
container is not up yet."

spectro_env="${HOME}/.spectro/.env"
mkdir -p "$(dirname "$spectro_env")"
touch "$spectro_env"
chmod 600 "$spectro_env"

# Upsert, so a second run replaces the line instead of appending it again.
tmp="$(mktemp "${spectro_env}.XXXXXX")"
chmod 600 "$tmp"
grep -v -E '^SPECTRO_SEARXNG_URL=' "$spectro_env" > "$tmp" || true
echo "SPECTRO_SEARXNG_URL=$url" >> "$tmp"
mv "$tmp" "$spectro_env"
chmod 600 "$spectro_env"

echo "searxng is up and answering JSON: $url"
echo "wrote SPECTRO_SEARXNG_URL=$url to $spectro_env"
echo
echo "spectroscope reads that file every time it resolves its settings, so the"
echo "next run, the next session and Settings > Web search all name this"
echo "instance, no restart, no export. Anything already running that resolved"
echo "its configuration earlier keeps the old tier until it resolves again;"
echo "restart it if 'spectro doctor' names this instance and it does not."
