package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.wire.LlmWireRecorder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 488 against a real Ollama: the {@code num_predict} each request of a
 * run sends, beside the {@code prompt_eval_count} the server reports for it.
 *
 * <p>Off unless {@code SPECTRO_LIVE_OLLAMA_MODEL} names a model. The model must
 * already be loaded with the window under test, so {@code /api/ps} reports it;
 * the base URL is {@code SPECTRO_LIVE_OLLAMA_URL}, else localhost. With
 * {@code SPECTRO_CAPTURE_DIR} set, one line per request is appended to
 * {@code live-ollama.tsv} there. The test asserts only that the run happened;
 * the numbers are the measurement.</p>
 */
@EnabledIfEnvironmentVariable(named = "SPECTRO_LIVE_OLLAMA_MODEL", matches = ".+")
@Timeout(value = 20, unit = TimeUnit.MINUTES, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CompletionBudgetLiveOllamaTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path dir;

    @Test
    void recordsTheCompletionBudgetAndTheInputOfEveryRequest() throws Exception {
        String model = System.getenv("SPECTRO_LIVE_OLLAMA_MODEL");
        String url = System.getenv().getOrDefault("SPECTRO_LIVE_OLLAMA_URL", "http://localhost:11434");
        OllamaProvider provider = new OllamaProvider(new OllamaOptions(url, model));
        int window = provider.contextWindow();
        assertTrue(window > 0, "premise: the model is loaded and /api/ps reports its window");

        ToolRegistry registry = new ToolRegistry();
        registry.register(new Tool() {
            public String name() { return "echo"; }
            public String description() { return "Returns the value it is given."; }
            public JsonNode inputSchema() {
                var schema = JSON.createObjectNode().put("type", "object");
                schema.putObject("properties").putObject("value").put("type", "string");
                schema.putArray("required").add("value");
                return schema;
            }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) {
                return input.path("value").asText();
            }
        });
        Path sidecar = dir.resolve("session.llm.jsonl");
        List<RunEvent> events = new ArrayList<>();
        try (LlmWireRecorder recorder = new LlmWireRecorder(sidecar, LlmWireRecorder.DEFAULT_CEILING_BYTES)) {
            Agent agent = new Agent(AgentOptions.builder()
                    .provider(provider)
                    .systemPrompt("You are a careful assistant. Use the tools you are given.")
                    .registry(registry)
                    .cwd(dir)
                    .agentId("main")
                    .onPermission(request -> true)
                    .llmWire(recorder)
                    .maxTurns(4)
                    .build());
            agent.setReasoning(LlmProvider.ProviderRequest.Reasoning.OFF, null);
            try (EventStream stream = agent.run("Call the echo tool once with the value 'one',"
                            + " then reply with the single word done.",
                    new RunOptions(new CancelSignal(), List.of()))) {
                stream.forEach(events::add);
            }
        }

        List<Integer> sent = new ArrayList<>();
        for (String line : Files.readAllLines(sidecar)) {
            JsonNode node = JSON.readTree(line);
            if ("llm_request".equals(node.path("type").asText())) {
                sent.add(JSON.readTree(node.path("body").asText()).path("options").path("num_predict").asInt(-1));
            }
        }
        List<Integer> input = events.stream().filter(RunEvent.Usage.class::isInstance)
                .map(e -> ((RunEvent.Usage) e).inputTokens()).toList();
        assertFalse(sent.isEmpty(), "premise: at least one request went out");

        List<String> lines = new ArrayList<>();
        for (int i = 0; i < sent.size(); i++) {
            Integer in = i < input.size() ? input.get(i) : null;
            boolean over = in != null && in + sent.get(i) > window;
            lines.add(String.join("\t", model, String.valueOf(window), String.valueOf(i + 1),
                    String.valueOf(sent.get(i)), String.valueOf(in), String.valueOf(over)));
        }
        String target = System.getenv("SPECTRO_CAPTURE_DIR");
        if (target != null && !target.isBlank()) {
            Files.createDirectories(Path.of(target));
            Files.write(Path.of(target).resolve("live-ollama.tsv"), lines,
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        }
    }
}
