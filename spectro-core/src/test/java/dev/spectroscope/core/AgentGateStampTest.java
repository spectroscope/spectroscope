package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 399: the loop asks the broker who answers a gated call BEFORE it emits
 * the {@code permission_request}, and stamps the event with that answer. A
 * browser reading the stamp does not open a window for a call that is already
 * decided. Both events still go out, in the same order, and {@code decide}
 * is still the one call that yields the verdict.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentGateStampTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Pops one scripted turn per stream() call. */
    private static final class Scripted implements LlmProvider {
        private final Deque<List<ProviderEvent>> turns = new ArrayDeque<>();

        @SafeVarargs
        Scripted(List<ProviderEvent>... scripted) {
            turns.addAll(List.of(scripted));
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (turns.isEmpty()) {
                throw new IllegalStateException("provider asked for more turns than scripted");
            }
            return turns.poll();
        }
    }

    /** A gated tool that records every input it ran with. */
    private static final class Guarded implements Tool {
        final List<JsonNode> ran = new ArrayList<>();

        public String name() { return "echo"; }
        public String description() { return "echoes"; }
        public JsonNode inputSchema() { return JSON.createObjectNode(); }
        public boolean needsPermission() { return true; }

        public String execute(JsonNode input, ToolContext context) {
            ran.add(input);
            return "ran";
        }
    }

    /** A broker that says in advance who answers, and records what it was handed. */
    private static final class Knowing implements PermissionBroker {
        private final String label;
        private final boolean verdict;
        final List<PermissionRequest> consulted = new ArrayList<>();
        final List<PermissionRequest> decided = new ArrayList<>();

        Knowing(String label, boolean verdict) {
            this.label = label;
            this.verdict = verdict;
        }

        @Override
        public String decidedBy(PermissionRequest request) {
            consulted.add(request);
            return label;
        }

        @Override
        public boolean decide(PermissionRequest request) {
            decided.add(request);
            return verdict;
        }
    }

    private static List<RunEvent> run(PermissionBroker broker, Guarded tool) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool);
        Agent agent = new Agent(AgentOptions.builder()
                .provider(new Scripted(
                        List.of(new LlmProvider.PToolCall("c1", "echo", JSON.createObjectNode().put("v", 1)),
                                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                        List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN))))
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(broker)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static List<PermissionRequest> requests(List<RunEvent> events) {
        return events.stream()
                .filter(PermissionRequest.class::isInstance)
                .map(PermissionRequest.class::cast)
                .toList();
    }

    /** The gate's two events, as the type names the wire uses, in stream order. */
    private static List<String> gatePair(List<RunEvent> events) {
        return events.stream()
                .filter(e -> e instanceof PermissionRequest || e instanceof RunEvent.PermissionDecision)
                .map(e -> e instanceof PermissionRequest ? "permission_request" : "permission_decision")
                .toList();
    }

    @Test
    void aBrokerThatKnowsTheAnswerStampsTheRequestBeforeItGoesOut() {
        Knowing broker = new Knowing("mode:auto", true);
        Guarded tool = new Guarded();

        List<RunEvent> events = run(broker, tool);

        assertEquals(List.of("mode:auto"),
                requests(events).stream().map(PermissionRequest::decidedBy).toList(),
                "the event on the stream carries the broker's early answer");
        assertEquals(1, broker.consulted.size(), "the broker was asked once who decides");
        assertNull(broker.consulted.getFirst().decidedBy(), "and it was asked with an unstamped request");
        assertEquals(List.of("mode:auto"),
                broker.decided.stream().map(PermissionRequest::decidedBy).toList(),
                "decide receives the same stamped request that went out");
        assertEquals(List.of("permission_request", "permission_decision"), gatePair(events),
                "both events still go out, request first");
        assertEquals(1, tool.ran.size(), "the verdict still comes from decide, and it allowed the call");
    }

    @Test
    void aStampedDenialStillKeepsTheToolFromRunning() {
        Knowing broker = new Knowing("mode:readonly", false);
        Guarded tool = new Guarded();

        List<RunEvent> events = run(broker, tool);

        assertEquals("mode:readonly", requests(events).getFirst().decidedBy());
        assertEquals(List.of("permission_request", "permission_decision"), gatePair(events));
        assertTrue(tool.ran.isEmpty(), "a denied call never executes, stamped or not");
    }

    @Test
    void aBrokerThatKnowsNothingSendsTheRequestUnstamped() {
        List<PermissionRequest> decided = new ArrayList<>();
        Guarded tool = new Guarded();

        List<RunEvent> events = run(request -> {
            decided.add(request);
            return true;
        }, tool);

        assertEquals(1, requests(events).size());
        assertNull(requests(events).getFirst().decidedBy(), "a plain broker leaves the request a real ask");
        assertEquals(1, decided.size(), "and decide is asked exactly once, as before");
        assertEquals(1, tool.ran.size());
    }

    @Test
    void aBrokerWhoseEarlyAnswerThrowsStillAsksAndStillGates() {
        List<PermissionRequest> decided = new ArrayList<>();
        Guarded tool = new Guarded();
        PermissionBroker broken = new PermissionBroker() {
            @Override
            public String decidedBy(PermissionRequest request) {
                throw new IllegalStateException("no early answer today");
            }

            @Override
            public boolean decide(PermissionRequest request) {
                decided.add(request);
                return false;
            }
        };

        List<RunEvent> events = run(broken, tool);

        assertNull(requests(events).getFirst().decidedBy(), "a failed early answer is no answer");
        assertEquals(1, decided.size(), "the gate is still asked");
        assertEquals(List.of("permission_request", "permission_decision"), gatePair(events));
        assertTrue(tool.ran.isEmpty(), "and its denial still holds");
    }
}
