# 06 — endpoint variant: Langfuse

No Java code lives here on purpose. Sample 05's embedded main, and the CLI's
zero-code path, are endpoint-agnostic: the exporter speaks OTLP/HTTP and
Langfuse ingests exactly that. Only the endpoint and the auth differ.

Langfuse has no Java SDK; its documented JVM path is this OTLP endpoint, so the
built-in exporter is the first-class way to see spectroscope runs in Langfuse,
with no bridge process in between.

What this directory adds is the other half: a Langfuse to point at.

## Run it

```bash
cd samples/06-langfuse
./install.sh
```

That generates every secret on your machine, writes them to `./.env` (mode
0600), creates the org, project, API key pair and first user without a signup
form, starts six containers, and waits for the health endpoint. It then writes

```
SPECTRO_OTLP_ENDPOINT=http://localhost:3000/api/public/otel
SPECTRO_OTLP_BASIC_AUTH=pk-lf-...:sk-lf-...
```

into `~/.spectro/.env` (also 0600) and tells you to restart. Restarting is not
optional: a running JVM cannot re-read its own environment, and that file is
read when the configuration loads.

Re-running is safe. An existing `./.env` is reused as is and never rotated,
because the postgres password is baked into the volume on first boot; a fresh
password on a second run would lock the stack out of its own database. To start
over, `docker compose down -v` and delete `./.env` together.

The one thing a re-run will not do is quietly change a port. `docker compose`
reads your shell environment before `--env-file`, so a `LANGFUSE_PORT` that
disagrees with the reused `./.env` would move the containers while the endpoint
written into `~/.spectro/.env` still named the old port. The installer stops and
says so instead. To change a port, edit `./.env`, or take the stack down with
`-v` and start over.

**spectroscope never runs this for you.** The Settings page can show you the
command once it sees a Docker daemon, and that is where it stops. A process that
can reach the Docker socket can bind-mount any host path into a container, which
is read and write access to the whole disk. That is not a power the app takes.

### Options

| variable | default | what it does |
|---|---|---|
| `LANGFUSE_PORT` | 3000 | host port for the web UI |
| `MINIO_PORT` | 9090 | host port for object storage |
| `COMPOSE_PROJECT_NAME` | `langfuse-spectro` | compose project, so a second stack can run beside a first |
| `LANGFUSE_ADMIN_EMAIL` | `admin@spectroscope.local` | the first user's login; the domain must contain a dot, or langfuse-web refuses to boot (the installer checks and stops) |
| `LANGFUSE_TELEMETRY_ENABLED` | `false` | Langfuse's own usage reporting, off by default here |

`./install.sh --configure-only` does the configure and hand-over halves and
touches no container. That is also how the test suite verifies it.

## What the shipped compose file changes

It is upstream's stack with four deliberate differences, each one a bug we hit
rather than a preference. `LangfuseComposeDriftTest` asserts all four, so they
cannot quietly regress.

1. **Every secret is required** (`${VAR:?...}`). Upstream ships `${VAR:-example}`
   defaults, so a missing value boots a stack whose password is published in its
   own documentation.
2. **`DATABASE_URL` interpolates `POSTGRES_PASSWORD`.** Upstream hard-codes a
   default password inside that URL, so setting only `POSTGRES_PASSWORD`
   crash-loops langfuse-web on Prisma `P1000` while every other service looks
   healthy.
3. **One MinIO user and one MinIO password feed all three `LANGFUSE_S3_*`
   blocks.** Splitting them makes OTLP ingestion fail with "Failed to upload
   JSON to S3" while the health probe and the doctor line both stay green,
   because an empty probe batch never touches S3.
4. **Only two host ports are published, both configurable.** Postgres,
   ClickHouse and Redis are reachable inside the compose network and nowhere
   else.

Images are pinned by digest. `langfuse/langfuse:3` is a floating major, and
"the version that worked yesterday" is not a version.

Pinned 2026-08-02 against **Langfuse 3.224.1** (`GET /api/public/health`),
`linux/arm64`. The digests are listed in the header of `docker-compose.yml`.

## Read-back check

Langfuse's public API confirms the ingest server-side, with the same key pair
the installer generated:

```bash
PK=$(sed -n 's/^LANGFUSE_INIT_PROJECT_PUBLIC_KEY=//p' .env)
SK=$(sed -n 's/^LANGFUSE_INIT_PROJECT_SECRET_KEY=//p' .env)
curl -s -u "$PK:$SK" "http://localhost:3000/api/public/traces?limit=3"
```

This read-back is worth doing once. The doctor probe sends an empty batch, which
never touches object storage, so it can pass on a stack whose ingestion is
broken. A trace you can fetch back cannot.

In Langfuse a run appears as one trace: the session as the root agent
observation, each turn as a generation with token usage, each tool call as a
tool observation, gate decisions as spans. The session id rides along as
`langfuse.session.id`, so all runs of one session group under Sessions.

## Keys stay out of files that are not for keys

The `pk:sk` pair is a credential. The installer puts it in `~/.spectro/.env`
(0600) and nowhere else. It does not go into `~/.spectro/settings.json`: that
document is read back by the settings API and dumped by the layers view, which
is not where a credential belongs. Typing a pair into the Settings UI field does
write it there, so prefer the installer's path. Merely opening that field does
not: it is prefilled with the resolved value, and a blur that changed nothing
sends nothing, because a write there would also outrank the file it was read
from and pin a key the next `./install.sh` could no longer rotate.

`.env` is covered by the repository's `.gitignore`. Never commit either file.

## Pointing at Langfuse Cloud instead

Nothing here is required. For Langfuse Cloud, skip the installer and set the two
variables by hand against `https://cloud.langfuse.com/api/public/otel`, with a
project key pair from the Cloud project settings.
