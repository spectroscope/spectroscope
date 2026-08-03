# 04 — a fleet across processes

Sample 02 runs a fleet inside one JVM. This one spreads it over separate
OS processes: a hub in the server, nodes as their own `spectro node`
processes, and the cockpit watching all of it live. No Gradle project is
needed for the main path — it is choreography with the released binaries.

## What you need

From the [GitHub release](https://github.com/spectroscope/spectroscope/releases):

- `spectro-server-0.4.1.jar` — the web cockpit; it also hosts the fleet hub
- `spectro-0.4.1.zip` — the CLI (`bin/spectro`), which provides `spectro node`

Plus a model backend for the nodes: local Ollama
(`SPECTRO_PROVIDER=ollama SPECTRO_MODEL=<name>`) keeps it key-free, or any
configured cloud provider.

## 1. Start the cockpit with the hub

The hub is off by default; `SPECTRO_HUB_PORT` opts in (loopback only):

```bash
SPECTRO_HUB_PORT=7700 java -XX:MaxRAMPercentage=33 -jar spectro-server-0.4.1.jar
```

The heap flag is the one every shipped launcher passes for you; a bare
`java -jar` is assembled by no script of ours, so here you pass it yourself.

Open http://localhost:8080 and switch the sidebar to **fleets**.

## 2. Start two nodes

Each node is one process running one prompt; its whole event stream rides
the bus to the hub. `--context` names the fleet the nodes share:

```bash
unzip spectro-0.4.1.zip
SPECTRO_PROVIDER=ollama SPECTRO_MODEL=qwen3 \
  ./spectro-0.4.1/bin/spectro node -p "Summarize README.md in three lines" \
  --hub 127.0.0.1:7700 --context demo --id reader

SPECTRO_PROVIDER=ollama SPECTRO_MODEL=qwen3 \
  ./spectro-0.4.1/bin/spectro node -p "List the build files in this directory" \
  --hub 127.0.0.1:7700 --context demo --id lister
```

The `demo` fleet appears in the cockpit while the nodes run: one lane per
node, events streaming, the canvas drawing the topology. Each node also
writes its own local session JSONL — the file stays the durability anchor;
the hub is a live mirror, and a dead hub never blocks a node.

Useful flags: `--role` labels the node's card, `--permissions ask` parks
each tool call for an operator to answer from the cockpit's gate bar, and
`--linger` keeps the node alive as a controllable fleet member after its
run.

## 3. The same hub from code

`PanelToHub.java` in this directory is an ordinary `Spectro.panel()` run
with one twist: when `SPECTRO_HUB` is exported, every lane is mirrored to
that hub as well, so an embedded fleet shows up in the cockpit next to the
node fleets.

```bash
gradle build
SPECTRO_HUB=127.0.0.1:7700 gradle run
```

The returned event stream is unchanged — the mirror is additive, and
without `SPECTRO_HUB` the same main is a plain local fleet run (offline,
scripted provider, no key).
