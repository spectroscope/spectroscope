# 05 — OTel export, two ways

spectroscope ships an OTLP exporter (`OtlpSink`, in `spectro-core` since
0.3.0): it folds a session's events into OpenTelemetry GenAI spans and
posts them to any OTLP/HTTP traces endpoint. This sample shows both ways
to use it. `docs/OBSERVABILITY.md` in the repository documents the span
tree and attributes in full.

## A collector to talk to

One line, no config — Jaeger's all-in-one image accepts OTLP/HTTP on 4318
out of the box:

```bash
docker run --rm -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.13.0
```

The UI is at http://localhost:16686.

## Way 1 — zero code

The CLI and the server attach the exporter themselves whenever the
endpoint is configured. Any run becomes a trace:

```bash
export SPECTRO_OTLP_ENDPOINT=http://localhost:4318/v1/traces
spectro run -p "Summarize README.md"
```

No code changes anywhere. `SPECTRO_OTLP_BASIC_AUTH=pk:sk` adds Basic auth
for backends that want it (see samples 06 and 07 for Langfuse and Phoenix
endpoints).

## Way 2 — embedded

The five-lines facade hands you the raw stream and attaches nothing, so an
embedded caller tees by hand — same pattern as the JSONL recording in
sample 03, one more line:

```java
SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
var store = new SessionStore();
var jsonl = new JsonlSink(store);
Optional<OtlpSink> otlp = OtlpSink.fromConfig(config, store.id());

for (RunEvent event : agent.run("...")) {
    jsonl.onEvent(event);                        // durability first
    otlp.ifPresent(sink -> sink.onEvent(event)); // the export is additive
}
```

`OtlpSink.fromConfig` reads the same two settings as the CLI
(`SPECTRO_OTLP_ENDPOINT`, `SPECTRO_OTLP_BASIC_AUTH`) and returns empty when
the exporter is off — the sample then runs JSONL-only and says so.

Run it:

```bash
./gradlew build
SPECTRO_OTLP_ENDPOINT=http://localhost:4318/v1/traces gradle run
```

No key and no model server: the model is a scripted provider (in this
directory) whose first turn calls the real `write_file` tool. The export
is the shipped code path, and the trace it produces has real structure.

## What lands in Jaeger

One trace per session, service `spectroscope`:

- a root **session** span, one **agent** span per agent (`invoke_agent`)
- one **generation** span per turn (`chat`), carrying
  `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
- one **tool** span per tool call (`execute_tool`), gate denials marked

The exporter posts at the session's idle points on a background thread; a
dead backend warns once and never slows or fails the run. Span and trace
ids are deterministic, so re-exporting the same session upserts instead of
duplicating.
