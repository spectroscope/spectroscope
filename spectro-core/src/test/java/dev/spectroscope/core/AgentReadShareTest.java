package dev.spectroscope.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 493 at the loop: the agent reads its read share once when a run
 * starts. The run's {@code read_file} description names that share, the
 * tool judges a whole read against it, and a change between runs reaches
 * the next run only.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class AgentReadShareTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Reads big.txt whole once, then ends. Records each request's read_file
     *  description and each tool result the model is handed. */
    private static final class ReadOnce implements LlmProvider {
        final List<String> descriptions = new CopyOnWriteArrayList<>();
        final List<String> results = new CopyOnWriteArrayList<>();
        Consumer<Integer> onRequest = n -> { };
        private int turn;

        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            request.tools().stream().filter(t -> t.name().equals("read_file"))
                    .findFirst().ifPresent(t -> descriptions.add(t.description()));
            request.messages().forEach(message -> message.content().forEach(block -> {
                if (block instanceof ToolResultContent result) {
                    results.add(result.output());
                }
            }));
            onRequest.accept(descriptions.size());
            return turn++ % 2 == 0
                    ? List.of(new PToolCall("c" + turn, "read_file",
                            JSON.createObjectNode().put("path", "big.txt")),
                            new PStop(PStop.StopReason.TOOL_USE))
                    : List.of(new PTextDelta("done"), new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public int contextWindow() {
            return 10_000;
        }
    }

    private static Agent agent(LlmProvider provider, Path cwd, Integer share) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all(10).forEach(registry::register);
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> true)
                .readSharePercent(share)
                .build());
    }

    private static void run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("read it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
    }

    private static void bigFile(Path cwd) throws IOException {
        Files.writeString(cwd.resolve("big.txt"), "x".repeat(5_000));
    }

    @Test
    void unsetTheRunReadsAndDescribesAtTwentyFive(@TempDir Path cwd) throws IOException {
        bigFile(cwd);
        ReadOnce provider = new ReadOnce();
        run(agent(provider, cwd, null));
        assertTrue(provider.descriptions.get(0).contains("fits 25 %"), provider.descriptions.get(0));
        assertFalse(provider.results.get(0).startsWith("ERROR"), provider.results.get(0));
    }

    @Test
    void atTenTheRunDescribesTenAndRefusesTheWholeRead(@TempDir Path cwd) throws IOException {
        bigFile(cwd);
        ReadOnce provider = new ReadOnce();
        run(agent(provider, cwd, 10));
        for (String description : provider.descriptions) {
            assertTrue(description.contains("fits 10 %"), description);
        }
        assertTrue(provider.results.get(0).startsWith("ERROR: file too large to read at once"),
                provider.results.get(0));
        assertTrue(provider.results.get(0).contains("one read may take 10 %"), provider.results.get(0));
    }

    @Test
    void aChangeDuringARunReachesTheNextRunOnly(@TempDir Path cwd) throws IOException {
        bigFile(cwd);
        ReadOnce provider = new ReadOnce();
        Agent agent = agent(provider, cwd, 25);
        provider.onRequest = n -> {
            if (n == 1) {
                agent.setReadSharePercent(10);
            }
        };
        run(agent);
        assertEquals(2, provider.descriptions.size(), "premise: two requests in the first run");
        assertTrue(provider.descriptions.get(1).contains("fits 25 %"),
                "the description moved inside the run: " + provider.descriptions.get(1));
        assertFalse(provider.results.get(0).startsWith("ERROR"),
                "the read inside the run used the share set after it started: " + provider.results.get(0));
        provider.onRequest = n -> { };
        run(agent);
        assertTrue(provider.descriptions.get(2).contains("fits 10 %"),
                "the next run kept the old share: " + provider.descriptions.get(2));
        assertEquals(10, agent.readSharePercentThisRun());
    }
}
