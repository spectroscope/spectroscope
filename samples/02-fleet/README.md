# 02 — a fleet in one process

`Spectro.panel()` is the fleet counterpart of `Spectro.agent()`: several
agents, one merged event stream.

```java
var panel = Spectro.panel().model(...);
panel.agent("bugs").task("Find bugs in the diff");
panel.agent("perf").task("Check the hot queries");

for (RunEvent event : panel.run()) {
    System.out.println(event);   // every lane, one spectrum
}
```

Each lane is a full agent on its own virtual thread, working in its own
subdirectory of the panel workspace (`<root>/<agentId>`). The panel merges
every lane's events into one stream, framed by the panel's own lifecycle
and the `agent_message` task/status/result records that carry each lane's
assignment and outcome.

The implementation lives in `spectro-orchestrator`; `Spectro.panel()` finds
it through a ServiceLoader hook, so the dependency block is the only wiring:

```kotlin
implementation("dev.spectroscope:spectro-core:0.12.0")
implementation("dev.spectroscope:spectro-orchestrator:0.12.0")
```

## Build and run (offline)

```bash
./gradlew build
./gradlew run
```

This main needs no key and no network: each lane runs on a scripted
provider (`ScriptedProvider.java`, ~40 lines in this directory) that
answers with a fixed text. The fleet mechanics are real — lanes, merged
stream, task and result messages; only the model is canned.

## Real models

A lane takes any `LlmProvider`, and lanes without their own model inherit
the panel default. Local, no key:

```java
var local = new OllamaProvider(new OllamaOptions("http://localhost:11434", "qwen3"));
var panel = Spectro.panel().model(local);
```

Cloud (needs `ANTHROPIC_API_KEY`):

```java
var panel = Spectro.panel().model(Anthropic.opus());
```

Mixing works too — one lane on a local model, another on a cloud tier; each
lane's `run_start` records which provider and model answered it.
