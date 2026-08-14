# The cockpit — the estate overview

One page that answers "what is running on this machine, and how is it doing".
It draws every running thing as one spectral line — the product's own metaphor,
a spectroscope splitting light into the lines it is made of — and says the same
facts plainly in tables underneath.

```bash
./spectro-cockpit start      # from the repository root: serve + open, background
./spectro-cockpit status     # is it answering
./spectro-cockpit stop
./cockpit/serve.sh           # the foreground way, for a terminal you hold open
```

## What it shows

| section | the facts, and where they come from |
|---|---|
| **spectro servers** | every listening java port that answers `/api/health` with the health shape; per server the HTTP port, pid, backend (`/api/config`), and fleet state (`/api/fleet`): hub port and nodes with connected/gone |
| **the build lab** | every stack in `./spectro-env`'s own registry — the script is parsed at runtime, so this list cannot drift — with container count, port, and the same state words `./spectro-env status` prints |
| **launch configs** | the nearest `.claude/launch.json` above the repository; per config the declared port and whether that port is held right now, and by which command |
| **ports claimed twice** | every port that two different things claim — a launch config and a fleet hub wanting the same number is drawn, not discovered at bind time |

## The rules it keeps

- **Honest states.** A thing that does not answer is drawn as not answering,
  never omitted. Docker down reads "docker not answering", not "every stack is
  down" — the difference between a fact and a guess.
- **Read-only first, buttons only where a script exists.** The up/down and
  start/stop buttons run `./spectro-env` and `./spectro-serve` verbatim,
  whitelisted verb by verb in `serve.py`. Nothing composes a command.
- **Everything is local.** `serve.py` binds 127.0.0.1, the page talks only to
  its own origin, and the action endpoint refuses any browser origin that is
  not this page. Addresses beyond localhost never appear here.

## How it works

`serve.py` (python3 stdlib, no dependencies) serves the page and gathers the
facts server-side, where no browser CORS fence stands in the way — the first
cockpit's `no-cors` probe could tell a door from a wall and nothing more.
`GET /api/estate` returns the whole reading; `POST /api/act` runs a
whitelisted script, detached, logging to `logs/cockpit-act.log`.

The pure decisions — registry parsing, launch discovery, state words, the
health shape, collision detection, the origin guard, the act whitelist — are
pinned in `test_serve.py`:

```bash
python3 cockpit/test_serve.py
```
