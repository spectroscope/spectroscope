package dev.spectroscope.samples.fivelines;

import dev.spectroscope.Spectro;
import dev.spectroscope.Tools;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;

import java.nio.file.Path;

/**
 * The same five lines against a local Ollama server — no API key anywhere.
 * {@code .model()} takes any {@link dev.spectroscope.core.provider.LlmProvider};
 * swapping the backend is the one line that changes.
 *
 * <p>Prerequisite: Ollama on {@code localhost:11434} with a tool-capable
 * model pulled, e.g. {@code ollama pull qwen3}. Override the model with
 * {@code OLLAMA_MODEL=<name>}.</p>
 */
public final class FiveLinesLocal {

    public static void main(String[] args) {
        String model = System.getenv().getOrDefault("OLLAMA_MODEL", "qwen3");

        var agent = Spectro.agent()
                .model(new OllamaProvider(new OllamaOptions("http://localhost:11434", model)))
                .tools(Tools.readFile(), Tools.runCommand())
                .workspace(Path.of("/tmp/scratch"));

        for (RunEvent event : agent.run("Write hello.py and run it")) {
            System.out.println(event);
        }
    }
}
