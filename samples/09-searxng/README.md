# 09 — search variant: SearXNG

No Java code lives here on purpose. `web_search` already speaks to a SearXNG
instance; what this directory adds is the other half — a SearXNG to point at.

## Why a directory and not a docker line

Stock SearXNG does not answer an API client. Its shipped `settings.yml` lists

```yaml
search:
  formats:
    - html
```

and a request for a format that is not on that list is answered **HTTP 403**.
So `docker run searxng/searxng` gives you a perfectly good search page in a
browser and an API that hands spectroscope nothing back. Every "just run this
one line" writeup of SearXNG-as-an-API is describing an instance whose owner
edited that file at some point and forgot.

The settings file below is the entire difference, and a generated secret key is
the other half — SearXNG refuses to start on the placeholder it ships with.

## Run it

```bash
cd samples/09-searxng
./install.sh
```

That writes `./searxng/settings.yml` (mode 0600) with a secret key generated on
your machine and `json` added to `search.formats`, starts one container, and
then waits for a **real** `format=json` query to come back with a results array
— not for the port to open. A container that booted with the format off answers
instantly, with 403, and a check that only asked "is it up" would call that a
success and write a dead address into a credentials file.

Once the query answers, it writes

```
SPECTRO_SEARXNG_URL=http://localhost:8888
```

into `~/.spectro/.env` (also 0600). That file is part of the environment layer
of the settings hierarchy, read on every resolve — so `spectro doctor`, the next
session and the tier line in **Settings › Web search** name this instance
without a restart and without an export. Typing the same address into the
Settings field also works and outranks the file, because a settings document
outranks the environment layer under it.

`SEARXNG_PORT=9999 ./install.sh` moves the port. `./install.sh --configure-only`
writes the settings file and starts nothing.

## What it is not

Not a public instance, and not a recommendation to use one. Measured
2026-08-12: of 75 healthy public SearXNG instances, exactly **one** answered
`application/json`. Instance operators leave the format off deliberately —
JSON is a far cheaper way to scrape an instance at scale than rendering HTML.
The field in Settings is for an instance **you** run, and that is why this
directory exists.

## What spectroscope sends

A real `User-Agent` and browser-shaped `Accept`, `Accept-Language` and
`Accept-Encoding` headers, because SearXNG's bot detection blocks clients that
send neither. Its shipped regex matches the bare word `Java`, and Spring's
default User-Agent is literally `Java/<version>`; its `Accept-Encoding` check
refuses a request that names neither gzip nor deflate. This instance runs with
`limiter: false` — private, one reader — but the client is shaped to pass the
wall either way, so turning it on later breaks nothing.

## Stop it

```bash
docker compose --project-directory . down
```

`./searxng/settings.yml` survives that, so starting again reuses the same
instance identity. Delete the directory to start over.
