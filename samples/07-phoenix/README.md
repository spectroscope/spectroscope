# 07 — endpoint variant: Phoenix

No spectroscope code lives here on purpose. Sample 05's embedded main —
and the CLI's zero-code path — are endpoint-agnostic. Arize Phoenix needs
one extra piece, though, and this README is honest about it:

**Phoenix's OTLP/HTTP ingest accepts protobuf bodies only. spectroscope's
exporter posts OTLP/JSON.** Pointing `SPECTRO_OTLP_ENDPOINT` straight at
`http://localhost:6006/v1/traces` gets an HTTP 415 — the exporter warns
once and the run is unaffected, but nothing lands. The standard bridge is
an OpenTelemetry Collector in front: it accepts OTLP/JSON and forwards
protobuf.

## Two containers

Phoenix itself:

```bash
docker run --rm -d --name phoenix -p 6006:6006 arizephoenix/phoenix:latest
```

The collector, with a ten-line config (`otel-collector.yaml` in this
directory):

```bash
docker run --rm -d --name otelcol -p 4319:4318 \
  -v "$PWD/otel-collector.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector:latest --config /etc/otelcol/config.yaml
```

## Settings

Point the exporter at the collector; no auth anywhere in this local setup:

```bash
export SPECTRO_OTLP_ENDPOINT="http://localhost:4319/v1/traces"
```

Then either:

```bash
spectro run -p "Summarize README.md"        # zero code — CLI and server attach the exporter
```

or run sample 05's Gradle main with the same environment.

## What lands in Phoenix

Open http://localhost:6006 — the run is in the **default** project
(Phoenix groups by its own project attribute, not by the OTel service
name): the session as the root agent span, each turn as an **LLM** span
with token counts, each tool call as a **tool** span, the gate decisions
as plain spans. Phoenix reads the exporter's `gen_ai.*` attributes
natively, which is where the span kinds and token numbers come from.
