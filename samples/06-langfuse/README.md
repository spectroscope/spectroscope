# 06 — endpoint variant: Langfuse

No code lives here on purpose. Sample 05's embedded main — and the CLI's
zero-code path — are endpoint-agnostic: the exporter speaks OTLP/HTTP, and
Langfuse ingests exactly that. Only the endpoint and the auth differ.

Langfuse has no Java SDK; its documented JVM path is this OTLP endpoint,
so the built-in exporter is the first-class way to see spectroscope runs
in Langfuse — no bridge process in between.

## Settings

Create a project in your Langfuse (self-hosted shown; for Langfuse Cloud
replace the host) and take its public/secret key pair from the project
settings:

```bash
export SPECTRO_OTLP_ENDPOINT="http://localhost:3000/api/public/otel/v1/traces"
export SPECTRO_OTLP_BASIC_AUTH="pk-lf-...:sk-lf-..."
```

The pair is sent as standard HTTP Basic auth. Then either:

```bash
spectro run -p "Summarize README.md"        # zero code — CLI and server attach the exporter
```

or run sample 05's Gradle main with the same environment — the identical
binary path, pointed at Langfuse instead of Jaeger.

In Langfuse, the run appears as one trace: the session as the root agent
observation, each turn as a generation with token usage, each tool call as
a tool observation, gate decisions as spans. The session id rides along as
`langfuse.session.id`, so all runs of one session group under Sessions.

## Read-back check

Langfuse's public API confirms the ingest server-side, with the same key
pair:

```bash
curl -s -u "pk-lf-...:sk-lf-..." "http://localhost:3000/api/public/traces?limit=3"
```

## Keys stay out of files

The `pk:sk` pair is a credential. Export it in your shell or put it in
`~/.spectro/.env` (the CLI and server read that file; it is created with
mode 0600) — never commit it, and never write it into a sample or a build
file.
