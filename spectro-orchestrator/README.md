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

Every event of every lane is wrapped in a `BusEnvelope`:

```jsonc
{
  "sender":    "bugs",              // the lane's agent id
  "epoch":     0,                   // the sender's incarnation — a restarted
                                    //   node stamps a higher one (lanes: 0)
  "contextId": "fleet-4c21…",       // one panel run = one fleet session
  "taskId":    "task-7f3a…",        // correlates one assignment end to end
  "sequence":  42,                  // monotonic per (sender, epoch)
  "parentId":  "bugs#0#41",         // causal chain, "-" at each incarnation's root
  "topic":     "fleet-4c21….events",// session isolation for subscribers
  "ts":        1721400000000,
  "payload":   { "type": "text_delta", … }   // the RunEvent, verbatim
}
```

Rules the tests pin: the envelope wraps and never rewrites the event;
addressing is self-addressing (correlate by `taskId` + `contextId`, no
from/to on the envelope — the A2A steal); per-incarnation order lives in
`sequence`; causality walks `parentId` back to `-` (each incarnation
starts its own chain); the envelope id is `sender#epoch#sequence`.

The A2A-lite choreography on the RunEvent stream itself stays the core's
existing vocabulary, untouched: `agent_spawn`, `agent_message`
task/submitted → status/working → result/completed|failed, framed by the
panel's own `run_start`/`run_end`. The Spectrum tab folds exactly this.

## Transports

`BusTransport` (mirrored on the McpTransport seam pattern):

| Impl | State | Notes |
|---|---|---|
| `InMemoryBus` | shipped | synchronous fan-out, dev/tests/facade |
| `ProcessBus` + `ProcessBusHub` (TCP JSONL) | shipped | the process transport leg, guarantees below |
| stdio variant | with the node binary | arrives when nodes are spawned, not before |
| broker (NATS/…) | only if reality demands | the seam stays the same |

### What the TCP pair guarantees (and what it does not)

One `ProcessBusHub` per fleet (it is itself a `BusTransport` — the
aggregator subscribes in-process, remote `ProcessBus` clients ride the
wire). Day-one guarantees, each test-pinned:

- **Reconnect:** clients auto-reconnect with capped backoff and resume
  via a per-(sender, epoch) cursor; a killed connection loses nothing.
- **At-least-once, exactly-once observed:** a bounded outbox reflushes
  unacked frames on reconnect (a full outbox BLOCKS the publisher — the
  EventStream discipline, never a silent drop); the hub dedups by
  per-(sender, epoch) high-water, the client dedups again, so consumers
  see each frame once, in per-incarnation order. `close()` drains the
  outbox before giving up, and counts stranded frames loudly.
- **Sender epochs:** every envelope names its sender's incarnation, and
  every guarantee here is scoped per `(sender, epoch)` — a restarted
  node stamping a fresh epoch is a NEW ordered, deduped stream, so its
  restarted sequence DELIVERS instead of being read as redelivery and
  acked into the void. An epoch is an identity qualifier, not a fence:
  both incarnations of a crashed-and-restarted sender deliver
  exactly-once (a still-flushing old process is never discarded); which
  incarnation counts as "current" is roster business, above the bus.
- **Replay buffer:** a bounded per-topic ring replays for late and
  reconnecting subscribers. Falling behind the ring is survivable but
  never silent: the evicted stretch arrives as a `BusGap`, per
  incarnation (losing events is a failure mode, hiding the loss is the
  sin) — and the announcement advances the client's cursor over the
  lost stretch, so a reconnect announces each loss exactly once, not on
  every resume.
- **Isolation:** a slow remote subscriber is disconnected (it heals from
  the ring); a throwing consumer is warned about once and keeps its
  neighbours fed.

The transport was adversarially reviewed before it shipped — two rounds
(17 findings on the transport, 13 on the epoch change; every confirmed
one fixed or documented here): acks carry their topic AND epoch (a
sender's sequences restart per context and per incarnation — an ack
missing either scope would trim frames the hub never confirmed), a line
the hub or client cannot parse is CONNECTION-FATAL instead of
skipped-and-acked-over, gap handlers are guarded user code and never run
under the hub lock, no consumer ever runs under that lock either (local
subscribers drain their own bounded queue; overflow drops loudly, and
the gap names ONLY sequences actually dropped — a frame that slipped
into a freed slot between two drops splits the stretch instead of being
counted lost), connections register before their reader starts,
fully-evicted superseded incarnations are pruned so a crash-looping
sender cannot gap-storm late subscribers, and `retire(topic)` lets a
long-lived aggregator release a finished session's ring.

