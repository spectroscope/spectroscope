# Interop — connecting spectroscope agents with everything else

spectroscope keeps its core dependency-thin and does its integrating at
seams. This page lists the seams that exist in the released artifacts,
what each one honestly covers, and what is deliberately not integrated.

## The provider seam: any model backend

`Spectro.agent().model(...)` takes the public `LlmProvider` interface.
Anthropic, Ollama and the OpenAI-compatible family (OpenAI, LM Studio,
OpenRouter, Gemini) ship in the box; anything else is one adapter away.
[`samples/08-langchain4j-provider/`](../samples/08-langchain4j-provider/)
is a working example: a LangChain4j `ChatModel` serving a spectroscope
agent, text and token usage mapped both ways. The adapter is honest about
its scope — it does not bridge tool calling between the two frameworks'
schema dialects.

## MCP: shared tool servers

spectroscope agents mount MCP servers as tools. A configured server
(`mcpServers` in the settings, stdio or HTTP/SSE transport) contributes
each of its tools to the belt as `mcp__<server>__<tool>`, permission-gated
like every other tool, every call and result in the event stream.

Because MCP is the interop point, any MCP server a foreign agent framework
uses can serve spectroscope too, and the other way around —
`spectro-mcp-notes` (a release asset) is a small notes server any MCP
client can mount. There is no "expose a spectroscope agent as an MCP
server" mode in the released artifacts.

## The fleet bus: processes over TCP

`spectro node` processes and a hub speak a line-based JSON protocol over
TCP: **version 3, six ops** — `hello` (with the node's card), `sub` (topic
plus resume cursor), `pub` (one event envelope), `ack`, `gap` (evicted
history, announced loudly) and `ctl` (hub-to-node control: stop, gate
answers). Reconnects resume from a cursor, delivery is at-least-once with
a bounded replay ring, and a version mismatch fails loudly at parse time.

The protocol is small enough to speak from another language or runtime;
until a standalone wire specification is published, the source of truth is
`Wire.java` in `spectro-orchestrator` — readable, and pinned by the
module's tests.

## A2A-lite: task, status, result

Inside a fleet, coordination is carried by `agent_message` events — role
`task`, `status` or `result`, with sender, receiver and state — in the
same stream as everything else, so the choreography is recorded in the
session JSONL like any tool call. This is a deliberately small vocabulary,
not an implementation of the A2A protocol: **there is no A2A gateway**,
and spectroscope does not claim A2A compatibility.

## Session files: an open, additive format

Every run writes one `RunEvent` per JSONL line; the format only ever grows
(new event types, new optional fields), so files recorded by old versions
stay loadable. The cockpit's import reads three formats: spectroscope's
own JSONL, Claude Code transcripts, and VS Code / GitHub Copilot
agent-mode exports — foreign sessions land in the same trace, spectrum and
chat views as native ones.

## Telemetry: OTLP out of the box

The built-in exporter posts OTel GenAI spans to any OTLP/HTTP backend —
Langfuse, Jaeger, or Phoenix behind a collector. That is the integration
path for observability platforms; [OBSERVABILITY.md](OBSERVABILITY.md)
documents the span tree, the attributes and the endpoint variants, and
[`samples/05-otel-export/`](../samples/05-otel-export/) runs it.

## Not integrated, on purpose

- **No agent-framework dependencies.** The core does not depend on
  LangChain4j, Spring AI or any orchestration framework; bridges live in
  samples and adapters, on the provider seam.
- **No A2A gateway.** See above — the honest label for the fleet's
  messages is A2A-lite.
- **No OpenTelemetry SDK.** The exporter writes the OTLP/HTTP JSON wire
  directly; there is no SDK, no agent jar and no auto-instrumentation to
  configure, and nothing to clash with an application's own OTel setup.
