package dev.spectroscope.samples.lc4j;

import dev.langchain4j.model.ollama.OllamaChatModel;
import dev.spectroscope.Spectro;
import dev.spectroscope.core.events.RunEvent;

import java.nio.file.Path;

/**
 * A spectroscope agent whose model is served by LangChain4j. Needs a local
 * Ollama on {@code localhost:11434}; {@code OLLAMA_MODEL=<name>} overrides
 * the model (default {@code qwen3}).
 */
public final class Lc4jDemo {

    public static void main(String[] args) {
        var lc4jModel = OllamaChatModel.builder()
                .baseUrl("http://localhost:11434")
                .modelName(System.getenv().getOrDefault("OLLAMA_MODEL", "qwen3"))
                .build();

        var agent = Spectro.agent()
                .model(new LangChain4jProvider(lc4jModel, "langchain4j-ollama"))
                .tools()   // empty belt: this bridge does not advertise tools
                .workspace(Path.of(System.getProperty("java.io.tmpdir"), "spectro-lc4j-sample"));

        for (RunEvent event : agent.run("In one sentence: what does a spectroscope do?")) {
            System.out.println(event);
        }
    }
}
