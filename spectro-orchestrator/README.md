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
| `ProcessBus` (stdio/TCP JSONL) | next (P1) | `FileBus` in the bus-proof is the didactic template; design reconnect + at-least-once + replay buffer from day one (the autogen trap) |
| broker (NATS/…) | only if reality demands | the seam stays the same |

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
chain continuity). `PanelDemoJsonlTest` additionally writes
`build/panel-demo.jsonl` — paste it into the web UI's import dialog and
the Spectrum tab shows the fleet.
