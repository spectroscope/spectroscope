# 08 — a LangChain4j model as the agent's provider

`Spectro.agent().model(...)` takes the public `LlmProvider` interface, not
a fixed provider list. That makes third-party model catalogues one adapter
away — this sample bridges **LangChain4j**, so every chat model LangChain4j
integrates (Ollama here; OpenAI, Mistral, Bedrock and the rest work the
same way) can serve a spectroscope agent.

`LangChain4jProvider.java` is the whole bridge:

```java
var lc4jModel = OllamaChatModel.builder()
        .baseUrl("http://localhost:11434")
        .modelName("qwen3")
        .build();

var agent = Spectro.agent()
        .model(new LangChain4jProvider(lc4jModel, "langchain4j-ollama"))
        .tools()   // empty belt — see the honest scope below
        .workspace(...);
```

It maps the system prompt and the text history into LangChain4j's message
types, makes one `ChatModel.chat(...)` call per turn, and emits the answer,
the token usage and the stop reason as provider events. The event stream,
the recording tee from sample 03, the OTel export from sample 05 — all of
it works unchanged, because the loop never knows which SDK answered.

## Honest scope

This is a **text bridge**. It does not advertise spectroscope's tools to
the LangChain4j model, which is why the demo constructs the agent with an
empty tool belt. Tool calling across two frameworks' schema dialects is
real work, not an afterthought — for tool-running agents, use
spectroscope's native providers (`Anthropic.…`, `OllamaProvider`, or the
OpenAI-compatible provider).

## Build and run

```bash
gradle build                     # no services needed

ollama pull qwen3                # any chat model works
gradle run                       # needs Ollama on localhost:11434
OLLAMA_MODEL=<name> gradle run   # pick a different model
```

The `run_start` event records `provider=langchain4j-ollama` — the label
the adapter reports — and the `usage` event carries the real token counts
LangChain4j returned.
