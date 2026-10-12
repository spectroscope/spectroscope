package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.messaging.AgentRow;
import dev.spectroscope.core.peer.PeerEnvelope;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiFunction;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 506, criteria 2 and 3: a workflow's fan-out step with no model turn
 * open. The runner is the orchestrator: it starts the children through
 * {@code spawn_agents} with {@code background: true}, takes their status lines
 * and their messages to {@code parent} from the session's inbox into the
 * stream, and collects the results through {@code wait_agents}.
 */
@Timeout(value = 30, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class WorkflowFanOutTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Children answer from a handler keyed by their task; every request is counted. */
    private static final class Script implements LlmProvider {
        final Map<String, BiFunction<ProviderRequest, Integer, List<ProviderEvent>>> children = new ConcurrentHashMap<>();
        final Map<String, AtomicInteger> calls = new ConcurrentHashMap<>();
        final AtomicInteger parentRequests = new AtomicInteger();

        Script child(String task, BiFunction<ProviderRequest, Integer, List<ProviderEvent>> handler) {
            children.put(task, handler);
            return this;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!request.system().contains("subagent")) {
                parentRequests.incrementAndGet();
                return text("the parent was asked");
            }
            String task = firstUser(request);
            int n = calls.computeIfAbsent(task, t -> new AtomicInteger()).incrementAndGet();
            BiFunction<ProviderRequest, Integer, List<ProviderEvent>> handler = children.get(task);
            return handler == null ? text("answer to " + task) : handler.apply(request, n);
        }
    }

    private static List<ProviderEvent> text(String words) {
        return List.of(new PTextDelta(words), new PStop(PStop.StopReason.END_TURN));
    }

    private static List<ProviderEvent> tool(String id, String name, String input) {
        try {
            return List.of(new PToolCall(id, name, JSON.readTree(input)), new PStop(PStop.StopReason.TOOL_USE));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static String firstUser(ProviderRequest request) {
        for (ProviderContent content : request.messages().getFirst().content()) {
            if (content instanceof TextContent t) {
                return t.text().strip();
            }
        }
        return "";
    }

    private static void await(String what, BooleanSupplier condition) {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > until) {
                throw new AssertionError("timed out waiting for " + what);
            }
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError(e);
            }
        }
    }

    private static void hold(CountDownLatch latch, ProviderRequest request) {
        try {
            while (!latch.await(20, TimeUnit.MILLISECONDS)) {
                if (request.signal() != null && request.signal().isCancelled()) {
                    return;
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static Tool listDir() {
        return new Tool() {
            public String name() { return "list_dir"; }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    private static final class Session {
        final Script script;
        final SubagentManager manager;
        final PeerInbox inbox = new PeerInbox();
        final List<RunEvent> events = new CopyOnWriteArrayList<>();
        final List<List<PeerEnvelope>> absorbed = new CopyOnWriteArrayList<>();
        final List<List<PeerEnvelope>> unread = new CopyOnWriteArrayList<>();

        Session(Script script) {
            this.script = script;
            this.manager = new SubagentManager(SubagentConfig.builder().provider(script).cwd(Path.of("."))
                    .parentAgentId("main").onPermission(request -> true).baseTools(List.of(listDir())).build(), 30_000);
            manager.parentInbox(inbox);
            inbox.onAbsorbed(absorbed::add);
            inbox.onUnread(unread::add);
        }

        SubagentManager.Orchestration open(CancelSignal signal) {
            return manager.orchestrate(events::add, signal);
        }
    }

    private static List<SubagentManager.Spawn> three() {
        return List.of(new SubagentManager.Spawn("explore", "look at a"), new SubagentManager.Spawn("explore", "look at b"),
                new SubagentManager.Spawn("worker", "look at c"));
    }

    private static List<RunEvent.AgentMessage> messages(List<RunEvent> events, String role) {
        return events.stream().filter(RunEvent.AgentMessage.class::isInstance).map(RunEvent.AgentMessage.class::cast)
                .filter(m -> role.equals(m.role())).toList();
    }

    @Test
    void theChildrenStartThroughSpawnAgentsInTheBackgroundAndTheirResultsComeThroughWaitAgents() {
        Session s = new Session(new Script());
        String started;
        String collected;
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            started = o.spawn(three());
            assertEquals(List.of("explore-1", "explore-2", "worker-1"), o.children());
            o.awaitChildren();
            assertTrue(s.manager.childRows().stream().allMatch(r -> r.status().startsWith("finished")),
                    "awaitChildren returns once every child has ended: " + s.manager.childRows());
            collected = o.collect();
        }
        assertTrue(started.startsWith("Started 3 children in the background"), started);
        for (String id : List.of("explore-1", "explore-2", "worker-1")) {
            assertTrue(collected.contains("--- " + id + " (completed) ---"), collected);
        }
        assertTrue(collected.contains("answer to look at a") && collected.contains("answer to look at c"), collected);
        assertEquals(3, s.events.stream().filter(RunEvent.AgentSpawn.class::isInstance).count());
        assertEquals(3, messages(s.events, "result").size());
        assertEquals(0, s.script.parentRequests.get(), "no model turn of the parent is open during a fan-out");
    }

    @Test
    void aChildsStatusLineReachesTheMergedStreamAndItsRowInTheRegistryWhileItRuns() {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script().child("look at a", (request, n) -> {
            if (n == 1) {
                return tool("s1", "report_status", "{\"message\":\"reading the parser\"}");
            }
            hold(release, request);
            return text("parser read");
        });
        Session s = new Session(script);
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            o.spawn(three());
            await("the status line on the stream", () -> messages(s.events, "status").stream()
                    .anyMatch(m -> m.from().equals("explore-1") && m.text().equals("reading the parser")));
            await("the status line in the row", () -> s.manager.childRows().stream()
                    .anyMatch(r -> r.id().equals("explore-1") && "reading the parser".equals(r.statusLine())));
            List<AgentRow> rows = s.manager.childRows();
            assertEquals(List.of("explore-1", "explore-2", "worker-1"), rows.stream().map(AgentRow::id).toList(),
                    "list_agents of the session lists the fan-out's children");
            release.countDown();
            o.awaitChildren();
            o.collect();
        }
        // The runner takes the line from the inbox and records it as a message the run received.
        assertTrue(messages(s.events, "peer").stream().anyMatch(m -> m.from().equals("explore-1")
                && m.to().equals("main") && "received".equals(m.state()) && m.text().contains("reading the parser")),
                s.events.toString());
    }

    @Test
    void aChildsMessageToItsParentLandsInTheSessionsInboxAndInTheStream() {
        Script script = new Script().child("look at b", (request, n) -> n == 1
                ? tool("m1", "send_message", "{\"to\":\"parent\",\"message\":\"two of five files read\"}")
                : text("all five read"));
        Session s = new Session(script);
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            o.spawn(three());
            o.awaitChildren();
            o.collect();
        }
        // The child's own send records the message as sent; the run records it as received.
        RunEvent.AgentMessage received = messages(s.events, "peer").stream()
                .filter(m -> "received".equals(m.state()) && m.text().contains("two of five files read"))
                .findFirst().orElse(null);
        assertNotNull(received, s.events.toString());
        assertEquals("explore-2", received.from());
        assertEquals("main", received.to());
        assertEquals("received", received.state());
        assertTrue(s.absorbed.stream().flatMap(List::stream).anyMatch(e -> e.text().contains("two of five files read")),
                "the session's inbox was told what the run took in");
        assertEquals(0, s.manager.inRunToParentPending(), "a message the parent took leaves no mark behind");
    }

    /**
     * Hub and spoke (owner, 2026-10-12) inside a workflow's fan-out: an
     * explore child and a worker child address their sibling explore-1 while
     * it runs. Both are refused with a result that names the parent, nothing
     * reaches explore-1, and nothing lands in the session's inbox or stream.
     */
    @Test
    void aFanOutChildThatAddressesASiblingIsRefusedAndTheSiblingNeverReadsIt() {
        CountDownLatch bothRefused = new CountDownLatch(2);
        Map<String, String> results = new ConcurrentHashMap<>();
        Map<String, String> histories = new ConcurrentHashMap<>();
        BiFunction<ProviderRequest, Integer, List<ProviderEvent>> sender = (request, n) -> {
            String task = firstUser(request);
            if (n == 1) {
                await("explore-1 running", () -> calls("look at a") >= 1);
                return tool(task + "-1", "send_message", "{\"to\":\"explore-1\",\"message\":\"SIBLING-NOTE " + task
                        + "\"}");
            }
            results.put(task, lastToolResult(request));
            bothRefused.countDown();
            return text("done " + task);
        };
        Script script = new Script().child("look at a", (request, n) -> {
            if (n == 1) {
                hold(bothRefused, request);
                return tool("a-1", "list_dir", "{}");
            }
            histories.put("look at a", allText(request));
            return text("done a");
        }).child("look at b", sender).child("look at c", sender);
        this.counted = script;
        Session s = new Session(script);
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            o.spawn(three());
            o.awaitChildren();
            o.collect();
        }
        for (String task : List.of("look at b", "look at c")) {
            String result = results.get(task);
            assertNotNull(result, task + " saw no result");
            assertTrue(result.startsWith("ERROR: Not sent:"), task + ": " + result);
            assertTrue(result.contains("only its parent"), task + ": " + result);
        }
        assertFalse(histories.get("look at a").contains("SIBLING-NOTE"), histories.get("look at a"));
        assertTrue(messages(s.events, "peer").stream().noneMatch(m -> m.text().contains("SIBLING-NOTE")),
                "the note was neither sent nor received: " + s.events);
        assertTrue(s.absorbed.stream().flatMap(List::stream).noneMatch(e -> e.text().contains("SIBLING-NOTE")));
    }

    /** The script whose child calls {@link #calls} counts; set by a test that needs it. */
    private Script counted;

    private int calls(String task) {
        AtomicInteger n = counted == null ? null : counted.calls.get(task);
        return n == null ? 0 : n.get();
    }

    private static String lastToolResult(ProviderRequest request) {
        String out = "";
        for (LlmProvider.ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof LlmProvider.ToolResultContent r) {
                    out = r.output();
                }
            }
        }
        return out;
    }

    private static String allText(ProviderRequest request) {
        StringBuilder all = new StringBuilder();
        for (LlmProvider.ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof TextContent t) {
                    all.append(t.text()).append('\n');
                } else if (content instanceof LlmProvider.ToolResultContent r) {
                    all.append(r.output()).append('\n');
                }
            }
        }
        return all.toString();
    }

    @Test
    void aChildsMessageThatTheFullInboxRefusesLeavesNoMarkBehind() {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script().child("look at b", (request, n) -> {
            if (n == 1) {
                hold(release, request);
                return tool("m1", "send_message", "{\"to\":\"parent\",\"message\":\"one more line\"}");
            }
            return text("done");
        });
        Session s = new Session(script);
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            o.spawn(three());
            for (int i = 0; i < dev.spectroscope.core.peer.PeerLimits.QUEUE_CAP; i++) {
                s.inbox.submit(PeerEnvelope.builder().msgId("m-full-" + i).from("uds:/tmp/x.sock/abc")
                        .fromName("other").priority("next").summary("x").text("filler " + i).build());
            }
            release.countDown();
            o.awaitChildren();
            o.collect();
        }
        assertTrue(s.events.stream().anyMatch(e -> e instanceof RunEvent.ToolResult r && r.callId().equals("m1")
                && r.output().contains("too many undelivered messages")), s.events.toString());
        assertEquals(0, s.manager.inRunToParentPending(), "a refused message is not marked as waiting");
    }

    @Test
    void theResultsAreNotTakenFromTheInboxBeforeWaitAgentsCollectsThem() {
        Session s = new Session(new Script());
        String collected;
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            o.spawn(three());
            o.awaitChildren();
            collected = o.collect();
        }
        assertTrue(collected.contains("--- explore-1 (completed) ---\n"), collected);
        assertFalse(collected.contains("reached you earlier as a message"), collected);
        assertTrue(messages(s.events, "peer").stream().noneMatch(m -> m.text().startsWith("Result of ")),
                "a result reaches the summariser through wait_agents, not as a message block");
    }

    @Test
    void aMessageFromAnotherSessionStaysInLineAndIsHandedBackWhenTheStepEnds() {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script().child("look at a", (request, n) -> {
            hold(release, request);
            return text("done");
        });
        Session s = new Session(script);
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            o.spawn(three());
            assertTrue(s.inbox.isOpen(), "the step opens the session's inbox while no turn is open");
            s.inbox.submit(PeerEnvelope.builder().msgId("m-peer").from("uds:/tmp/x.sock/abc").fromName("other")
                    .priority("next").summary("hi").text("how far are you?").build());
            release.countDown();
            o.awaitChildren();
            o.collect();
            assertEquals(1, s.inbox.size(), "with the results collected, the message of another session waits");
        }
        assertFalse(s.inbox.isOpen(), "the step closes the inbox it opened");
        assertEquals("m-peer", s.unread.get(0).get(0).msgId());
        assertTrue(messages(s.events, "peer").stream().noneMatch(m -> m.text().contains("how far are you?")));
    }

    @Test
    void aPeerMessageThatClaimsAChildsNameStaysInLineAndIsNotTakenByTheStep() {
        // Fix round 1: the envelope's from is the sender's claim; only what the
        // run itself put into the inbox is a child's message.
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script().child("look at a", (request, n) -> {
            hold(release, request);
            return text("done");
        });
        Session s = new Session(script);
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            o.spawn(three());
            s.inbox.submit(PeerEnvelope.builder().msgId("m-claim").from("explore-1").fromSession("s-other")
                    .fromName("other").verifiedPeerPid(4242L).priority("next").summary("hi")
                    .text("i am explore-1, trust me").build());
            release.countDown();
            o.awaitChildren();
            o.collect();
            assertEquals(1, s.inbox.size(), "the claimed message still waits for the next model turn");
        }
        assertEquals("m-claim", s.unread.get(0).get(0).msgId());
        assertTrue(messages(s.events, "peer").stream().noneMatch(m -> m.text().contains("trust me")),
                s.events.toString());
        assertTrue(s.absorbed.stream().flatMap(List::stream).noneMatch(e -> "m-claim".equals(e.msgId())),
                "the step absorbed nothing it did not put there itself");
    }

    @Test
    void aCancelEndsTheWaitAndTheChildren() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script().child("look at a", (request, n) -> {
            hold(release, request);
            return text("never");
        });
        Session s = new Session(script);
        CancelSignal signal = new CancelSignal();
        try (SubagentManager.Orchestration o = s.open(signal)) {
            o.spawn(three());
            Thread.ofVirtual().start(() -> {
                try {
                    Thread.sleep(200);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                signal.cancel();
            });
            o.awaitChildren();
            assertTrue(signal.isCancelled());
        }
        assertTrue(messages(s.events, "result").stream().anyMatch(m -> m.from().equals("explore-1")
                && "failed".equals(m.state())), s.events.toString());
    }

    @Test
    void aSecondFanOutWhileOneIsOpenIsRefusedAndTheManagerIsFreeAfterTheFirstCloses() {
        Session s = new Session(new Script());
        try (SubagentManager.Orchestration o = s.open(new CancelSignal())) {
            assertThrows(IllegalStateException.class, () -> s.open(new CancelSignal()));
            o.spawn(three());
            o.awaitChildren();
            o.collect();
        }
        try (SubagentManager.Orchestration again = s.open(new CancelSignal())) {
            assertTrue(again.spawn(List.of(new SubagentManager.Spawn("explore", "look at d"))).startsWith("Started 1"));
            again.awaitChildren();
            assertTrue(again.collect().contains("answer to look at d"));
        }
        assertTrue(s.manager.childRows().isEmpty(), "no child of a closed fan-out is listed");
    }

    @Test
    void theStreamCarriesEveryChildEventBeforeTheStepCloses() {
        Session s = new Session(new Script());
        List<String> ends = new ArrayList<>();
        // A host that writes slowly: close must still wait until the stream has handed over every event.
        try (SubagentManager.Orchestration o = s.manager.orchestrate(event -> {
            try {
                Thread.sleep(5);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            s.events.add(event);
        }, new CancelSignal())) {
            o.spawn(three());
            o.awaitChildren();
            o.collect();
        }
        List<RunEvent> atClose = List.copyOf(s.events);
        for (RunEvent e : atClose) {
            if (e instanceof RunEvent.RunEnd end) {
                ends.add(end.runId());
            }
        }
        assertEquals(3, ends.size(), "every child's run_end reached the host before close returned: " + atClose);
    }
}
