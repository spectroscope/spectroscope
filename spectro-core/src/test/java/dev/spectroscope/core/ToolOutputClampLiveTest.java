package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import dev.spectroscope.core.tools.ReadBudget;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolOutput;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 489 on a real local model: the clamp on a tool result follows the
 * window the loop hands the tool, with the tool calls chosen by the model.
 *
 * <p><b>Off in the gate, on by hand.</b> It needs ollama on this machine, so it
 * runs only under {@code SPECTRO_LIVE=1}. The command behind the card's live
 * numbers:</p>
 *
 * <pre>
 * SPECTRO_LIVE=1 SPECTRO_LIVE_MODEL=qwen2.5:7b SPECTRO_LIVE_WINDOW=8192 \
 *   ./gradlew :spectro-core:test --rerun-tasks --no-build-cache \
 *   --tests 'dev.spectroscope.core.ToolOutputClampLiveTest' -i
 * </pre>
 *
 * <p>{@code SPECTRO_LIVE_WINDOW} is the window the provider declares to the
 * loop. The model itself keeps the window ollama loaded it with, which the
 * run prints as {@code served}; only the declared window decides the clamp.
 * {@code SPECTRO_LIVE_WINDOW=0} declares nothing, so the run takes the window
 * ollama reports for the loaded instance.</p>
 */
@EnabledIfEnvironmentVariable(named = "SPECTRO_LIVE", matches = "1")
@Timeout(value = 600, unit = TimeUnit.SECONDS)
class ToolOutputClampLiveTest {

    private static final String BASE = System.getenv().getOrDefault(
            "SPECTRO_LIVE_OLLAMA", "http://localhost:11434");

    private static final String MODEL = System.getenv().getOrDefault(
            "SPECTRO_LIVE_MODEL", "qwen2.5:7b");

    private static final int DECLARED_WINDOW = Integer.parseInt(System.getenv().getOrDefault(
            "SPECTRO_LIVE_WINDOW", "8192"));

    /** The real provider with the window the run declares in front of it. */
    private static final class DeclaredWindow implements LlmProvider {
        private final LlmProvider inner;
        private final int window;

        DeclaredWindow(LlmProvider inner, int window) {
            this.inner = inner;
            this.window = window;
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return inner.stream(request);
        }

        @Override public String modelName() {
            return inner.modelName();
        }

        @Override public String providerName() {
            return inner.providerName();
        }

        @Override public String endpoint() {
            return inner.endpoint();
        }

        @Override public Vision vision() {
            return inner.vision();
        }

        @Override public int contextWindow() {
            return window > 0 ? window : inner.contextWindow();
        }

        @Override public int publishedWindow() {
            return window > 0 ? 0 : inner.publishedWindow();
        }
    }

    private static String lines(String word, int count) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < count; i++) {
            out.append("a ").append(word).append(" on line ").append(i)
                    .append(" with some padding text\n");
        }
        return out.toString();
    }

    @Test
    void aRealModelsNoisyResultsStayInsideTheWindowShare(@TempDir Path cwd) throws Exception {
        Files.createDirectories(cwd.resolve("large"));
        Files.writeString(cwd.resolve("large/notes.txt"), lines("needle", 400));

        ToolRegistry registry = new ToolRegistry();
        for (Tool tool : StandardTools.all(30)) {
            if (tool.name().equals("grep") || tool.name().equals("run_command")) {
                registry.register(tool);
            }
        }
        OllamaProvider ollama = new OllamaProvider(new OllamaOptions(BASE, MODEL));
        LlmProvider provider = new DeclaredWindow(ollama, DECLARED_WINDOW);
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are a coding agent. Working directory: " + cwd
                        + ". Use the tools exactly as the user asks.")
                .registry(registry)
                .cwd(cwd)
                .agentId("main")
                .onPermission(request -> true)
                .providerName("ollama")
                .maxTurns(4)
                .build());

        String prompt = "Do these two steps, one tool call each, then answer with the word done."
                + " Step 1: call the grep tool with pattern \"needle\" and path \"large\"."
                + " Step 2: call the run_command tool with command"
                + " \"yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 20000\".";

        Map<String, String> names = new LinkedHashMap<>();
        List<RunEvent.ToolResult> results = new ArrayList<>();
        try (EventStream stream = agent.run(prompt, new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> {
                if (event instanceof RunEvent.ToolCall call) {
                    names.put(call.callId(), call.name());
                }
                if (event instanceof RunEvent.ToolResult result) {
                    results.add(result);
                }
            });
        }

        int window = provider.contextWindow();
        // The expected rule, written out here so a reverted rule in ToolOutput
        // cannot move the bound this test holds the results to.
        int bound = (int) Math.min(ToolOutput.MAX_OUTPUT_CHARS,
                ReadBudget.tokenAllowance(window) * ReadBudget.BYTES_PER_TOKEN);
        int served = ollama.contextWindow();
        for (RunEvent.ToolResult result : results) {
            System.out.println("clamp-live model=" + MODEL + " declared=" + DECLARED_WINDOW
                    + " window=" + window + " served=" + served + " bound=" + bound
                    + " tool=" + names.get(result.callId()) + " error=" + result.isError()
                    + " chars=" + result.output().length());
        }

        assertFalse(results.isEmpty(), "the model called no tool, so nothing was measured");
        // Both requested tools ran, so a run where the model skips one cannot
        // pass on the other alone.
        List<String> called = results.stream().map(result -> names.get(result.callId())).toList();
        assertTrue(called.contains("grep"), "the model never called grep: " + called);
        assertTrue(called.contains("run_command"), "the model never called run_command: " + called);
        for (RunEvent.ToolResult result : results) {
            assertTrue(result.output().length() <= bound, names.get(result.callId()) + " kept "
                    + result.output().length() + " characters on a window of " + window
                    + " tokens, over " + bound);
        }
        // The positive side: at least one result reached the bound exactly, so
        // the run cannot pass on results that were short to begin with.
        assertTrue(results.stream().anyMatch(result -> result.output().length() == bound),
                "no result reached the bound of " + bound + " characters");
    }
}
