# Launch configurations

What card 202 built: the app under test starts by name, and the browser of
cards 201 and 218 looks at it as soon as loopback is opted into. **Out of the
box it is not** — every address a launch configuration produces is localhost,
and the net fence refuses localhost until `allowLocalhost` is set, so by default
the app starts and no page opens. That is a decision, not an oversight, and it
has its own section below. The browser itself is in `docs/BROWSER.md`; this page
is only about starting the thing it looks at.

The point, in one line: **"show me the change running" should be one thought.**
Before this, an agent that was supposed to check a web app had to be told how to
start it, on what port, and where to look.

## The file is Claude Code's, unedited

spectroscope reads `.claude/launch.json` from the project root — the same file
Claude Code reads, in the same place. **A repository already set up for Claude
Code needs no second config file.** That compatibility is the point of the card,
not a convenience: there is deliberately no spectroscope dialect beside it.

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "web",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev", "--", "--port", "5173", "--strictPort"],
      "port": 5173
    },
    {
      "name": "api-already-running",
      "url": "http://localhost:4321/health",
      "port": 4321
    }
  ]
}
```

| key | meaning |
|---|---|
| `version` | top level, beside `configurations`. Every real file carries it. |
| `name` | how you address the configuration. An entry without one cannot be addressed and is skipped, and the listing says how many were. |
| `runtimeExecutable` + `runtimeArgs` | what to run. A relative executable resolves against the project root, a bare name off the `PATH`. |
| `port` | where the app answers. `http://localhost:<port>/` unless a `url` says otherwise. |
| `url` | the address to open. **With no `runtimeExecutable`, this is an attach entry** — see below. |

**What the reader does with a key it has never seen: ignores it.** Same for a
`version` it does not know. A file Claude Code runs has to load here unedited,
and a key added to that format next month must not turn a working repository
into a broken one. `launch_list` names the keys it ignored, so "it worked but
not the way I wrote it" is visible rather than silent.

### What the format actually contains, measured

The first cut of card 202 described a format nobody had looked at. A stress
test parsed every readable `.claude/launch.json` under the operator's home
instead, and the card was corrected against what it found. Re-measured on
2026-08-13 while this was built:

```bash
python3 - <<'PY'
import json, os
files = []
for root, dirs, fs in os.walk(os.path.expanduser("~")):
    dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "Library", ".Trash", "build", "bin", ".gradle")]
    if os.path.basename(root) == ".claude" and "launch.json" in fs:
        files.append(os.path.join(root, "launch.json"))
keys, versions, urlonly = {}, {}, 0
total = 0
for f in files:
    d = json.load(open(f))
    versions[str(d.get("version"))] = versions.get(str(d.get("version")), 0) + 1
    for c in d.get("configurations", []):
        total += 1
        for k in c:
            keys[k] = keys.get(k, 0) + 1
        if "url" in c and "runtimeExecutable" not in c:
            urlonly += 1
print(len(files), "files", total, "entries", versions, keys, "url-only:", urlonly)
PY
```

15 files, 58 entries, every file on `version` `0.0.1`, every entry carrying
`name` + `runtimeExecutable` + `runtimeArgs` + `port`, **one** entry carrying
`autoPort`, and **zero** entries carrying the url-only shape. So the shape the
format allows and nobody here has written yet is covered by a fixture that ships
beside the test (`spectro-core/src/test/resources/launch/fixture-launch.json`),
in the same JSON Claude Code accepts.

## The five tools

| tool | tier | what it does |
|---|---|---|
| `launch_list` | read | every configuration the repository carries, its command, its address, and whether it is up, attached or exited |
| `launch_start` | eval-execute | starts it, waits for the address to answer, and points this session's browser at it unless the fence refuses the address — which on localhost it does until `allowLocalhost` is set |
| `launch_stop` | write | ends it and everything it spawned |
| `launch_restart` | eval-execute | stop then start, by name |
| `launch_logs` | read | what it printed, stdout and stderr merged |

**"Up" means the address answers**, not that a command was issued. A start polls
the port until something accepts a connection, the process dies, or the budget
runs out (45 seconds by default, 180 at most).

### Why those tiers

Card 199 rates a tool by what it can DO. `launch_start` runs a program of
somebody else's choosing with arguments of somebody else's choosing, as this
user, on this machine — which is exactly what `run_command` is rated
eval-execute for, so it gets the same tier. The indirection through a file does
not shrink the blast radius: a repository the agent has just cloned authored
that file, and `runtimeExecutable` is a free string. **A `.claude/launch.json`
is a remote-code-execution primitive wearing a config file's clothes.** Rating
it lower would let one wildcard approve by the back door what the front door
prompts for.

`launch_stop` runs no code and reaches only a process this session started — an
attached entry is refused, never signalled — so it is `write`, in the same sense
`browser_navigate` acting on the pane is. `launch_list` reads a file and
`launch_logs` reads output already captured.

## localhost, the point of the card and the thing the fence refuses

Card 199's net fence refuses loopback unless the operator opted in. Every
address this card produces is loopback. The two are not reconciled by an
exception — the fence exists because a prompt-injected page must not be able to
send the agent at this machine, and a launch file is not a stronger warrant than
a page.

So the split is: **the app starts, the browser does not open.** Starting a
process is not a network reach and the fence has no remit over it; pointing a
browser somewhere is, and it keeps its verdict. What a reader gets, verbatim
from a live drive:

```
"web" is up on http://localhost:61318/ (pid 42324). The browser was NOT pointed
at it: spectroscope refused localhost:61318: it is this machine, and the local
verify loop is not opted in (set allowLocalhost in the settings to reach it on
purpose) (rule: loopback). The server keeps running — launch_logs reads what it
prints, launch_stop ends it — so the opt-in is the only thing between you and
the page.
```

