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

The interactive faces mount MCP servers as tools. A configured server
(`mcpServers` in the settings, stdio or HTTP/SSE transport) contributes
each of its tools to the belt as `mcp__<server>__<tool>`, permission-gated
like every other tool, every call and result in the event stream.

An entry may carry `"enabled": false` — the off switch behind the composer's
plus menu and the settings page. The server stays configured, its command
stays readable, and the next agent build skips it without dialing it; a
session already open keeps what it mounted. An entry without the flag is on,
so every config written before the flag existed keeps working.

Which faces, precisely, because the line above used to imply all of them:
the REPL and a web session mount every configured server, and `spectro
doctor` connects to each one to report its reachability and tool count. The
headless faces do not — `spectro run`, a cron fire and a triggered fleet
node share one runner, and it builds the nine standard tools and nothing
else. So a server `doctor` calls reachable is not a server every face has
mounted. Whether that stays true is an open owner decision; the
measurements, the roads and the recommendation are in
[HEADLESS-MCP.md](HEADLESS-MCP.md).

A tool result that carries an **image** block reaches the model as an
image, not as text. The bytes go into the content-addressed image store and
travel to the provider on the same attachment path `view_image` uses, so
the context window pays for one picture and not for a base64 dump; the
event stream carries a reference (`image_generated`), never the payload,
and the image is served back from `/api/images/{file}`. Mixed content keeps
the order the server sent it, with a one-line note standing where each
image was. One image may weigh at most **5 MiB** (`McpTool.MAX_IMAGE_BYTES`,
the providers' own per-image wire limit); a bigger one is refused with a
note naming its size and the cap, decided on the encoded payload before
anything is decoded. A text-only result is exactly what it always was.

The server also names the type of what it sends, and that name is checked
before anything is kept: **`image/png`, `image/jpeg` and `image/webp`** are
carried (`ImageStore.servableMediaTypes()` — the types the image store can
file under a name `/api/images/{file}` serves back, spelling and parameters
normalized away, so `IMAGE/PNG` is `image/png`). Any other type is refused
with a note naming it: nothing is stored, nothing is announced, and nothing
goes to the provider. An image the session could not show is worse than an
image that never arrived, and a type the provider does not know fails the
whole request rather than just that picture.

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