Honest limits, stated because hiding them would be the real failure:
- The ring is in-memory — a hub restart starts an empty world
  (publishers reflush what the old hub never acked; anything acked but
  undelivered dies with it). Durability beyond that is a broker's job,
  and the seam is where a broker would dock.
- Epoch VALUES are the caller's contract: the bus treats the epoch as
  an opaque incarnation qualifier and never invents one. A restartable
  node must stamp a genuinely fresh (monotonically increasing) epoch
  per process start — reusing an epoch after a restart re-creates the
  acked-into-void trap for exactly that stream, which is why the
  epoch-less `BusPublisher` constructor is documented lane/test-only.
  Monotonic assignment ships with the node binary and its lifecycle.
- One `ProcessBus` is ONE logical subscriber with one resume cursor: a
  second consumer joining an actively consumed topic starts mid-stream
  (frames delivered to nobody, however, never advance the cursor — a
  consumer joining after all handles closed replays what they missed).

The wire is versioned newline-delimited JSON — `"v":3` since the `ctl`
op (reverse control: the hub addresses a verb to one node) entered the
dialect on top of the epoch changes (cursor per incarnation, epoch on
ack and gap); a foreign version fails loudly at parse time, because a
mixed-version fleet must be impossible to miss. A real child-JVM proof
(`ProcessBusProcessProofTest`) crosses the boundary with distinct PIDs,
and `close()` drains the outbox first — a finishing node must not
strand its tail.

## The docking point

The bus docks at the core's **tracing seam**:
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
building block the process transport leans on.

`BusPublisher` is this module's port: the panel's lanes publish through it
(sharing the lane's pen, so choreography frames and agent events stay ONE
causal chain), and a solo session uses the public constructor
(`taskId = contextId`, the degenerate one-task case).

`spectroscope node` (in spectro-cli) is the operator-facing leg: one
headless run whose whole event stream rides this transport to a hub —
identity at the source (events, envelopes and the `NodeCard` on the
connection handshake all carry the node id), a fresh wall-clock epoch per
process start, JSONL durability first. The bus hangs behind a bounded
queue on its own thread (`AsyncBusPort`): a dead or stalled hub never
blocks the run — events beyond the buffers are dropped from the BUS VIEW
only, counted and warned loudly, and the drops happen before the stamper
so the on-wire sequence stays contiguous (at-least-once still holds for
everything the outbox accepted; the session JSONL is complete
regardless). The hub's `roster()` lists the cards of currently connected
nodes — registration is the handshake, liveness is the connection.

The server side closes the loop: spectro-server hosts the hub as an
OPT-IN bean (`SPECTRO_HUB_PORT`; default off — no listener, no attack
surface for non-fleet users; an invalid value disables it LOUDLY). The
aggregator taps every card-announced topic through the hub's own
local-subscriber discipline, folds joins/leaves/last-seen, and surfaces
the fleet as `GET /api/fleet`, per-node ring replay under
`GET /api/fleet/{node}/events` (ring-bounded, and flagging `truncated`
when the ring already evicted earlier frames), and two socket-only UI
frames — `fleet_roster` and `fleet_event` (the envelope in its canonical
line form). Each browser drains those frames on its own bounded queue, so
a slow tab never stalls a joining node or another tab's feed. With the
hub off, the web socket is frame-for-frame the pre-fleet one.

Honest limit: the facade's `Spectro.panel()` still runs its fleet on the
in-memory bus — panel-over-ProcessBus is a deliberate non-goal until a
use case demands it. `OrchestratorPanel(BusTransport)` remains the
constructor seam an aggregator (or a test) uses to watch a fleet on its
own bus. Fleet persistence to disk deliberately does not exist: the hub
ring is the whole replay story, and the opt-in hub keeps every context's
ring and tap for its uptime — a development and observation tool, not a
long-lived multi-tenant service.

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
