# demo-home — the home directory the guide is photographed against

Every plate in `shots/` and `shots-light/` is shot against a server started
with this directory as `user.home`, never against a real one.

```bash
cd ~/spectro-demo
java -Duser.home="$PWD/../Spectroscope/spectroscope-harness/spectro/docs/guide-assets/demo-home" \
     -jar /tmp/spectro-doc-080.jar --server.port=8090
```

## Why it exists

`SessionStore` resolves its directory as `${user.home}/.spectro/sessions`
(`spectro-core/src/main/java/dev/spectroscope/core/session/SessionStore.java:51`).
On the machine these plates come from, that directory holds 304 real
sessions, and the app's left rail lists them by their first prompt. The
guide published before 2026-08-12 therefore printed a working chat history
across every plate that left the rail open: real questions, real token
counts, real timestamps.

Collapsing the rail everywhere was not the fix, because five plates have the
rail as their subject (`01-home-empty`, `02-scenario-picker`, `15-archive-bar`,
`15b-delete-armed`, `16-trace-resume-marker`). Those need a session list that
is safe to publish, which is this one.

## What is in it

Seven sessions, written on 2026-07-23 for exactly this purpose. They carry
English prompts about a fictional codebase and nothing else — checked for
keys, paths, addresses and names before they were committed here.

| Session | First prompt |
|---|---|
| `pyspawn1` | Prepare the release: write the steps and map the workspace — in parallel. |
| `cold-start-18s-to-first-token` | Add a retry budget to the HTTP client and cover it with a test. |
| `auth-refactor-three-lenses` | Review the auth refactor: correctness, security, performance — in parallel. |
| `flaky-websocket-reconnect-root-cause` | Trace the flaky websocket reconnect and write up the root cause. |
| `dark-mode-five-step-plan` | Draft a five-step plan for adding dark mode to the web app. |
| `map-the-payments-module` | Map the payments module: what lives where, one line per folder. |
| `beach-poster-image-gen` | Make a poster: a cat lounging on a beach with sunglasses and a cocktail. |

`auth-refactor-three-lenses` is the one `tools/capture_app_shots.mjs` opens by
the substring `"auth refactor"`, so the website plates need this directory too.

## What the server writes into it, and what is tracked

Starting the server seeds `skills/`, `logs/`, `leveling.json` and
`sessions-index.json`. Only `sessions/`, `settings.json` and this README are
tracked; the rest is regenerated on every boot and is ignored.

`settings.json` here is deliberately thin. The real one on this machine
carries an `otlpBasicAuth` pair, which is why this file was written by hand
rather than copied.

## The live plates need a backend, and its address is not in here

Five plates come from real runs rather than replays: `21-panel-plan-live`,
`22-thinking-live`, `23-permission-dialog`, `23b-permission-dialog-remember`
and `24-after-deny`. They need a reachable model.

`settings.json` here names a provider and no address on purpose. This repo is
public, and the test backend lives on a private Tailscale node whose address
belongs in the product home's own CLAUDE.md and nowhere else. Before a capture
run, add the address locally:

```json
{ "provider": "lmstudio", "baseUrl": "http://<your-backend>:1234",
  "workspace": "~/spectro-demo", "thinking": true }
```

and put this file back the way it is now before committing. `git diff` for the
address is a cheap last check.

## Reset between capture runs

The live plates write real sessions into this home, so a second run would show
sixteen rows in the left rail where the first showed seven, and the plates
would stop being reproducible. The seven curated sessions are tracked and
everything a run adds is not, so one command puts it back:

```bash
git clean -fd docs/guide-assets/demo-home
```

Run it before every capture, not after — that way a crashed run still leaves
the evidence behind for you to look at.

## The one thing to remember

A fresh home has never seen the onboarding dialog, so the first load shows
**welcome — pick a backend**. That is a plate in its own right
(`00-onboarding-welcome`), and a nuisance for every other one: dismiss it
with the `got it` button before the suite runs.