Four things in one sentence: it is up, the browser is not on it, why, and the
one setting that changes it. The server is still running afterwards, which is
the part that had to be decided rather than fallen into — refusing to start
would have been tidier code and a worse product, leaving a reader with no
server, no logs, and a fence message about an address nothing is listening on.

Turn it on the same way `browser_navigate` needs it — `~/.spectro/settings.json`
or the project's own settings:

```json
{ "allowLocalhost": true }
```

or `SPECTRO_ALLOW_LOCALHOST=1`. It is read fresh per call, so a saved setting
reaches the next call rather than the next launch.

## A server that dies keeps its log

The commonest way a dev server fails is not "it never came up". It comes up,
answers the port, and dies twenty seconds later on the first request, and the
reason is in the last four lines it printed.

So **a read never destroys a record.** `launch_list` asks the supervisor about
every configuration in the file, and asking used to evict a dead one along with
its log ring — which made the agent's most natural loop the one that lost the
evidence:

```
launch_start web     → up on http://localhost:51824/
                       (it dies)
launch_logs  web     → FATAL: Cannot find module ./server — the build died
launch_list          → ...
launch_logs  web     → nothing running called "web"      ← the error is gone
```

Now a configuration that exited keeps its output and its exit code until the
session closes or the same name is started again, and both readers say so:

| tool | what it says about a configuration that died |
|---|---|
| `launch_list` | `— EXITED with code 1; launch_logs still reads what it printed` |
| `launch_logs` | `"web" is NOT running — it exited with code 1. This is what it printed before it did: …` |
| `launch_stop` | that it had already exited with that code, and that stopping is what finally drops the output |

`launch_stop` is the only verb that discards a dead configuration's log, because
it is the only one where the reader asked for the entry to go away.

## An entry spectroscope cannot run: attach

An entry with a `url` and no `runtimeExecutable` names a server that is already
running. Nothing is spawned for it. It counts as up once that address answers,
the browser opens on it under the same fence rule as any other entry — a
`url` on localhost is refused the same way a `port` is — and:

- **`launch_logs` has no output for it** and says exactly that. spectroscope
  started no process and captured nothing, and presenting an empty log as a
  healthy one would be a lie the transcript never records.
- **`launch_stop` and `launch_restart` refuse it.** What those verbs should mean
  for a process spectroscope never spawned is an open decision for the owner,
  and card 202 records three defensible answers: refuse, drop the attachment
  only, or kill whatever holds the port. The third can end a server the operator
  started by hand for something else — this machine's own launch file points at
  long-running `/tmp` jars, so that is not hypothetical — and nobody has asked
  for it. Until the call is made, nothing here signals a process it did not
  spawn, which keeps all three answers reachable.

## Stopping, which matters as much as starting

**Everything a session started dies when that session closes.** Same event as
its browser: the socket going away — the one that already cancels the run,
releases parked permission questions and lets the live-session id go
(`SessionConnection.onClose`). A supervisor is per session for the same reason a
browser is: a dev server is live state, and the session that started it is the
only thing that knows why it is up.

Two things had to be true for that promise to hold, and both are proved rather
than asserted:

- **The whole tree goes, not just the shell.** `npm run dev` is a shell that
  spawns Vite; killing the shell leaves Vite holding the port under a new
  parent. So the descendants are snapshotted *before* anything is signalled —
  after the parent dies the tree has already been reparented and
  `descendants()` answers with nothing.
- **A SIGTERM'd server reaps too.** A supervised spectro-server dies by signal
  and no `onClose` runs on the way out, so a JVM shutdown hook runs the same
  sweep.

```bash
# a real child JVM, a real shell with a real grandchild, a real SIGTERM,
# and both pids asked whether they are gone
./gradlew :spectro-core:test --tests '*LaunchSupervisorReaperProofTest*' \
  --rerun-tasks --no-build-cache

# and the same question at the session level, through a real SessionConnection
./gradlew :spectro-server:test --tests '*SessionLaunchLifetimeTest*' \
  --rerun-tasks --no-build-cache
```

Removing the descendant sweep turns both red on the grandchild assertion, which
is how we know they pin anything.

## Every failure names what was tried

House rule from cards 193 and 203.

| what went wrong | what the sentence carries |
|---|---|
| a name the file does not carry | the name that was given **and** the names it could have had |
| a port that never comes up | the configuration, the address, and the last 30 lines the process printed |
| a process that died first | the exit code, plus its output |
| an attach address that answers nothing | the url, and why nothing was spawned for it |
| stop or restart on an attached entry | the name, and that spectroscope never started it |
| logs for an attached entry | that this is *no* log, not an empty one |
| logs for a configuration that came up and then died | that it is NOT running, its exit code, and everything it printed before it went |

**Everything the file wrote goes through one flattener before it reaches a
sentence** — names, addresses, the `version`, the names of ignored keys, command
lines — so one configuration is always one line. A `.claude/launch.json` is
written by whoever wrote the repository, and an entry name carrying newlines was
otherwise enough to print a forged block of invented configurations into the
transcript through `launch_list`, which is tier read and never prompts.

## What is not here

- **Writing launch.json for you.** The file is authored by hand, as it is for
  Claude Code. The one exception is the url-only fixture beside the test, which
  is test material.
- **A spectroscope dialect.** Unknown fields are tolerated, not adopted.
- **The CLI.** The five tools are registered on the server session beside the
  browser family, because the browser this card opens is the desktop pane's.
  `spectro run` does not carry them.
- **A launch surface in the web UI.** The card's acceptance criteria are all
  agent-facing; nothing here adds a panel, a button or a string.
