# samples

Runnable, self-contained examples against the **published** artifacts:

```
dev.spectroscope:spectro-core:0.4.1
dev.spectroscope:spectro-orchestrator:0.4.1
```

Two ground rules:

1. **Every sample is a standalone Gradle project.** Each directory has its
   own `settings.gradle.kts` and resolves spectroscope from Maven Central —
   never from this repository's build. Copy a directory anywhere and it
   still builds. You need a Gradle installation (any recent version) and
   Java 21 or newer.
2. **Key-free by default.** Samples that run offline use a tiny scripted
   provider (copied into each sample, so nothing is shared) or a local
   Ollama. Cloud keys are only ever an optional variant, and they are
   marked as such.

| Sample | Shows | Runs offline? |
|---|---|---|
| [01-five-lines](01-five-lines/) | The frozen facade, verbatim; the one-line swap to a local model | build only (needs a key or Ollama) |
| [02-fleet](02-fleet/) | `Spectro.panel()` — several agents, one merged stream | yes |
| [03-watch](03-watch/) | Recording an embedded run so `spectro web` shows it | yes |
| [04-fleet-across-processes](04-fleet-across-processes/) | Hub in the server, `spectro node` processes, cockpit live; plus the `SPECTRO_HUB` mirror from code | build only (choreography in the README) |
| [05-otel-export](05-otel-export/) | The shipped OTLP exporter — zero-code and embedded | yes (spans need a collector) |
| [06-langfuse](06-langfuse/) | Endpoint variant: Langfuse, with the stack to point at (`install.sh` + pinned compose) | needs Docker; nothing is started for you |
| [07-phoenix](07-phoenix/) | Endpoint variant: Phoenix via an OTel Collector (README only) | — |
| [08-langchain4j-provider](08-langchain4j-provider/) | Any LangChain4j chat model as the agent's provider | build only (needs Ollama) |

`./verify.sh` builds every sample and runs the offline ones.

---

*For contributors working against unpublished changes: `./gradlew
publishToMavenLocal` in the repository root, add `mavenLocal()` to a
sample's repositories, and bump the version — the samples themselves stay
pinned to the released coordinates.*
