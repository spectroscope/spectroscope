package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 490, criteria 3, 4 and 9: the chat's slot pool.
 *
 * <p>A chat at 3 holds three sessions: the main agent's and two for helpers.
 * Asked for four helpers at once it runs two and queues two, starts the
 * queued ones in the order they were asked for, shows each waiting helper as
 * waiting, and all four finish. A chat with no count starts all four at once,
 * as v0.14.4 did. A helper that already runs keeps its slot when the count
 * drops under it.</p>
 *
 * <p>Each helper's model request blocks on a gate the test opens, so which
 * helper is inside the model at any moment is decided here and not by the
 * scheduler. "Started" means the helper's first model request arrived.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionSlotPoolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Parent turns are scripted; a helper's turn waits for its gate. */
    private static final class GatedProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final List<String> started = new CopyOnWriteArrayList<>();
        final Map<String, CountDownLatch> gates = new ConcurrentHashMap<>();

        CountDownLatch gate(String task) {
            return gates.computeIfAbsent(task, t -> new CountDownLatch(1));
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!request.system().contains("subagent")) {
                List<ProviderEvent> turn = parentTurns.poll();
                if (turn == null) {
                    throw new IllegalStateException("no scripted parent turn left");
                }
                return turn;
            }
            String task = taskOf(request);
            started.add(task);
            CountDownLatch gate = gate(task);
            try {
                while (!gate.await(20, TimeUnit.MILLISECONDS)) {
                    if (request.signal() != null && request.signal().isCancelled()) {
                        return List.of(new PStop(PStop.StopReason.END_TURN));
                    }
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return List.of(new PTextDelta("done " + task), new PStop(PStop.StopReason.END_TURN));
        }

        private static String taskOf(ProviderRequest request) {
            for (ProviderMessage message : request.messages()) {
                for (ProviderContent content : message.content()) {
                    if (content instanceof TextContent text) {
                        return text.text().strip();
                    }
                }
            }
            return "?";
        }
    }

    private static List<LlmProvider.ProviderEvent> spawnFour() {
        try {
            return List.of(new LlmProvider.PToolCall("c1", "spawn_agents", JSON.readTree("""
                    {"agents":[{"type":"worker","task":"t1"},{"type":"worker","task":"t2"},
                               {"type":"worker","task":"t3"},{"type":"worker","task":"t4"}]}""")),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static List<LlmProvider.ProviderEvent> text(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    /** One chat: the manager, its parent, the events it emitted, and the run's signal. */
    private record Chat(SubagentManager manager, Agent parent, List<RunEvent> events,
                        CancelSignal signal, Thread drain) {

        /** The task each spawned helper was given, by its id. */
        Map<String, String> taskById() {
            Map<String, String> tasks = new ConcurrentHashMap<>();
            for (RunEvent event : events) {
                if (event instanceof RunEvent.AgentSpawn spawn) {
                    tasks.put(spawn.agentId(), spawn.task());
                }
            }
            return tasks;
        }

        /** The tasks of the helpers the chat showed as waiting for a slot. */
        List<String> waiting() {
            Map<String, String> tasks = taskById();
            List<String> out = new ArrayList<>();
            for (RunEvent event : events) {
                if (event instanceof RunEvent.AgentMessage message
                        && "status".equals(message.role()) && "submitted".equals(message.state())) {
                    out.add(tasks.get(message.from()));
                }
            }
            return out;
        }

        List<RunEvent.AgentMessage> results() {
            return events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                    .map(RunEvent.AgentMessage.class::cast)
                    .filter(message -> "result".equals(message.role())).toList();
        }
    }

    private static Chat start(GatedProvider provider, Integer sessionsPerChat) {
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .sessionsPerChat(sessionsPerChat)
                .build(), 30_000);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .sessionsPerChat(sessionsPerChat)
                .build());
        List<RunEvent> events = new CopyOnWriteArrayList<>();
        CancelSignal signal = new CancelSignal();
        EventStream stream = manager.run(parent, "go", new RunOptions(signal, null));
        Thread drain = Thread.ofVirtual().start(() -> {
            try (stream) {
                stream.forEach(events::add);
            }
        });
        return new Chat(manager, parent, events, signal, drain);
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

    /** A quiet spell in which nothing more may start. */
    private static void holdStill() throws InterruptedException {
        Thread.sleep(300);
    }

    @Test
    void aChatAtThreeRunsTwoHelpersQueuesTwoAndStartsThemInTheOrderAsked() throws Exception {
        GatedProvider provider = new GatedProvider();
        provider.parentTurns.add(spawnFour());
        provider.parentTurns.add(text("all four reported"));
        Chat chat = start(provider, 3);

        await("two helpers are inside the model", () -> provider.started.size() == 2);
        await("the chat shows two helpers waiting", () -> chat.waiting().size() == 2);
        holdStill();
        assertEquals(Set.of("t1", "t2"), Set.copyOf(provider.started),
                "the first two asked for are not the two that started");
        assertEquals(2, provider.started.size(), "a third helper started past the count");
        // Who waits is decided in request order; the two waiting notices come
        // from two threads, so their order in the stream is not.
        assertEquals(2, chat.waiting().size(), "a helper was shown waiting twice: " + chat.waiting());
        assertEquals(Set.of("t3", "t4"), Set.copyOf(chat.waiting()),
                "the chat does not show the two queued helpers as waiting");

        provider.gate("t1").countDown();
        await("a third helper starts once one finishes", () -> provider.started.size() == 3);
        holdStill();
        assertEquals("t3", provider.started.get(2), "the queue does not start in the order asked");
        assertEquals(3, provider.started.size(), "the fourth started while two held the slots");

        provider.gate("t2").countDown();
        await("the fourth helper starts", () -> provider.started.size() == 4);
        assertEquals("t4", provider.started.get(3));

        provider.gate("t3").countDown();
        provider.gate("t4").countDown();
        chat.drain().join(10_000);
        assertFalse(chat.drain().isAlive(), "the chat never finished");

        List<RunEvent.AgentMessage> results = chat.results();
        assertEquals(4, results.size(), "not every helper reported back: " + results);
        assertTrue(results.stream().allMatch(message -> "completed".equals(message.state())),
                "a queued helper did not finish: " + results);
    }

    @Test
    void aChatWithNoCountStartsAllFourAtOnceAndShowsNobodyWaiting() throws Exception {
        GatedProvider provider = new GatedProvider();
        provider.parentTurns.add(spawnFour());
        provider.parentTurns.add(text("all four reported"));
        Chat chat = start(provider, null);

        await("all four helpers are inside the model", () -> provider.started.size() == 4);
        assertEquals(List.of(), chat.waiting(), "a chat with no count showed a helper waiting");
        provider.gates.values().forEach(CountDownLatch::countDown);
        chat.drain().join(10_000);
        assertEquals(4, chat.results().size());
    }

    @Test
    void aRunningHelperKeepsItsSlotWhenTheCountDropsUnderIt() throws Exception {
        GatedProvider provider = new GatedProvider();
        provider.parentTurns.add(spawnFour());
        provider.parentTurns.add(text("all four reported"));
        Chat chat = start(provider, 3);

        await("two helpers are inside the model", () -> provider.started.size() == 2);
        chat.parent().setSessionsPerChat(2);
        holdStill();

        provider.gate("t1").countDown();
        await("the first helper reported", () -> chat.results().size() == 1);
        holdStill();
        assertEquals(2, provider.started.size(),
                "at a count of 2 one helper runs, and the one still running holds that slot");
        assertTrue(chat.results().stream().noneMatch(message -> "failed".equals(message.state())),
                "lowering the count cut a running helper: " + chat.results());

        provider.gate("t2").countDown();
        await("the third helper starts once the second is done", () -> provider.started.size() == 3);
        holdStill();
        assertEquals(3, provider.started.size(), "two helpers ran at a count of 2");

        provider.gate("t3").countDown();
        provider.gate("t4").countDown();
        chat.drain().join(10_000);
        assertEquals(4, chat.results().size());
        assertTrue(chat.results().stream().allMatch(message -> "completed".equals(message.state())),
                chat.results().toString());
    }

    @Test
    void aRaisedCountLetsAWaitingHelperStartWithoutAnotherFinishing() throws Exception {
        GatedProvider provider = new GatedProvider();
        provider.parentTurns.add(spawnFour());
        provider.parentTurns.add(text("all four reported"));
        Chat chat = start(provider, 3);

        await("two helpers are inside the model", () -> provider.started.size() == 2);
        chat.parent().setSessionsPerChat(5);
        await("the raised count reaches the waiting helpers", () -> provider.started.size() == 4);

        provider.gates.values().forEach(CountDownLatch::countDown);
        chat.drain().join(10_000);
        assertEquals(4, chat.results().size());
    }

    @Test
    void aWaitingHelperEndsWithTheParentRunAndHoldsNothing() throws Exception {
        GatedProvider provider = new GatedProvider();
        provider.parentTurns.add(spawnFour());
        provider.parentTurns.add(text("stopped"));
        Chat chat = start(provider, 3);

        await("two helpers wait", () -> chat.waiting().size() == 2);
        chat.signal().cancel();
        chat.drain().join(10_000);
        assertFalse(chat.drain().isAlive(), "a helper waiting for a slot kept the chat alive");
        assertEquals(2, provider.started.size(),
                "a helper that waited for a slot started after the run was cancelled");
        assertEquals(4, chat.results().size(), "every helper owes the parent a result");
    }
}
