# Observability — the built-in OTLP exporter

Every spectroscope run already writes a `session.jsonl`; that file is the
durable record and it never depends on a network. On top of it, a run can
**also** stream its spans to any OTLP/HTTP backend — Langfuse, Jaeger, Phoenix,
or anything else that speaks the OpenTelemetry protocol over HTTP. The export
is additive: the JSONL is the anchor, a dead backend warns once and never slows
a run down.

This is a shipped feature (`spectro-core`, since 0.3.0), not a plan. It is the
`OtlpSink` class — a registered `TracingPort` that folds a session's events into
OTel GenAI spans and posts them at the session's idle points.

## Turning it on

Two settings, both off by default:

| What | Env var | Settings UI |
|---|---|---|
| Endpoint | `SPECTRO_OTLP_ENDPOINT` | Settings → Observability → endpoint |
| Basic auth (optional) | `SPECTRO_OTLP_BASIC_AUTH` (a `pk:sk` pair) | Settings → Observability → auth |

The auth pair is sent as a standard HTTP Basic header. It is Langfuse's
`public-key:secret-key`; a backend that needs no auth (Jaeger, a bare Phoenix)
leaves it blank.

```bash
# Land every run in a local Langfuse
export SPECTRO_OTLP_ENDPOINT="http://localhost:3000/api/public/otel/v1/traces"
export SPECTRO_OTLP_BASIC_AUTH="pk-lf-...:sk-lf-..."
spectro run "summarize README.md"
# the trace shows up in the Langfuse UI a moment after the run goes idle
```

No code changes anywhere — the exporter reads the config and rides along. In
the desktop app and `spectro web`, the **doctor** has an OTLP line: it posts an
empty (but valid) OTLP batch to the configured endpoint and reports green when
the endpoint accepts it, so you learn a real run's spans will land *before* you
spend a run finding out. The auth value is never echoed back.

## Endpoint variants

The exporter speaks OTLP/HTTP with a **JSON** body: `POST …/v1/traces`.
Langfuse and Jaeger accept that directly; Phoenix's HTTP ingest is
protobuf-only, so it takes a standard OTel Collector in front (verified —
a direct post answers HTTP 415, the exporter warns once, the run is
unaffected).

| Backend | Endpoint | Auth |
|---|---|---|
| **Langfuse** (local) | `http://localhost:3000/api/public/otel/v1/traces` | Basic `pk:sk` |
| **Jaeger** (all-in-one) | `http://localhost:4318/v1/traces` | none |
| **Phoenix** (arize) | via an OTel Collector (JSON in, protobuf out) — see `samples/07-phoenix/` | none |

Langfuse has no Java SDK; its documented JVM path *is* this OTLP endpoint, so
the exporter is the first-class way to see spectro runs in Langfuse — no bridge
process in between.

> **HTTP/1.1 is pinned on purpose.** The exporter's client does not attempt the
> h2c upgrade (HTTP/2 over cleartext). Some collectors close a plain-HTTP
> upgrade attempt without a word; forcing HTTP/1.1 makes a local, un-TLS'd
> endpoint reliable.

## What the spans look like

A session becomes one trace. The tree mirrors the run:

```
trace  (= session)
└─ root AGENT span            name = the first prompt
   └─ AGENT span per agent    "agent · main", "agent · worker-1", …
      ├─ GENERATION per turn   "turn 1 · main"  (model call + token usage)
      ├─ TOOL span per call    "read_file"      (input, output, ERROR on failure)
      └─ gate span per gate    "gate · write_file"  (WARNING when denied)
```

Image generations become their own spans carrying the requested model and
prompt.

### The attribute mapping (verified against `OtlpSink`)

Every span carries **two** semantic-convention axes at once, so both families
of consumer read it correctly: Langfuse's `langfuse.observation.type` (its
priority registry reads this first) and OpenTelemetry's `gen_ai.operation.name`
(what OpenLLMetry-style consumers read).

