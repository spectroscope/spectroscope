# spectro-orchestrator

The fleet: agents on a bus, one merged spectrum. The design follows a
verified bus prototype (envelopes, self-addressing, causal chains); the
module was written fresh for this repo in `dev.spectroscope.*` packages.

## The five lines, fleet edition

```java
var panel = Spectro.panel().model(Anthropic.opus());
panel.agent("bugs").task("Find bugs in the diff");
panel.agent("perf").task("Check the hot queries");

for (RunEvent event : panel.run()) {
    System.out.println(event);   // every lane, one spectrum
}
```

`Spectro.panel()` lives in the frozen facade (spectro-core) and resolves
this module through the `FleetPanelFactory` ServiceLoader hook — the core
never depends on the fleet.

## What rides the bus

Every event of every lane is wrapped in a `BusEnvelope` (KONZEPT §3.1):

```jsonc
{
  "sender":    "bugs",              // the lane's agent id
  "contextId": "fleet-4c21…",       // one panel run = one fleet session
  "taskId":    "task-7f3a…",        // correlates one assignment end to end
  "sequence":  42,                  // monotonic per sender
  "parentId":  "bugs#41",           // causal chain, "-" at the root
  "topic":     "fleet-4c21….events",// session isolation for subscribers
  "ts":        1721400000000,
  "payload":   { "type": "text_delta", … }   // the RunEvent, verbatim
}
```

Rules the tests pin: the envelope wraps and never rewrites the event;
addressing is self-addressing (correlate by `taskId` + `contextId`, no
from/to on the envelope — the A2A steal); per-sender order lives in
`sequence`; causality walks `parentId` back to `-`.

The A2A-lite choreography on the RunEvent stream itself stays the core's
existing vocabulary, untouched: `agent_spawn`, `agent_message`
task/submitted → status/working → result/completed|failed, framed by the
panel's own `run_start`/`run_end`. The Spectrum tab folds exactly this.

## Transports

`BusTransport` (mirrored on the McpTransport seam pattern):

| Impl | State | Notes |
|---|---|---|
| `InMemoryBus` | shipped | synchronous fan-out, dev/tests/facade |
| `ProcessBus` + `ProcessBusHub` (TCP JSONL) | shipped | the P1 transport leg, guarantees below |
| stdio variant | with the node binary | arrives when nodes are spawned, not before |
| broker (NATS/…) | only if reality demands | the seam stays the same |

### What the TCP pair guarantees (and what it does not)

One `ProcessBusHub` per fleet (it is itself a `BusTransport` — the
aggregator subscribes in-process, remote `ProcessBus` clients ride the
wire). Day-one guarantees, each test-pinned:

- **Reconnect:** clients auto-reconnect with capped backoff and resume
  via a per-sender cursor; a killed connection loses nothing.
- **At-least-once, exactly-once observed:** a bounded outbox reflushes
  unacked frames on reconnect (a full outbox BLOCKS the publisher — the
  EventStream discipline, never a silent drop); the hub dedups by
  per-sender high-water, the client dedups again, so consumers see each
  frame once, in per-sender order. `close()` drains the outbox before
  giving up, and counts stranded frames loudly.
- **Replay buffer:** a bounded per-topic ring replays for late and
  reconnecting subscribers. Falling behind the ring is survivable but
  never silent: the evicted stretch arrives as a `BusGap` (§8 trap 1 —
  losing events is a failure mode, hiding the loss is the sin).
- **Isolation:** a slow remote subscriber is disconnected (it heals from
  the ring); a throwing consumer is warned about once and keeps its
  neighbours fed.

The transport was adversarially reviewed before it shipped (17 confirmed
findings, all fixed or documented below): acks carry their topic (a
sender's sequences restart per context — a topic-less ack would trim
OTHER topics from the outbox), a line the hub or client cannot parse is
CONNECTION-FATAL instead of skipped-and-acked-over, gap handlers are
guarded user code, no consumer ever runs under the hub lock (local
subscribers drain their own bounded queue; overflow drops loudly with a
coalesced per-sender gap), connections register before their reader
starts, and `retire(topic)` lets a long-lived aggregator release a
finished session's ring.

Honest limits, stated because hiding them would be the real failure:
- The ring is in-memory — a hub restart starts an empty world
  (publishers reflush what the old hub never acked; anything acked but
  undelivered dies with it). Durability beyond that is a broker's job,
  and the seam is where a broker would dock.
- No sender epochs yet: a RESTARTED sender reusing its id and context
  restarts its sequence at 0, which the hub reads as redelivery — fresh
  frames would be acked and dropped. Node identity and lifecycle arrive
  with the node binary; epochs land there.
- One `ProcessBus` is ONE logical subscriber with one resume cursor: a
  second consumer joining an actively consumed topic starts mid-stream
  (frames delivered to nobody, however, never advance the cursor — a
  consumer joining after all handles closed replays what they missed).

The wire is versioned (`"v":1`) newline-delimited JSON; a real
child-JVM proof (`ProcessBusProcessProofTest`) crosses the boundary
with distinct PIDs, and `close()` drains the outbox first — a finishing
node must not strand its tail.

## The docking point (card 06 acceptance, delivered by card 16)

The bus docks at the core's **tracing seam** (dossier §5.5, KONZEPT §4.3):
`dev.spectroscope.core.trace` holds `TracingPort` plus the `TracingPorts`
registry, and every drain site (CLI REPL, server connection, headless
runner) routes persistence through it —

```java
tracing = new TracingPorts()
    .require(new JsonlSink(store))   // load-bearing: fails the run, like the inline sink it replaced
    .register(new BusPublisher(bus, nodeId, contextId)); // auxiliary: isolated, warn-once
```

Two registration modes, one ordering rule: **durability first.** Required
ports see every event before registered ones and their failures propagate
(a run must not outlive its session file in silence); registered ports are
isolated — a broken auxiliary consumer is warned about once and never
costs the others their events. JSONL before bus is the at-least-once
building block ProcessBus (P1) will lean on.

`BusPublisher` is this module's port: the panel's lanes publish through it
(sharing the lane's pen, so choreography frames and agent events stay ONE
causal chain), and a solo session uses the public constructor
(`taskId = contextId`, the degenerate one-task case). Honest limit: until
`ProcessBus` lands, the bus behind it is in-memory — production consumers
beyond the panel arrive with the aggregator (P1) and the OTel exporter
(P3). `OrchestratorPanel(BusTransport)` remains the constructor seam an
aggregator (or a test) uses to watch a fleet on its own bus.

## Tests

`./gradlew :spectro-orchestrator:test` — key-free (scripted providers):
fleet merge order, A2A-lite choreography, broken-lane isolation, taskId
correlation, per-sender sequence + causal chain, envelope round-trip,
topic isolation, and the BusPublisher port (stamped envelopes, shared-pen
chain continuity). The ProcessBus adds a pure layer (wire codec, hub
ring/dedup/gaps, client outbox/cursor — no timing anywhere) plus loopback
socket tests (latches only, no sleep-as-sync) and the child-JVM boundary
proof. `PanelDemoJsonlTest` additionally writes
`build/panel-demo.jsonl` — paste it into the web UI's import dialog and
the Spectrum tab shows the fleet.
