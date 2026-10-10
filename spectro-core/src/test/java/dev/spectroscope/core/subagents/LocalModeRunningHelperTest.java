package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.ToolGroup;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 493, criterion 9: a helper already running keeps its slot and its
 * tool list when the Local mode switch changes.
 *
 * <p>The switch reaches a chat through three seams of the parent agent: its
 * session count ({@link Agent#setSessionsPerChat}), the tool groups reader
 * the session hands it, and its read share ({@link Agent#setReadSharePercent}).
 * Here all three move while a helper is inside its run, the way switching
 * Local mode on moves them. The helper's next request carries the tools and
 * the read share its first one carried, and it keeps its slot.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class LocalModeRunningHelperTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The parent spawns one helper; the helper lists a folder, waits at its
     *  gate, and answers. Records each helper request's tools. */
    private static final class Provider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final List<List<ToolSpec>> helperTools = new CopyOnWriteArrayList<>();
        final CountDownLatch gate = new CountDownLatch(1);

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!request.system().contains("subagent")) {
                List<ProviderEvent> turn = parentTurns.poll();
                if (turn == null) {
                    throw new IllegalStateException("no scripted parent turn left");
                }
                return turn;
            }
            helperTools.add(request.tools());
            if (helperTools.size() == 1) {
                return List.of(new PToolCall("h1", "list_dir", JSON.createObjectNode().put("path", ".")),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            try {
                gate.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return List.of(new PTextDelta("done"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static void await(String what, BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > deadline) {
                throw new AssertionError("timed out waiting until " + what);
            }
            Thread.sleep(10);
        }
    }

    private static List<String> names(List<LlmProvider.ToolSpec> specs) {
        return specs.stream().map(LlmProvider.ToolSpec::name).toList();
    }

    private static String readFileDescription(List<LlmProvider.ToolSpec> specs) {
        return specs.stream().filter(spec -> spec.name().equals("read_file")).findFirst()
                .orElseThrow().description();
    }

    @Test
    void aHelperInItsRunKeepsItsSlotItsToolsAndItsReadShareWhenTheSwitchGoesOn() throws Exception {
        Provider provider = new Provider();
        provider.parentTurns.add(List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                        JSON.readTree("{\"type\":\"worker\",\"task\":\"look around\"}")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        provider.parentTurns.add(List.of(new LlmProvider.PTextDelta("reported"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        AtomicReference<Set<ToolGroup>> groups = new AtomicReference<>(Set.of());
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(StandardTools.all(10))
                .toolGroupsOff(groups::get)
                .sessionsPerChat(4)
                .build());
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all(10).forEach(registry::register);
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .toolGroupsOff(groups::get)
                .sessionsPerChat(4)
                .build());
        List<RunEvent> events = new CopyOnWriteArrayList<>();
        EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null));
        Thread drain = Thread.ofVirtual().start(() -> {
            try (stream) {
                stream.forEach(events::add);
            }
        });

        await("the helper is inside its second request", () -> provider.helperTools.size() == 2);
        assertEquals(1, manager.slotsInUse(), "premise: the helper holds a slot");
        assertTrue(names(provider.helperTools.get(0)).contains("view_image"),
                "premise: the images group is on when the helper starts");

        // What switching Local mode on does to the chat, through the same seams.
        groups.set(Set.of(ToolGroup.BROWSER, ToolGroup.LAUNCH, ToolGroup.IMAGES, ToolGroup.ROLES));
        parent.setSessionsPerChat(2);
        parent.setReadSharePercent(10);
        assertEquals(1, manager.slotsInUse(), "the switch took the running helper's slot away");

        provider.gate.countDown();
        drain.join(10_000);

        assertEquals(2, provider.helperTools.size(), "premise: two helper requests");
        assertEquals(names(provider.helperTools.get(0)), names(provider.helperTools.get(1)),
                "the running helper's tool list changed under it");
        assertTrue(readFileDescription(provider.helperTools.get(1)).contains("fits 25 %"),
                "the running helper's read share changed under it");
        assertTrue(events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                        .map(RunEvent.AgentMessage.class::cast)
                        .anyMatch(message -> "result".equals(message.role())
                                && "completed".equals(message.state())),
                "the helper did not complete: " + events);
    }

    /** A helper spawned during a run takes the read share that run read when
     *  it started: not the session's config value, and not a value set while
     *  the run goes on. */
    @Test
    void aHelperSpawnedDuringARunReadsWithTheShareOfThatRun() throws Exception {
        Provider provider = new Provider();
        provider.gate.countDown();
        AtomicReference<Agent> parentRef = new AtomicReference<>();
        Queue<List<LlmProvider.ProviderEvent>> turns = provider.parentTurns;
        turns.add(List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                        JSON.readTree("{\"type\":\"worker\",\"task\":\"look around\"}")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        turns.add(List.of(new LlmProvider.PTextDelta("reported"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        LlmProvider switching = request -> {
            if (!request.system().contains("subagent") && turns.size() == 2) {
                parentRef.get().setReadSharePercent(10); // the switch, during the parent's run
            }
            return provider.stream(request);
        };
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(switching)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(StandardTools.all(10))
                .readSharePercent(40)
                .build());
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all(10).forEach(registry::register);
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(switching)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .readSharePercent(20)
                .build());
        parentRef.set(parent);
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }
        assertTrue(readFileDescription(provider.helperTools.get(0)).contains("fits 20 %"),
                "the helper did not read with its parent run's share: "
                        + readFileDescription(provider.helperTools.get(0)));
    }
}
