package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 487, second pass: the loads of the bare pass driven through one chat.
 *
 * <p>The parent is scripted and never calls the model; it asks for n explore
 * helpers in one {@code spawn_agents} call. "At once" gives the chat a count
 * of n + 1, so all n helpers hold a slot of card 490's pool together; "one
 * after another" gives it the floor 2, so the pool lets one helper at a time
 * through. Every helper gets the bare pass's prompt as its task and the same
 * completion limit. By default the helpers carry no base tools, only the
 * {@code report_status} every helper has, so a helper spends fewer requests on
 * tools; a helper still often calls {@code report_status} first, so a cell
 * makes n or more requests. {@value #TOOLS_ENV} set to {@code standard} gives
 * them the standard tools instead. The router times each helper request on the
 * client side: when it opens, when its first text arrives, when it closes, the
 * token counts the server reports, and which turn of its helper it is (1 for
 * the first request, one more for each assistant message the request
 * carries).</p>
 *
 * <p>Writes the cells as JSON to the file named by {@value #OUT_ENV}, in the
 * shape {@code kanban/evidence/487/concurrency.py --mark} reads. Skipped
 * unless {@value #MODEL_ENV} is set, so the gate never depends on a model
 * server. Local runs use {@code qwen2.5:7b} on Ollama.</p>
 */
@EnabledIfEnvironmentVariable(named = ChatConcurrencyLiveTest.MODEL_ENV, matches = ".+")
@Timeout(value = 60, unit = TimeUnit.MINUTES, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ChatConcurrencyLiveTest {

    static final String MODEL_ENV = "SPECTRO_CONCURRENCY_MODEL";
    static final String URL_ENV = "SPECTRO_CONCURRENCY_OLLAMA_URL";
    static final String OUT_ENV = "SPECTRO_CONCURRENCY_OUT";
    static final String ROUNDS_ENV = "SPECTRO_CONCURRENCY_ROUNDS";
    static final String NUM_PREDICT_ENV = "SPECTRO_CONCURRENCY_NUM_PREDICT";
    static final String TOOLS_ENV = "SPECTRO_CONCURRENCY_TOOLS";

    /** The bare pass's prompt, word for word ({@code concurrency.py}, PROMPT). */
    static final String PROMPT = "Write the whole numbers from one to one thousand in English words, "
            + "separated by commas. Do not stop early and do not add anything else.";

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One helper request as the client saw it. */
    private record Exchange(long sentNanos, long firstNanos, long doneNanos, int inputTokens, int outputTokens,
                            int helperTurn) {}

    /** Scripted parent, real helpers; every helper request is timed. */
    private static final class Router implements LlmProvider {
        final LlmProvider real;
        final List<List<ProviderEvent>> parentTurns = new CopyOnWriteArrayList<>();
        final List<Exchange> exchanges = new CopyOnWriteArrayList<>();
        final AtomicInteger open = new AtomicInteger();
        final AtomicInteger maxOpen = new AtomicInteger();

        Router(LlmProvider real) {
            this.real = real;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!request.system().contains("subagent")) {
                return parentTurns.remove(0);
            }
            maxOpen.accumulateAndGet(open.incrementAndGet(), Math::max);
            int turn = 1 + (int) request.messages().stream()
                    .filter(m -> m.role() == ProviderMessage.Role.ASSISTANT).count();
            long sent = System.nanoTime();
            long first = -1;
            int in = 0;
            int out = 0;
            List<ProviderEvent> events = new ArrayList<>();
            try {
                for (ProviderEvent event : real.stream(request)) {
                    if (first < 0 && event instanceof PTextDelta delta && !delta.text().isEmpty()) {
                        first = System.nanoTime();
                    }
                    if (event instanceof PUsage usage) {
                        in += usage.inputTokens();
                        out += usage.outputTokens();
                    }
                    events.add(event);
                }
            } finally {
                open.decrementAndGet();
            }
            exchanges.add(new Exchange(sent, first, System.nanoTime(), in, out, turn));
            return events;
        }
    }

    @Test
    void oneChatPutsOneTwoAndThreeHelperRequestsOnTheModel() throws IOException {
        String model = System.getenv(MODEL_ENV);
        String url = System.getenv().getOrDefault(URL_ENV, "http://localhost:11434");
        int rounds = Integer.parseInt(System.getenv().getOrDefault(ROUNDS_ENV, "3"));
        int numPredict = Integer.parseInt(System.getenv().getOrDefault(NUM_PREDICT_ENV, "256"));
        Path cwd = Files.createTempDirectory("card487");
        boolean standardTools = "standard".equals(System.getenv(TOOLS_ENV));

        ObjectNode root = JSON.createObjectNode();
        ObjectNode meta = root.putObject("meta");
        meta.put("url", url).put("model", model).put("num_predict", numPredict).put("prompt", PROMPT)
                .put("rounds", rounds).put("pass", "harness: scripted parent, explore helpers, card 490 pool")
                .put("base_tools", standardTools ? "standard" : "none");
        ArrayNode cells = root.putArray("cells");

        for (int round = 1; round <= rounds; round++) {
            for (int n = 1; n <= 3; n++) {
                boolean[] order = (round - 1 + n) % 2 == 0 ? new boolean[] {false, true} : new boolean[] {true, false};
                for (boolean atOnce : order) {
                    ObjectNode cell = runCell(url, model, numPredict, n, atOnce, cwd, standardTools);
                    cell.put("round", round);
                    cells.add(cell);
                    // The pool lets exactly n helpers to the model at once, or one at a time.
                    assertEquals(atOnce ? n : 1, cell.get("most_open_at_once").asInt(),
                            "helper requests open at once, n=" + n + " " + cell.get("mode").asText());
                    assertEquals(n, cell.get("helpers_reported_back").asInt(), "not every helper reported back");
                    assertEquals(n, firstRequests(cell), "each helper opens exactly one first request, n=" + n
                            + " " + cell.get("mode").asText());
                    System.out.printf("round %d n=%d %-17s wall %.2fs requests %d%n", round, n,
                            cell.get("mode").asText(), cell.get("wall_seconds").asDouble(),
                            cell.get("requests").size());
                }
            }
        }
        String target = System.getenv(OUT_ENV);
        if (target != null && !target.isBlank()) {
            Files.writeString(Path.of(target), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(root));
        }
        assertEquals(rounds * 6, cells.size(), "not every cell ran");
    }

    /** Requests of a cell that are a helper's first turn ({@code helper_turn} 1). */
    private static long firstRequests(ObjectNode cell) {
        long first = 0;
        for (var r : cell.get("requests")) {
            if (r.path("helper_turn").asInt() == 1) {
                first++;
            }
        }
        return first;
    }

    private ObjectNode runCell(String url, String model, int numPredict, int n, boolean atOnce, Path cwd,
                               boolean standardTools) throws IOException {
        int count = atOnce ? n + 1 : SessionCount.floor();
        Router router = new Router(new OllamaProvider(new OllamaOptions(url, model)));
        ArrayNode agents = JSON.createArrayNode();
        for (int i = 0; i < n; i++) {
            agents.addObject().put("type", "explore").put("task", PROMPT);
        }
        ObjectNode input = JSON.createObjectNode();
        input.set("agents", agents);
        router.parentTurns.add(List.of(
                new LlmProvider.PToolCall("c1", "spawn_agents", input),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        router.parentTurns.add(List.of(new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(router)
                .cwd(cwd)
                .parentAgentId("main")
                .onPermission(request -> false)
                .baseTools(standardTools ? StandardTools.all() : List.of())
                .maxTokens(numPredict)
                .sessionsPerChat(count)
                .build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(router)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> false)
                .maxTokens(numPredict)
                .sessionsPerChat(count)
                .build());

        List<RunEvent> events = new ArrayList<>();
        double epochStart = System.currentTimeMillis() / 1000.0;
        long started = System.nanoTime();
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        long ended = System.nanoTime();
        double wall = (ended - started) / 1e9;

        long results = events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                .map(RunEvent.AgentMessage.class::cast).filter(m -> "result".equals(m.role())).count();
        ObjectNode cell = JSON.createObjectNode();
        cell.put("n", n).put("mode", atOnce ? "at once" : "one after another")
                .put("sessions_per_chat", count).put("helpers_reported_back", results)
                .put("epoch_start", epochStart).put("epoch_end", epochStart + wall)
                .put("wall_seconds", wall);
        cell.put("most_open_at_once", router.maxOpen.get());
        ArrayNode requests = cell.putArray("requests");
        for (Exchange e : router.exchanges) {
            double seconds = (e.doneNanos() - e.sentNanos()) / 1e9;
            ObjectNode r = requests.addObject();
            r.put("offset_seconds", (e.sentNanos() - started) / 1e9);
            r.put("seconds", seconds);
            if (e.firstNanos() >= 0) {
                r.put("ttft_seconds", (e.firstNanos() - e.sentNanos()) / 1e9);
            } else {
                r.putNull("ttft_seconds");
            }
            r.put("prompt_tokens", e.inputTokens());
            r.put("output_tokens", e.outputTokens());
            r.put("tokens_per_second", e.outputTokens() / seconds);
            r.put("helper_turn", e.helperTurn());
        }
        return cell;
    }
}
