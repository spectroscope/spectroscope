package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 490 against a real model server, run by hand. The parent is scripted
 * to ask for four explore helpers at once in a chat at 3; the helpers talk to
 * the model named by {@value #MODEL_ENV} on the Ollama server named by
 * {@value #URL_ENV}. It records when each helper's model request opens and
 * closes, and how many were open at once, into the file named by
 * {@value #OUT_ENV}.
 *
 * <p>Skipped unless {@value #MODEL_ENV} is set, so the gate never depends on
 * a model server.</p>
 */
@EnabledIfEnvironmentVariable(named = SessionSlotPoolLiveTest.MODEL_ENV, matches = ".+")
@Timeout(value = 30, unit = TimeUnit.MINUTES, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionSlotPoolLiveTest {

    static final String MODEL_ENV = "SPECTRO_LIVE_MODEL";
    static final String URL_ENV = "SPECTRO_LIVE_OLLAMA_URL";
    static final String OUT_ENV = "SPECTRO_LIVE_OUT";

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Scripted parent, real helpers; every helper request is timed. */
    private static final class Router implements LlmProvider {
        final LlmProvider real;
        final List<List<ProviderEvent>> parentTurns = new CopyOnWriteArrayList<>();
        final AtomicInteger open = new AtomicInteger();
        final AtomicInteger maxOpen = new AtomicInteger();
        final List<String> timeline = new CopyOnWriteArrayList<>();
        final long t0 = System.currentTimeMillis();

        Router(LlmProvider real) {
            this.real = real;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!request.system().contains("subagent")) {
                return parentTurns.remove(0);
            }
            String task = request.messages().getFirst().content().stream()
                    .filter(TextContent.class::isInstance).map(c -> ((TextContent) c).text())
                    .findFirst().orElse("?");
            String tag = task.substring(0, Math.min(task.length(), 12));
            int now = open.incrementAndGet();
            maxOpen.accumulateAndGet(now, Math::max);
            timeline.add(String.format("%7d ms open  %s (open now %d)",
                    System.currentTimeMillis() - t0, tag, now));
            List<ProviderEvent> events = new ArrayList<>();
            try {
                for (ProviderEvent event : real.stream(request)) {
                    events.add(event);
                }
            } finally {
                int left = open.decrementAndGet();
                timeline.add(String.format("%7d ms close %s (open now %d)",
                        System.currentTimeMillis() - t0, tag, left));
            }
            return events;
        }
    }

    @Test
    void aChatAtThreeRunsFourHelpersTwoAtATimeOnARealModel() throws IOException {
        String model = System.getenv(MODEL_ENV);
        String url = System.getenv().getOrDefault(URL_ENV, "http://localhost:11434");
        Router router = new Router(new OllamaProvider(new OllamaOptions(url, model)));
        StringBuilder agents = new StringBuilder();
        for (int i = 1; i <= 4; i++) {
            agents.append(i == 1 ? "" : ",").append("{\"type\":\"explore\",\"task\":\"helper ")
                    .append(i).append(": reply with the single word ready and nothing else\"}");
        }
        router.parentTurns.add(List.of(
                new LlmProvider.PToolCall("c1", "spawn_agents", JSON.readTree("{\"agents\":[" + agents + "]}")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        router.parentTurns.add(List.of(new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(router)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .sessionsPerChat(3)
                .build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(router)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .sessionsPerChat(3)
                .build());

        List<RunEvent> events = new ArrayList<>();
        long started = System.currentTimeMillis();
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        long wallMs = System.currentTimeMillis() - started;

        Map<String, String> task = new ConcurrentHashMap<>();
        List<String> lines = new ArrayList<>();
        for (RunEvent event : events) {
            if (event instanceof RunEvent.AgentSpawn spawn) {
                task.put(spawn.agentId(), spawn.task());
            }
            if (event instanceof RunEvent.AgentMessage message && !"task".equals(message.role())) {
                lines.add(message.from() + " " + message.role() + "/" + message.state() + ": "
                        + message.text().replace('\n', ' '));
            }
        }
        long waiting = events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                .map(RunEvent.AgentMessage.class::cast)
                .filter(m -> "status".equals(m.role()) && "submitted".equals(m.state())).count();
        long completed = events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                .map(RunEvent.AgentMessage.class::cast)
                .filter(m -> "result".equals(m.role()) && "completed".equals(m.state())).count();

        StringBuilder out = new StringBuilder();
        out.append("model ").append(model).append(" at ").append(url).append('\n');
        out.append("sessionsPerChat 3, four explore helpers asked for in one spawn_agents call\n");
        out.append("wall clock ").append(wallMs).append(" ms, max helper requests open at once ")
                .append(router.maxOpen.get()).append(", waiting notices ").append(waiting)
                .append(", completed results ").append(completed).append("\n\n");
        router.timeline.forEach(line -> out.append(line).append('\n'));
        out.append('\n');
        Map<String, int[]> chars = new java.util.TreeMap<>();
        for (RunEvent event : events) {
            if (event instanceof RunEvent.TextDelta delta) {
                chars.computeIfAbsent(delta.agentId(), k -> new int[3])[0] += delta.text().length();
            } else if (event instanceof RunEvent.ThinkingDelta delta) {
                chars.computeIfAbsent(delta.agentId(), k -> new int[3])[1] += delta.text().length();
            } else if (event instanceof RunEvent.RunEnd end) {
                out.append("run_end ").append(end.runId()).append(" ").append(end.stopReason()).append('\n');
            }
        }
        chars.forEach((agent, c) -> out.append(agent).append(": text chars ").append(c[0])
                .append(", thinking chars ").append(c[1]).append('\n'));
        out.append('\n');
        lines.forEach(line -> out.append(line).append('\n'));
        String target = System.getenv(OUT_ENV);
        if (target != null && !target.isBlank()) {
            Files.writeString(Path.of(target), out.toString());
        }
        System.out.println(out);

        assertTrue(router.maxOpen.get() <= 2, "more than two helpers were at the model at once");
        assertEquals(2, waiting, "the chat did not show two helpers waiting");
        // Every helper reaches the model and reports back. Whether its answer
        // has text is the model's business: on 2026-10-09 this model returned
        // an empty answer for 4 of 16 helpers over four runs, waiting or not.
        assertEquals(4, router.timeline.stream().filter(line -> line.contains(" open ")).count(),
                "not every helper reached the model");
        long results = events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                .map(RunEvent.AgentMessage.class::cast).filter(m -> "result".equals(m.role())).count();
        assertEquals(4, results, "not every helper reported back: " + lines);
    }
}