| Span | `langfuse.observation.type` | `gen_ai.operation.name` | Notable attributes |
|---|---|---|---|
| Session / agent | `agent` | `invoke_agent` | `gen_ai.system` (provider), `langfuse.session.id`, `langfuse.observation.input` (first prompt) |
| Turn | `generation` | `chat` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.system`, `langfuse.observation.output` (the turn's text) |
| Tool call | `tool` | `execute_tool` | `gen_ai.tool.name`, input/output, `langfuse.observation.level = ERROR` and span status ERROR on a failed tool |
| Gate | `span` | — | `spectroscope.gate.allowed`, `langfuse.observation.level = WARNING` when denied |
| Image | `generation` | — | `gen_ai.request.model`, the prompt |

Resource attributes: `service.name = spectroscope`,
`deployment.environment.name = spectro-local`. Instrumentation scope:
`spectroscope-otlp`.

### Two things to know about the export

- **Idle-point export.** The sink buffers events and exports the whole session
  so far every time a `run_end` leaves no run still open. A long session
  exports several times; each export is the full picture up to that moment.
- **Deterministic ids = upsert, not duplicate.** Every span id is a SHA-256 of
  a stable seed (`trace:<session>`, `agent:<session>:<id>`,
  `turn:<session>:<agent>:<n>`, …). Re-exporting the same session — the next
  idle point, or a manual backfill — produces the *same* ids, so the backend
  upserts the spans in place instead of piling up duplicates.

The buffer is bounded (20 000 events); past that it warns once and stops
growing rather than eat memory on a runaway session.

## Jumping straight to the trace

Once a session has exported at least one batch, the trace tab shows an
`open in langfuse` link. It opens this session's trace in the configured
Langfuse instance, in your normal browser.

No lookup happens. The trace id is derived: `OtlpSink.traceIdFor` seeds it as
`sha256("trace:" + sessionId)` truncated to 16 bytes, and the browser computes
the same value from the session id it already holds. That determinism is the
same property that makes a re-export upsert instead of duplicating.

The link is deliberately quiet:

* Nothing exported yet means no link, not a greyed one. A link that cannot
  work is worse than no link.
* An endpoint that is not Langfuse shaped (Jaeger, Phoenix, an OTLP collector)
  never gets a link, successful export or not, because those backends have no
  page of this shape.
* An export that failed while none has ever succeeded shows a static
  `otlp export failed` line instead. The wording names no vendor, because a
  failing Jaeger export reads the same way.
* Once an export has landed, a later failure does not remove the link. The
  trace it already wrote still exists.

One limitation worth stating plainly: the `otlp_export` frame is socket only
and never reaches the session JSONL, so opening an archived session from the
list shows no link even when its trace exists in Langfuse. The link is for the
session this browser watched export.

## Why there is no inline Langfuse tab

Measured on 2026-08-02 against Langfuse 3.224.1 (`langfuse/langfuse:3`,
`/api/public/health` reports the version), running locally on port 3000.

An embedded Langfuse tab inside spectroscope would be convenient, and it is
not possible without doing something we are not willing to do.

The Langfuse web app answers every request with two framing refusals:

```
x-frame-options: SAMEORIGIN
Content-Security-Policy: ... frame-ancestors 'none'; ...
```

`frame-ancestors 'none'` is a string literal in the image's own
`next.config.mjs`. There is no environment variable, no setting and no admin
toggle that relaxes it, so a browser iframe is refused by design and no amount
of configuration on our side changes that.

Electron is a different story and still a no. An Electron `WebContentsView`
ignores those headers and would load the page. But `spectro-desktop/src/main.ts`
already decided the opposite way for outbound links: they leave for the real
browser, where the user has their session, their password manager and an
address bar that tells them where they are. Embedding Langfuse would reverse
that decision for one vendor, and the web app would still need the link, so we
would ship two different answers to one button.

A proxy that strips the headers is refused outright. It would present Langfuse
as same origin with spectroscope, which hands our page scripted access to the
Langfuse DOM and its session cookie. That is a real privilege boundary and it
exists for a reason.

So the answer is the deep link above: one click, the real Langfuse, in the
browser the user already trusts.

## Reading it back without the UI

Langfuse's public API confirms the spans server-side — handy for a smoke check
or a script:

```bash
# List the most recent traces (Basic pk:sk)
curl -s -u "pk-lf-...:sk-lf-..." \
  "http://localhost:3000/api/public/traces?limit=5" | python3 -m json.tool
```

## Backfilling old sessions

The live exporter only sees runs made while it is configured. To push sessions
recorded *before* you turned it on, the `LangFuse/bridge/export_session.py`
tool in the product home replays a stored `session.jsonl` (or every stored
session) through the same mapping — stdlib-only, same deterministic ids, so a
backfilled session and a later live re-export land as one trace, not two.

```bash
python3 bridge/export_session.py --file ~/.spectro/sessions/<id>.jsonl
python3 bridge/export_session.py --all     # every stored session
```
