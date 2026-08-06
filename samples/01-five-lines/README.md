# 01 — the five lines

The frozen facade, exactly as documented: one agent, one provider, a tool
belt, a workspace, and a for-loop over the typed event stream.

```java
var agent = Spectro.agent()
        .model(Anthropic.opus())
        .tools(Tools.readFile(), Tools.runCommand())
        .workspace(Path.of("/tmp/scratch"));

for (RunEvent event : agent.run("Write hello.py and run it")) {
    System.out.println(event);   // the stream IS the observability
}
```

Every event the agent produces — `run_start`, `text_delta`, `tool_call`,
`tool_result`, `usage`, `run_end` — arrives in that loop as a plain Java
record. There is no callback API and no subscription object; the for-loop
is the whole consumption model.

## Build

```bash
./gradlew build
```

The dependency is `dev.spectroscope:spectro-core:0.4.1` from Maven Central.
Java 21 or newer.

## Run (cloud)

`FiveLines` uses `Anthropic.opus()` and needs a key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./gradlew run
```

The key can also live in `~/.spectro/.env`; the provider reads it when the
first request streams, so building and constructing stay offline.

## Run (local, no key)

`.model()` accepts any `LlmProvider`, so the key-free variant is the same
five lines with one line changed. `FiveLinesLocal` points at a local Ollama
server:

```java
.model(new OllamaProvider(new OllamaOptions("http://localhost:11434", "qwen3")))
```

```bash
ollama pull qwen3        # any tool-capable model works
./gradlew run -PmainClass=dev.spectroscope.samples.fivelines.FiveLinesLocal
```

`OLLAMA_MODEL=<name>` overrides the model. The verbatim class stays
untouched on purpose — the swap lives in its own file so you can diff the
two and see that the backend really is the only difference.

Note: the workspace is `/tmp/scratch`, as in the frozen snippet. On Windows,
change the path.
