package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.ToolGroup;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.goal.GoalVerdict;
import dev.spectroscope.core.goal.RunGoal;
import dev.spectroscope.core.goal.SessionGoal;
import dev.spectroscope.core.messaging.AgentRow;
import dev.spectroscope.core.messaging.MessagingSeat;
import dev.spectroscope.core.messaging.MessagingTools;
import dev.spectroscope.core.messaging.SessionSeat;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.UnaryOperator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 505: a fan-out runs in the background and answers status. One test
 * per guarantee of criteria 1 to 7 and of the non-functional criteria, on the
 * real manager, the real parent loop and a scripted provider.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class BackgroundFanOutTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    // ── the scripted provider ─────────────────────────────────────────────

    /** The parent answers from a queue of turns; each child from a handler keyed by its task. */
    private static final class Script implements LlmProvider {
        final BlockingQueue<Function<ProviderRequest, List<ProviderEvent>>> parent = new LinkedBlockingQueue<>();
        final Map<String, BiFunction<ProviderRequest, Integer, Iterable<ProviderEvent>>> children =
                new ConcurrentHashMap<>();
        final List<ProviderRequest> parentRequests = new CopyOnWriteArrayList<>();
        final Map<String, List<ProviderRequest>> childRequests = new ConcurrentHashMap<>();
        final AtomicInteger atModel = new AtomicInteger();
        final AtomicInteger mostAtModel = new AtomicInteger();

        Script parentSays(Function<ProviderRequest, List<ProviderEvent>> turn) {
            parent.add(turn);
            return this;
        }

        Script parentSays(List<ProviderEvent> turn) {
            return parentSays(request -> turn);
        }

        Script child(String task, BiFunction<ProviderRequest, Integer, Iterable<ProviderEvent>> handler) {
            children.put(task, handler);
            return this;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!request.system().contains("subagent")) {
                parentRequests.add(request);
                Function<ProviderRequest, List<ProviderEvent>> turn = parent.poll();
                return turn == null ? text("nothing more") : turn.apply(request);
            }
            String task = firstUser(request);
            List<ProviderRequest> mine = childRequests.computeIfAbsent(task, t -> new CopyOnWriteArrayList<>());
            mine.add(request);
            BiFunction<ProviderRequest, Integer, Iterable<ProviderEvent>> handler = children.get(task);
            if (handler == null) {
                return text("done " + task);
            }
            int now = atModel.incrementAndGet();
            mostAtModel.accumulateAndGet(now, Math::max);
            try {
                // Returned as it is: a lazy stream hands its events out one by one.
                return handler.apply(request, mine.size());
            } finally {
                atModel.decrementAndGet();
            }
        }
    }

    private static List<ProviderEvent> text(String words) {
        return List.of(new PTextDelta(words), new PStop(PStop.StopReason.END_TURN));
    }

    private static List<ProviderEvent> tool(String id, String name, String input) {
        return List.of(new PToolCall(id, name, json(input)), new PStop(PStop.StopReason.TOOL_USE));
    }

    private static JsonNode json(String text) {
        try {
            return JSON.readTree(text);
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

    private static String history(ProviderRequest request) {
        StringBuilder all = new StringBuilder();
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof TextContent t) {
                    all.append(t.text()).append('\n');
                } else if (content instanceof ToolResultContent r) {
                    all.append(r.output()).append('\n');
                }
            }
        }
        return all.toString();
    }

    /** The tool results of a request, in order. */
    private static List<String> results(ProviderRequest request) {
        List<String> out = new ArrayList<>();
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof ToolResultContent r) {
                    out.add(r.output());
                }
            }
        }
        return out;
    }

    private static String lastResult(ProviderRequest request) {
        List<String> all = results(request);
        return all.isEmpty() ? "" : all.getLast();
    }

    /** Blocks until the latch opens or the request's signal is cancelled. */
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

    // ── the chat ──────────────────────────────────────────────────────────

    private static Tool listDir() {
        return new Tool() {
            public String name() { return "list_dir"; }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    private static final class Chat {
        final SubagentManager manager;
        final Agent parent;
        final PeerInbox inbox = new PeerInbox();
        final ToolRegistry registry = new ToolRegistry();
        /** The merged stream as the run hands it out, readable while the run is in flight. */
        final List<RunEvent> events = new CopyOnWriteArrayList<>();

        Chat(LlmProvider provider, SubagentConfig.Builder config, long runBudgetMs, SessionGoal goal,
             Integer maxTurns, boolean inboxWired) {
            this(provider, config, runBudgetMs, goal, maxTurns, inboxWired, UnaryOperator.identity());
        }

        Chat(LlmProvider provider, SubagentConfig.Builder config, long runBudgetMs, SessionGoal goal,
             Integer maxTurns, boolean inboxWired, UnaryOperator<MessagingSeat> seatAround) {
            this.manager = new SubagentManager(config.provider(provider).cwd(Path.of(".")).parentAgentId("main")
                    .onPermission(request -> true).baseTools(List.of(listDir())).build(), runBudgetMs);
            manager.tools().forEach(registry::register);
            MessagingTools.forSeat(seatAround.apply(
                            new SessionSeat(() -> null, () -> "s", () -> manager, () -> true, "main")))
                    .forEach(registry::register);
            manager.backgroundTools().forEach(registry::register);
            AgentOptions.Builder options = AgentOptions.builder()
                    .provider(provider)
                    .systemPrompt("You are the parent.")
                    .registry(registry)
                    .cwd(Path.of("."))
                    .agentId("main")
                    .onPermission(request -> true)
                    .goal(goal)
                    .maxTurns(maxTurns);
            if (inboxWired) {
                options.peerInbox(inbox);
            }
            this.parent = new Agent(options.build());
            if (inboxWired) {
                manager.parentInbox(inbox);
            }
        }

        List<RunEvent> run(CancelSignal signal) {
            try (EventStream stream = manager.run(parent, "go", new RunOptions(signal, null))) {
                stream.forEach(events::add);
            }
            return events;
        }
    }

    private static Chat chat(LlmProvider provider) {
        return new Chat(provider, SubagentConfig.builder(), 30_000, null, null, true);
    }

    private static List<RunEvent.AgentMessage> messages(List<RunEvent> events, String role) {
        return events.stream().filter(RunEvent.AgentMessage.class::isInstance).map(RunEvent.AgentMessage.class::cast)
                .filter(m -> role.equals(m.role())).toList();
    }

    private static String stopReason(List<RunEvent> events) {
        return events.stream().filter(RunEvent.RunEnd.class::isInstance).map(RunEvent.RunEnd.class::cast)
                .filter(end -> "main".equals(agentOfRun(events, end.runId())))
                .reduce((a, b) -> b).orElseThrow().stopReason();
    }

    private static String agentOfRun(List<RunEvent> events, String runId) {
        return events.stream().filter(RunEvent.RunStart.class::isInstance).map(RunEvent.RunStart.class::cast)
                .filter(start -> start.runId().equals(runId)).map(RunEvent.RunStart::agentId).findFirst()
                .orElse("");
    }

    private static int indexOf(List<RunEvent> events, java.util.function.Predicate<RunEvent> what) {
        for (int i = 0; i < events.size(); i++) {
            if (what.test(events.get(i))) {
                return i;
            }
        }
        return -1;
    }

    private static final String TWO_IN_BACKGROUND = """
            {"background":true,"agents":[{"type":"explore","task":"task A"},{"type":"explore","task":"task B"}]}""";

    // ── criterion 1 ───────────────────────────────────────────────────────

    @Test
    void withoutBackgroundSpawnAgentsStillWaitsForEveryChild() {
        Script script = new Script()
                .parentSays(tool("p1", "spawn_agents",
                        "{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"},{\"type\":\"explore\",\"task\":\"task B\"}]}"))
                .parentSays(text("both done"));
        Chat chat = chat(script);
        chat.run(new CancelSignal());

        String spawnResult = lastResult(script.parentRequests.get(1));
        assertTrue(spawnResult.contains("done task A") && spawnResult.contains("done task B"),
                "the blocking form hands back both results: " + spawnResult);
    }

    @Test
    void backgroundTrueReturnsAtOnceWithTheChildIdsAndNames() {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(release, request);
                    return text("A found it");
                })
                .child("task B", (request, n) -> {
                    hold(release, request);
                    return text("B found it");
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(request -> {
                    release.countDown();
                    return text("waiting for them");
                });
        Chat chat = chat(script);
        List<RunEvent> events = chat.run(new CancelSignal());

        String started = lastResult(script.parentRequests.get(1));
        assertTrue(started.contains("explore-1") && started.contains("explore-2"), started);
        assertTrue(started.contains("background"), started);
        assertFalse(started.contains("A found it") || started.contains("B found it"),
                "the call returned before either child answered: " + started);
        int toolResult = indexOf(events, e -> e instanceof RunEvent.ToolResult r && "main".equals(r.agentId()));
        int firstResult = indexOf(events, e -> e instanceof RunEvent.AgentMessage m && "result".equals(m.role()));
        assertTrue(toolResult >= 0 && firstResult > toolResult,
                "the spawn's tool result comes before any child's result");
    }

    @Test
    void backgroundChildrenRunOnTheChatsSlotsAtTheSameWidth() {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script();
        for (String task : List.of("t1", "t2", "t3")) {
            script.child(task, (request, n) -> {
                hold(release, request);
                return text("done " + task);
            });
        }
        script.parentSays(tool("p1", "spawn_agents", """
                        {"background":true,"agents":[{"type":"worker","task":"t1"},{"type":"worker","task":"t2"},
                        {"type":"worker","task":"t3"}]}"""))
                .parentSays(request -> {
                    await("two helpers inside the model", () -> script.atModel.get() == 2);
                    release.countDown();
                    return text("waiting");
                });
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(3), 30_000, null, null, true);
        chat.parent.setSessionsPerChat(3);
        List<RunEvent> events = chat.run(new CancelSignal());

        assertEquals(2, script.mostAtModel.get(), "a chat of three runs two helpers at once");
        assertTrue(messages(events, "status").stream().anyMatch(m -> "submitted".equals(m.state())),
                "the third helper is shown as waiting for a slot");
        assertEquals(3, messages(events, "result").size(), "and all three finish");
    }

    @Test
    void aBackgroundBatchWiderThanTheBatchWidthIsRefusedLikeABlockingOne() {
        Script script = new Script()
                .parentSays(tool("p1", "spawn_agents", """
                        {"background":true,"agents":[{"type":"worker","task":"1"},{"type":"worker","task":"2"},
                        {"type":"worker","task":"3"},{"type":"worker","task":"4"},{"type":"worker","task":"5"}]}"""))
                .parentSays(text("ok"));
        Chat chat = chat(script);
        chat.run(new CancelSignal());
        assertTrue(lastResult(script.parentRequests.get(1)).startsWith("ERROR: at most 4 parallel subagents"),
                lastResult(script.parentRequests.get(1)));
    }

    @Test
    void theSchemaAndTheDescriptionOfferBackgroundOnlyWithAnInboxAndMessagingOn() {
        Script script = new Script().parentSays(text("hi"));
        Chat on = chat(script);
        on.run(new CancelSignal());
        ToolSpec offered = spec(script.parentRequests.getFirst(), "spawn_agents");
        assertTrue(offered.inputSchema().path("properties").has("background"), offered.inputSchema().toString());
        assertTrue(offered.description().contains("background"), offered.description());
        assertTrue(offered.description().contains("wait_agents"), offered.description());

        Script noInbox = new Script().parentSays(text("hi"));
        new Chat(noInbox, SubagentConfig.builder(), 30_000, null, null, false).run(new CancelSignal());
        ToolSpec bare = spec(noInbox.parentRequests.getFirst(), "spawn_agents");
        assertFalse(bare.inputSchema().path("properties").has("background"), bare.inputSchema().toString());
        assertFalse(bare.description().contains("wait_agents"), bare.description());

        Script off = new Script().parentSays(text("hi"));
        Chat messagingOff = chat(off);
        messagingOff.parent.setAgentMessaging(false);
        messagingOff.run(new CancelSignal());
        ToolSpec offSpec = spec(off.parentRequests.getFirst(), "spawn_agents");
        assertFalse(offSpec.inputSchema().path("properties").has("background"), offSpec.inputSchema().toString());
        assertFalse(names(off.parentRequests.getFirst()).contains("wait_agents"),
                "messaging off takes wait_agents out with the other two");
    }

    @Test
    void backgroundIsRefusedWhereItIsNotOffered() {
        Script script = new Script()
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(text("ok"));
        new Chat(script, SubagentConfig.builder(), 30_000, null, null, false).run(new CancelSignal());
        String result = lastResult(script.parentRequests.get(1));
        assertTrue(result.startsWith("ERROR: background"), result);
        assertTrue(script.childRequests.isEmpty(), "no child started");
    }

    private static ToolSpec spec(ProviderRequest request, String name) {
        return request.tools().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow();
    }

    private static List<String> names(ProviderRequest request) {
        return request.tools().stream().map(ToolSpec::name).toList();
    }

    // ── criterion 2 ───────────────────────────────────────────────────────

    @Test
    void aBackgroundChildsStatusLineAndItsMessageToParentReachTheParentsNextStep() {
        CountDownLatch spoke = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> switch (n) {
                    case 1 -> tool("a1", "report_status", "{\"message\":\"reading the parser\"}");
                    case 2 -> tool("a2", "send_message", "{\"to\":\"parent\",\"message\":\"found two callers\"}");
                    default -> {
                        spoke.countDown();
                        yield text("A done");
                    }
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(request -> {
                    hold(spoke, request);
                    return tool("p2", "list_dir", "{}");
                })
                .parentSays(text("thanks"));
        Chat chat = chat(script);
        chat.run(new CancelSignal());

        String third = history(script.parentRequests.get(2));
        assertTrue(third.contains("<agent-message from=\"explore-1\""), third);
        assertTrue(third.contains("reading the parser"), "the status line: " + third);
        assertTrue(third.contains("found two callers"), "the message to parent: " + third);
    }

    @Test
    void aBackgroundChildsResultArrivesAsAMessageAndIsKeptUntilCollected() {
        CountDownLatch finished = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> text("the parser has two callers"))
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(request -> {
                    await("the child's result", () -> finished.getCount() == 0);
                    return tool("p2", "list_dir", "{}");
                })
                .parentSays(tool("p3", "wait_agents", "{}"))
                .parentSays(text("done"));
        Chat chat = chat(script);
        Thread watcher = Thread.ofVirtual().start(() -> {
            await("a result message", () -> chat.manager.backgroundSnapshotForTests().contains("explore-1=finished"));
            finished.countDown();
        });
        List<RunEvent> events = chat.run(new CancelSignal());
        watcher.interrupt();

        String third = history(script.parentRequests.get(2));
        assertTrue(third.contains("Result of explore-1 (completed)"), third);
        assertTrue(third.contains("the parser has two callers"), third);
        String waited = lastResult(script.parentRequests.get(3));
        assertTrue(waited.contains("explore-1") && waited.contains("reached you earlier"), waited);
        assertFalse(waited.contains("the parser has two callers"), "not handed over twice: " + waited);
        assertEquals(1, messages(events, "result").size(), "one result record on the wire");
    }

    @Test
    void aResultCollectedByWaitAgentsIsNotHandedInAgainByTheInbox() {
        Script script = new Script()
                .child("task A", (request, n) -> text("the parser has two callers"))
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(tool("p2", "wait_agents", "{}"))
                .parentSays(text("done"));
        Chat chat = chat(script);
        chat.run(new CancelSignal());

        String waited = lastResult(script.parentRequests.get(2));
        assertTrue(waited.contains("the parser has two callers"), waited);
        String all = history(script.parentRequests.get(2));
        assertEquals(1, all.split("the parser has two callers", -1).length - 1,
                "the result reaches the model once: " + all);
    }

    // ── criterion 3 ───────────────────────────────────────────────────────

    @Test
    void waitAgentsReturnsTheNamedResultsAndTheStatusOfThoseStillRunning() {
        CountDownLatch releaseB = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> text("A says two callers"))
                .child("task B", (request, n) -> {
                    if (n == 1) {
                        return tool("b1", "report_status", "{\"message\":\"still reading\"}");
                    }
                    hold(releaseB, request);
                    return text("B says three files");
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(tool("p2", "wait_agents", "{\"ids\":[\"explore-1\"]}"))
                .parentSays(request -> {
                    await("B's status line", () -> chat0.manager.backgroundSnapshotForTests()
                            .contains("explore-2=working:still reading"));
                    return tool("p3", "wait_agents", "{\"timeoutSeconds\":0}");
                })
                .parentSays(request -> {
                    releaseB.countDown();
                    return tool("p4", "wait_agents", "{}");
                })
                .parentSays(text("all in"));
        chat0 = chat(script);
        chat0.run(new CancelSignal());

        String first = lastResult(script.parentRequests.get(2));
        assertTrue(first.contains("explore-1 (completed)") && first.contains("A says two callers"), first);
        assertFalse(first.contains("explore-2"), "only the named child: " + first);
        String second = lastResult(script.parentRequests.get(3));
        assertTrue(second.contains("explore-2 (still running)") && second.contains("still reading"), second);
        String third = lastResult(script.parentRequests.get(4));
        assertTrue(third.contains("B says three files"), third);
    }

    /** Spawns one background child that finishes at once, then calls wait_agents with the input. */
    private static String waitAgentsAnswers(String input) {
        Script script = new Script()
                .child("task A", (request, n) -> text("A done"))
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(tool("p2", "wait_agents", input))
                .parentSays(tool("p3", "wait_agents", "{}"))
                .parentSays(text("done"));
        chat(script).run(new CancelSignal());
        return lastResult(script.parentRequests.get(2));
    }

    @Test
    void waitAgentsRefusesAnIdThatIsNoBackgroundChildOfTheRun() {
        String answer = waitAgentsAnswers("{\"ids\":[\"explore-9\"]}");
        assertTrue(answer.startsWith("ERROR: no background child named \"explore-9\""), answer);
        assertTrue(answer.contains("Children of this run: explore-1."), answer);
    }

    @Test
    void waitAgentsRefusesIdsThatAreNotAnArray() {
        String answer = waitAgentsAnswers("{\"ids\":\"explore-1\"}");
        assertEquals("ERROR: ids must be an array of child names.", answer);
    }

    @Test
    void waitAgentsRefusesATimeoutThatIsNotANumber() {
        String answer = waitAgentsAnswers("{\"timeoutSeconds\":\"soon\"}");
        assertEquals("ERROR: timeoutSeconds must be a number of seconds.", answer);
    }

    @Test
    void waitAgentsWithAWaitAboveTheMaximumStillReturnsTheResult() {
        String answer = waitAgentsAnswers("{\"timeoutSeconds\":99999}");
        assertTrue(answer.contains("explore-1 (completed)") && answer.contains("A done"), answer);
    }

    @Test
    void waitAgentsWithoutABackgroundChildSaysHowToStartOne() {
        Script script = new Script()
                .parentSays(tool("p1", "wait_agents", "{}"))
                .parentSays(text("done"));
        chat(script).run(new CancelSignal());
        assertTrue(lastResult(script.parentRequests.get(1)).startsWith(
                "ERROR: no child of this run was started in the background"), lastResult(script.parentRequests.get(1)));
    }

    /** Set by the test above, read by its own scripted turn. */
    private static volatile Chat chat0;

    @Test
    void waitAgentsNamesTheChildrenOfThisRunInItsDescription() {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(release, request);
                    return text("A");
                })
                .child("task B", (request, n) -> {
                    hold(release, request);
                    return text("B");
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(request -> {
                    release.countDown();
                    return tool("p2", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        Chat chat = chat(script);
        chat.run(new CancelSignal());

        String before = spec(script.parentRequests.getFirst(), "wait_agents").description();
        assertFalse(before.contains("explore-1"), before);
        String after = spec(script.parentRequests.get(1), "wait_agents").description();
        assertTrue(after.contains("explore-1") && after.contains("explore-2"), after);
    }

    @Test
    void noChildHoldsWaitAgentsOrASpawnToolSoDepthStaysOne() {
        Script script = new Script()
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(tool("p2", "wait_agents", "{}"))
                .parentSays(text("done"));
        Chat chat = chat(script);
        chat.run(new CancelSignal());

        assertTrue(names(script.parentRequests.getFirst()).contains("wait_agents"), "the parent holds it");
        for (List<ProviderRequest> requests : script.childRequests.values()) {
            List<String> tools = names(requests.getFirst());
            assertFalse(tools.contains("wait_agents"), tools.toString());
            assertFalse(tools.stream().anyMatch(name -> name.startsWith("spawn_")), tools.toString());
            assertTrue(tools.contains("send_message"), "premise: the child's own belt: " + tools);
        }
        assertEquals(2, script.childRequests.size());
    }

    @Test
    void waitAgentsBelongsToTheMessagingGroup() {
        assertEquals(java.util.Optional.of(ToolGroup.MESSAGING), ToolGroup.of("wait_agents"));
    }

    // ── criterion 4 ───────────────────────────────────────────────────────

    @Test
    void aParentEndingItsTurnWithChildrenRunningWaitsAndGetsTheirResults() {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(release, request);
                    return text("A found the bug");
                })
                .child("task B", (request, n) -> {
                    hold(release, request);
                    return text("B found the test");
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(request -> {
                    Thread.ofVirtual().start(() -> {
                        try {
                            Thread.sleep(200);
                        } catch (InterruptedException ignored) {
                            Thread.currentThread().interrupt();
                        }
                        release.countDown();
                    });
                    return text("I will wait for them");
                })
                .parentSays(text("summary of both"));
        Chat chat = chat(script);
        List<RunEvent> events = chat.run(new CancelSignal());

        assertEquals(3, script.parentRequests.size(), "the results bought the parent one more turn");
        String handIn = history(script.parentRequests.get(2));
        assertTrue(handIn.contains("A found the bug") && handIn.contains("B found the test"), handIn);
        assertTrue(handIn.contains("<agent-message from=\"explore-1\"")
                && handIn.contains("<agent-message from=\"explore-2\""), "one block per child: " + handIn);
        assertTrue(handIn.contains(dev.spectroscope.core.peer.AgentMessageBlock.TRAILER), "attributed: " + handIn);
        assertEquals("end_turn", stopReason(events));
        int runEnd = indexOf(events, e -> e instanceof RunEvent.RunEnd end
                && "main".equals(agentOfRun(events, end.runId())));
        int lastResult = 0;
        for (int i = 0; i < events.size(); i++) {
            if (events.get(i) instanceof RunEvent.AgentMessage m && "result".equals(m.role())) {
                lastResult = i;
            }
        }
        assertTrue(lastResult < runEnd, "every child ended before the parent's run_end");
    }

    @Test
    void anEndedChildWhoseResultTheFullInboxDroppedIsHandedInAtTheEndTurn() {
        int cap = dev.spectroscope.core.peer.PeerLimits.QUEUE_CAP;
        Script script = new Script()
                .child("task A", (request, n) -> n <= cap
                        ? tool("s" + n, "report_status", "{\"message\":\"line " + n + "\"}")
                        : text("the dropped answer"));
        Chat chat = chat(script);
        // The parent holds its second turn until the child has ended, so 64
        // status lines fill its inbox and the result finds the queue full.
        script.parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(request -> {
                    await("the child's end", () -> chat.manager.backgroundSnapshotForTests().contains("explore-1=finished"));
                    return text("I am done");
                })
                .parentSays(text("still done"))
                .parentSays(text("summary"));
        List<RunEvent> events = chat.run(new CancelSignal());

        String all = history(script.parentRequests.getLast());
        assertTrue(all.contains("line 1") && all.contains("line " + cap), "positive: the status lines arrived");
        assertTrue(all.contains("the dropped answer"), "the result reached the model at an end_turn: "
                + script.parentRequests.size() + " requests");
        assertEquals("end_turn", stopReason(events));
    }

    @Test
    void aReportStatusLineIsCutBeforeItReachesTheStreamAndTheListing() {
        String longLine = "y".repeat(3_000);
        Script script = new Script()
                .child("task A", (request, n) -> n == 1
                        ? tool("s1", "report_status", "{\"message\":\"" + longLine + "\"}")
                        : text("done"))
                .parentSays(tool("p1", "spawn_agents",
                        "{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(text("ok"));
        List<RunEvent> events = chat(script).run(new CancelSignal());
        List<RunEvent.AgentMessage> statuses = messages(events, "status");
        assertEquals(1, statuses.size(), "positive: the line reached the stream");
        String text = statuses.get(0).text();
        assertTrue(text.startsWith("y".repeat(BackgroundRun.STATUS_LINE_CAP)), "the start is kept");
        assertTrue(text.length() < BackgroundRun.STATUS_LINE_CAP + 40, "cut: " + text.length());
        String result = lastResult(script.childRequests.get("task A").get(1));
        assertTrue(result.startsWith("ok, cut to its first 500 characters"), result);
    }

    @Test
    void withAGoalTheParentChecksInListingTheChildrenAndIsCheckedAfterTheLast() {
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger checks = new AtomicInteger();
        SessionGoal goal = new SessionGoal((stated, context) -> {
            checks.incrementAndGet();
            return new GoalVerdict(GoalVerdict.Outcome.MET, "exit 0", 0, "", 1, null, null, "met");
        });
        goal.state(new RunGoal("both helpers reported", "exit 0"));
        Script script = new Script()
                .child("task A", (request, n) -> {
                    if (n == 1) {
                        return tool("a1", "report_status", "{\"message\":\"halfway through\"}");
                    }
                    hold(release, request);
                    return text("A is done");
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(request -> {
                    await("the status line", () -> chat1.manager.backgroundSnapshotForTests()
                            .contains("halfway through"));
                    return tool("p2", "list_dir", "{}");
                })
                .parentSays(text("ending my turn"))
                .parentSays(request -> {
                    release.countDown();
                    return text("still waiting");
                })
                .parentSays(text("all done"));
        chat1 = new Chat(script, SubagentConfig.builder(), 30_000, goal, null, true);
        chat1.manager.checkInMs(150);
        List<RunEvent> events = chat1.run(new CancelSignal());

        assertFalse(history(script.parentRequests.get(2)).contains("Goal check-in:"),
                "premise: the status line came in as a message first");
        String checkIn = history(script.parentRequests.get(3));
        assertTrue(checkIn.contains("Goal check-in:") && checkIn.contains("explore-1 · explore · still running"
                + " · halfway through"), "id, role and last status line: " + checkIn);
        String results = history(script.parentRequests.get(4));
        assertTrue(results.contains("A is done"), results);
        assertEquals(1, checks.get(), "the goal is checked once, after the last child");
        assertEquals("goal_met", stopReason(events));
    }

    private static volatile Chat chat1;

    @Test
    void aRunAtItsCapCancelsTheChildrenStillRunningBeforeItsRunEnd() {
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(text("out of turns"));
        Chat chat = new Chat(script, SubagentConfig.builder(), 30_000, null, 2, true);
        List<RunEvent> events = chat.run(new CancelSignal());

        List<RunEvent.AgentMessage> results = messages(events, "result");
        assertEquals(1, results.size());
        assertTrue(results.getFirst().text().contains("ended because its parent run ended"),
                results.getFirst().text());
        int runEnd = indexOf(events, e -> e instanceof RunEvent.RunEnd end
                && "main".equals(agentOfRun(events, end.runId())));
        assertTrue(indexOf(events, e -> e == results.getFirst()) < runEnd, "the child ended first");
    }

    // ── criterion 5 ───────────────────────────────────────────────────────

    @Test
    void cancellingTheParentCancelsEveryBackgroundChild() {
        CancelSignal signal = new CancelSignal();
        Script script = new Script();
        script
                .child("task A", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .child("task B", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(request -> {
                    // The cancel lands while the parent waits inside wait_agents.
                    // A cancel in the instant between the loop's abort check and
                    // its end_turn exit is reported as end_turn by the loop as it
                    // stands; that window is older than this card.
                    Thread.ofVirtual().start(() -> {
                        await("both children at the model", () -> script.atModel.get() == 2);
                        signal.cancel();
                    });
                    return tool("p2", "wait_agents", "{}");
                });
        Chat chat = chat(script);
        List<RunEvent> events = chat.run(signal);

        List<RunEvent.AgentMessage> results = messages(events, "result");
        assertEquals(2, results.size());
        for (RunEvent.AgentMessage result : results) {
            assertTrue(result.text().contains("ended by cancellation of the parent run"), result.text());
        }
        assertEquals("aborted", stopReason(events));
    }

    @Test
    void aBackgroundChildIsCutByTheQueueGraceAsABlockingOneIs() {
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(text("waiting"));
        Chat chat = new Chat(script, SubagentConfig.builder(), 300, null, null, true);
        List<RunEvent> events = chat.run(new CancelSignal());
        String result = messages(events, "result").getFirst().text();
        assertTrue(result.contains("never produced a token"), result);
    }

    @Test
    void aBackgroundChildIsCutByTheRunBudgetAsABlockingOneIs() {
        Script script = new Script()
                .child("task A", (request, n) -> () -> new java.util.Iterator<ProviderEvent>() {
                    private int served;

                    @Override
                    public boolean hasNext() {
                        if (served == 1) {
                            hold(new CountDownLatch(1), request);
                        }
                        return served < 2;
                    }

                    @Override
                    public ProviderEvent next() {
                        return served++ == 0 ? new PTextDelta("starting") : new PStop(PStop.StopReason.ABORTED);
                    }
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(text("waiting"));
        Chat chat = new Chat(script, SubagentConfig.builder(), 300, null, null, true);
        List<RunEvent> events = chat.run(new CancelSignal());
        String result = messages(events, "result").getFirst().text();
        assertTrue(result.startsWith("ERROR: [explore-1] out of budget"), result);
    }

    @Test
    void aBackgroundChildIsCutByTheTokenBudgetAsABlockingOneIs() {
        Script script = new Script()
                .child("task A", (request, n) -> {
                    if (n == 1) {
                        return List.of(new PToolCall("a1", "list_dir", JSON.createObjectNode()),
                                new LlmProvider.PUsage(2_000, 10), new PStop(PStop.StopReason.TOOL_USE));
                    }
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(text("waiting"));
        Chat chat = new Chat(script, SubagentConfig.builder().subagentBudgetTokens(1_000), 30_000, null, null,
                true);
        List<RunEvent> events = chat.run(new CancelSignal());
        String result = messages(events, "result").getFirst().text();
        assertTrue(result.startsWith("ERROR: [explore-1] out of tokens"), result);
    }

    // ── criterion 6 ───────────────────────────────────────────────────────

    @Test
    void theParentAsksAChildForStatusAndTheAnswerComesBackInOrder() {
        CountDownLatch asked = new CountDownLatch(1);
        CountDownLatch releaseA = new CountDownLatch(1);
        AtomicReference<Chat> chat = new AtomicReference<>();
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(releaseA, request);
                    return text("A done");
                })
                .child("task B", (request, n) -> {
                    if (n == 1) {
                        hold(asked, request);
                        return tool("b1", "list_dir", "{}");
                    }
                    if (history(request).contains("status?") && n == 2) {
                        return tool("b2", "send_message", "{\"to\":\"parent\",\"message\":\"two of five files read\"}");
                    }
                    return text("B done");
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(request -> {
                    // A child reads no message before it is working (the refusal says to send again
                    // once list_agents shows it working), and its thread may not have started yet.
                    await("explore-2 working", () -> chat.get().manager.backgroundSnapshotForTests()
                            .contains("explore-2=working"));
                    return tool("p2", "send_message", "{\"to\":\"explore-2\",\"message\":\"status?\"}");
                })
                .parentSays(request -> {
                    asked.countDown();
                    return tool("p3", "wait_agents", "{\"ids\":[\"explore-2\"]}");
                })
                .parentSays(request -> {
                    releaseA.countDown();
                    return tool("p4", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        chat.set(chat(script));
        List<RunEvent> events = chat.get().run(new CancelSignal());

        List<RunEvent.AgentMessage> peer = messages(events, "peer");
        List<String> order = peer.stream()
                .filter(m -> m.text().contains("status?") || m.text().contains("two of five files read"))
                .map(m -> m.from() + ">" + m.to() + ":" + m.state()).toList();
        assertEquals(List.of("main>explore-2:sent", "main>explore-2:received",
                "explore-2>parent:sent", "explore-2>main:received"), order);
        assertTrue(history(script.childRequests.get("task B").get(1)).contains("status?"));
        record(events);
    }

    /**
     * send_message delivers first and records the message as sent afterwards.
     * The parent is held in that gap until the child has taken the message in
     * and recorded it; the stream still carries the parent's sent record
     * before the child's received record.
     */
    @Test
    void aMessageTheChildTakesInBeforeTheParentRecordsItIsStillSentFirstOnTheStream() {
        CountDownLatch delivered = new CountDownLatch(1);
        AtomicReference<Chat> chat = new AtomicReference<>();
        Script script = new Script()
                .child("task A", (request, n) -> text("A done"))
                .child("task B", (request, n) -> {
                    if (n == 1) {
                        hold(delivered, request);
                        return tool("b1", "list_dir", "{}");
                    }
                    return text("B done");
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(request -> {
                    await("explore-2 working", () -> chat.get().manager.backgroundSnapshotForTests()
                            .contains("explore-2=working"));
                    return tool("p2", "send_message", "{\"to\":\"explore-2\",\"message\":\"status?\"}");
                })
                .parentSays(tool("p3", "wait_agents", "{}"))
                .parentSays(text("done"));
        chat.set(new Chat(script, SubagentConfig.builder(), 30_000, null, null, true,
                seat -> new HeldAfterDelivery(seat, () -> {
                    delivered.countDown();
                    await("explore-2's received record, on the stream or held back",
                            () -> peerRecord(chat.get().events, "status?", "received") >= 0
                                    || chat.get().manager.heldPeerRecordsForTests() > 0);
                })));
        List<RunEvent> events = chat.get().run(new CancelSignal());

        int sent = peerRecord(events, "status?", "sent");
        int received = peerRecord(events, "status?", "received");
        assertTrue(sent >= 0 && received >= 0, "both records: sent at " + sent + ", received at " + received);
        assertTrue(sent < received, "sent at " + sent + ", received at " + received);
        assertTrue(history(script.childRequests.get("task B").getLast()).contains("status?"));
    }

    /**
     * A playbook step's child writes its records to the step's own sink. Its
     * message to the parent, taken in during a parent run, is not held on the
     * run's stream for a sent record that never comes there.
     */
    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void aStepChildsMessageToTheParentIsNotHeldOnTheRunsStream() {
        List<RunEvent> stepEvents = new CopyOnWriteArrayList<>();
        AtomicReference<Chat> chat = new AtomicReference<>();
        Script script = new Script()
                .child("step task", (request, n) -> n == 1
                        ? tool("s1", "send_message", "{\"to\":\"parent\",\"message\":\"from the step\"}")
                        : text("step done"))
                .parentSays(request -> {
                    chat.get().manager.runStep(new SubagentManager.StepChild(AgentType.EXPLORE, "step task",
                            "step task", "playbook:s", null), stepEvents::add, new CancelSignal());
                    return tool("p1", "list_dir", "{}");
                })
                .parentSays(text("done"));
        chat.set(chat(script));
        List<RunEvent> events = chat.get().run(new CancelSignal());

        assertTrue(peerRecord(stepEvents, "from the step", "sent") >= 0, "the step's sink has the sent record");
        assertTrue(peerRecord(events, "from the step", "received") >= 0, "the run's stream has the received one");
        assertEquals(-1, peerRecord(events, "from the step", "sent"));
    }

    /** Stop ends a run within a second (fdeb82fd), also when a record is held. */
    private static final java.time.Duration STOP_WITHIN = java.time.Duration.ofSeconds(1);

    /**
     * A child's send_message delivered to the parent and died before it wrote
     * its sent record. The parent's received record is held on the stream;
     * Stop lets it go, and the run ends within a second.
     */
    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void stopEndsARunWhoseChildLostItsSentRecordWithinASecond() throws InterruptedException {
        CountDownLatch releaseA = new CountDownLatch(1);
        AtomicReference<Chat> chat = new AtomicReference<>();
        AtomicReference<MessagingSeat.Sent> delivered = new AtomicReference<>();
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(releaseA, request);
                    return text("A done");
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(request -> {
                    await("explore-1 working", () -> chat.get().manager.backgroundSnapshotForTests()
                            .contains("explore-1=working"));
                    // What explore-1's send_message does up to its sent record, which never comes.
                    delivered.set(chat.get().manager.childSeat("explore-1").sendInRun(parentRow(), "lost?", "lost?",
                            true));
                    return tool("p2", "list_dir", "{}");
                })
                .parentSays(request -> {
                    releaseA.countDown();
                    return text("done");
                });
        chat.set(chat(script));
        CancelSignal stop = new CancelSignal();
        Thread runner = Thread.ofVirtual().start(() -> chat.get().run(stop));
        await("the parent's received record held", () -> chat.get().manager.heldPeerRecordsForTests() == 1);
        assertTrue(delivered.get().ok(), delivered.get().toString());

        stop.cancel();
        runner.join(STOP_WITHIN);

        assertFalse(runner.isAlive(), "the run ended within " + STOP_WITHIN + " of Stop");
        List<RunEvent> events = chat.get().events;
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.RunEnd end
                && "main".equals(agentOfRun(events, end.runId()))), "the parent's run_end is on the stream");
        assertTrue(peerRecord(events, "lost?", "received") >= 0, "the held record was written, not dropped");
    }

    /**
     * The same lost sent record in a workflow's fan-out step: Stop ends the
     * step's wait for its children within a second.
     */
    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void stopEndsAWorkflowStepsWaitWhoseChildLostItsSentRecordWithinASecond() throws InterruptedException {
        Script script = new Script().child("task W", (request, n) -> {
            hold(new CountDownLatch(1), request);
            return text("W done");
        });
        Chat chat = chat(script);
        List<RunEvent> out = new CopyOnWriteArrayList<>();
        CancelSignal stop = new CancelSignal();
        try (SubagentManager.Orchestration step = chat.manager.orchestrate(out::add, stop)) {
            step.spawn(List.of(new SubagentManager.Spawn("explore", "task W")));
            await("explore-1 working", () -> chat.manager.backgroundSnapshotForTests().contains("explore-1=working"));
            assertTrue(chat.manager.childSeat("explore-1").sendInRun(parentRow(), "lost?", "lost?", true).ok());
            Thread waiting = Thread.ofVirtual().start(step::awaitChildren);
            await("the received record held", () -> chat.manager.heldPeerRecordsForTests() == 1);

            stop.cancel();
            waiting.join(STOP_WITHIN);

            assertFalse(waiting.isAlive(), "the step's wait ended within " + STOP_WITHIN + " of Stop");
        }
        assertTrue(peerRecord(out, "lost?", "received") >= 0, "the held record was written, not dropped");
    }

    private static AgentRow parentRow() {
        return AgentRow.inRun(AgentRow.Kind.PARENT, "parent", "main", "main", "working", null);
    }

    /** @return the index of the first peer record with this state whose text contains {@code text}, or -1 */
    private static int peerRecord(List<RunEvent> events, String text, String state) {
        return indexOf(events, e -> e instanceof RunEvent.AgentMessage m && "peer".equals(m.role())
                && state.equals(m.state()) && m.text().contains(text));
    }

    /** A seat that runs a step after each delivery inside the run, before send_message records it. */
    private static final class HeldAfterDelivery implements MessagingSeat {
        private final MessagingSeat seat;
        private final Runnable afterDelivery;

        HeldAfterDelivery(MessagingSeat seat, Runnable afterDelivery) {
            this.seat = seat;
            this.afterDelivery = afterDelivery;
        }

        @Override public String selfName() { return seat.selfName(); }
        @Override public String selfRef() { return seat.selfRef(); }
        @Override public boolean child() { return seat.child(); }
        @Override public String agentId() { return seat.agentId(); }
        @Override public boolean on() { return seat.on(); }
        @Override public List<AgentRow> sessions() { return seat.sessions(); }
        @Override public List<AgentRow> runAgents() { return seat.runAgents(); }
        @Override public Sent sendToSession(AgentRow row, String text, String summary) {
            return seat.sendToSession(row, text, summary);
        }
        @Override public Sent notifyWhenIdle(AgentRow row) { return seat.notifyWhenIdle(row); }

        @Override
        public Sent sendInRun(AgentRow row, String text, String summary) {
            return sendInRun(row, text, summary, false);
        }

        @Override
        public Sent sendInRun(AgentRow row, String text, String summary, boolean recorded) {
            Sent sent = seat.sendInRun(row, text, summary, recorded);
            if (sent.ok()) {
                afterDelivery.run();
            }
            return sent;
        }
    }

    /** Where a capture run writes this run's events as a session file would
     *  hold them: the recorded background run the web tests load. */
    private static final String CAPTURE_ENV = "SPECTRO_CAPTURE_BACKGROUND_RUN";

    private static void record(List<RunEvent> events) {
        String target = System.getenv(CAPTURE_ENV);
        if (target == null || target.isBlank()) {
            return;
        }
        try {
            StringBuilder lines = new StringBuilder();
            for (RunEvent event : events) {
                lines.append(JSON.writeValueAsString(event)).append('\n');
            }
            java.nio.file.Files.writeString(Path.of(target), lines.toString());
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
    }

    // ── criterion 9 ───────────────────────────────────────────────────────

    /** Where a capture run writes the status and results run below. */
    private static final String CAPTURE_STATUS_ENV = "SPECTRO_CAPTURE_BACKGROUND_STATUS_RUN";

    @Test
    void aStatusLineAndBothWaysAResultReachesTheParentAreWrittenAsPeerMessagesItReceived() {
        CountDownLatch releaseB = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> n == 1
                        ? tool("a1", "report_status", "{\"message\":\"reading the parser\"}")
                        : text("the parser has two callers"))
                .child("task B", (request, n) -> {
                    hold(releaseB, request);
                    return text("B found the test");
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(request -> {
                    await("A's result", () -> chat9.manager.backgroundSnapshotForTests()
                            .contains("explore-1=finished"));
                    return tool("p2", "list_dir", "{}");
                })
                .parentSays(request -> {
                    Thread.ofVirtual().start(() -> {
                        try {
                            Thread.sleep(200);
                        } catch (InterruptedException ignored) {
                            Thread.currentThread().interrupt();
                        }
                        releaseB.countDown();
                    });
                    return text("waiting for B");
                })
                .parentSays(text("both in"));
        chat9 = chat(script);
        List<RunEvent> events = chat9.run(new CancelSignal());

        List<String> received = messages(events, "peer").stream()
                .map(m -> m.from() + ">" + m.to() + ":" + m.state() + ":" + m.text().lines().findFirst().orElse(""))
                .toList();
        assertEquals(List.of(
                "explore-1>main:received:Status of explore-1: reading the parser",
                "explore-1>main:received:Result of explore-1 (completed):",
                "explore-2>main:received:Result of explore-2 (completed):"), received,
                "the status line and the result the inbox held, then the result the end_turn join handed in");
        assertTrue(messages(events, "peer").get(2).text().contains("B found the test"));
        assertEquals("end_turn", stopReason(events));
        String capture = System.getenv(CAPTURE_STATUS_ENV);
        if (capture != null && !capture.isBlank()) {
            writeEvents(events, capture);
        }
    }

    /** Set by the test above, read by its own scripted turn. */
    private static volatile Chat chat9;

    /** Writes the events the way SessionStore.append does: a plain ObjectMapper, one line per event. */
    private static void writeEvents(List<RunEvent> events, String target) {
        try {
            StringBuilder lines = new StringBuilder();
            for (RunEvent event : events) {
                lines.append(JSON.writeValueAsString(event)).append('\n');
            }
            java.nio.file.Files.writeString(Path.of(target), lines.toString());
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
    }

    // ── criterion 7 ───────────────────────────────────────────────────────

    @Test
    void listAgentsShowsTheBackgroundChildrenWithRoleStatusAndLastStatusLine() {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script()
                .child("t1", (request, n) -> {
                    if (n == 1) {
                        return tool("a1", "report_status", "{\"message\":\"reading the parser\"}");
                    }
                    hold(release, request);
                    return text("done t1");
                })
                .child("t2", (request, n) -> {
                    hold(release, request);
                    return text("done t2");
                })
                .child("t3", (request, n) -> text("done t3"))
                .parentSays(tool("p1", "spawn_agents", """
                        {"background":true,"agents":[{"type":"explore","task":"t1"},{"type":"worker","task":"t2"},
                        {"type":"worker","task":"t3"}]}"""))
                .parentSays(request -> {
                    await("the status line", () -> chat2.manager.backgroundSnapshotForTests()
                            .contains("reading the parser"));
                    return tool("p2", "list_agents", "{}");
                })
                .parentSays(request -> {
                    release.countDown();
                    return text("ok");
                });
        chat2 = new Chat(script, SubagentConfig.builder().sessionsPerChat(3), 30_000, null, null, true);
        chat2.parent.setSessionsPerChat(3);
        int before = script.parentRequests.size();
        chat2.run(new CancelSignal());

        String listing = lastResult(script.parentRequests.get(2));
        assertTrue(listing.contains("explore-1") && listing.contains("explore")
                && listing.contains("reading the parser"), listing);
        assertTrue(listing.contains("worker-1") && listing.contains("worker-2"), listing);
        assertTrue(listing.contains("waiting for a slot"), "the third helper waits: " + listing);
        assertEquals(before + 4, script.parentRequests.size(),
                "spawn, list, release and the handed-in results: the listing itself asked no model");
    }

    private static volatile Chat chat2;

    // ── non-functional ────────────────────────────────────────────────────

    @Test
    void aParentWaitingOnFourChildrenSendsNoRequestUntilTheyAreDone() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        Script script = new Script();
        for (String task : List.of("w1", "w2", "w3", "w4")) {
            script.child(task, (request, n) -> {
                hold(release, request);
                return text("done " + task);
            });
        }
        script.parentSays(tool("p1", "spawn_agents", """
                        {"background":true,"agents":[{"type":"worker","task":"w1"},{"type":"worker","task":"w2"},
                        {"type":"worker","task":"w3"},{"type":"worker","task":"w4"}]}"""))
                .parentSays(tool("p2", "wait_agents", "{}"))
                .parentSays(text("all four done"));
        Chat chat = chat(script);
        Thread runner = Thread.ofVirtual().start(() -> chat.run(new CancelSignal()));
        await("four helpers at the model", () -> script.atModel.get() == 4);
        int duringWait = script.parentRequests.size();
        await("the wait call", () -> script.parentRequests.size() == 2);
        duringWait = script.parentRequests.size();
        assertTrue(script.atModel.get() == 4, "spawn and wait were both sent while the four ran");
        Thread.sleep(600);
        assertEquals(duringWait, script.parentRequests.size(), "the parent sent nothing while it waited");
        release.countDown();
        runner.join(20_000);
        assertEquals(3, script.parentRequests.size(), "spawn, wait, answer: three requests in all");
    }

}
