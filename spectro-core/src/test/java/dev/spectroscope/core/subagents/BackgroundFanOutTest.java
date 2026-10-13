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
        /** Card 594: when true, the window question fails, so a run that starts now fails before its first turn. */
        volatile boolean windowFails;
        /** Card 594, review probe R1: the next window question waits until a stop interrupts it. */
        volatile boolean holdNextWindow;
        /** Opens when the held window question is asked. */
        final CountDownLatch windowAsked = new CountDownLatch(1);

        @Override
        public int contextWindow() {
            if (windowFails) {
                throw new IllegalStateException("the window question failed");
            }
            if (holdNextWindow) {
                holdNextWindow = false;
                windowAsked.countDown();
                try {
                    Thread.sleep(20_000);
                } catch (InterruptedException stopped) {
                    // As OllamaProvider asks it: an interrupted question learns nothing.
                }
                return 0;
            }
            return 0;
        }

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
            this(provider, config, runBudgetMs, goal, maxTurns, inboxWired, seatAround, List.of(listDir()));
        }

        Chat(LlmProvider provider, SubagentConfig.Builder config, long runBudgetMs, SessionGoal goal,
             Integer maxTurns, boolean inboxWired, UnaryOperator<MessagingSeat> seatAround, List<Tool> childBelt) {
            this.manager = new SubagentManager(config.provider(provider).cwd(Path.of(".")).parentAgentId("main")
                    .onPermission(request -> true).baseTools(childBelt).build(), runBudgetMs);
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
                    // explore-2 works before the question leaves, so it answers from a later turn.
                    // A message sent before a child works waits for its first turn (card 581, below).
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

    // ── card 581: a message to a child that is not working yet waits ──────

    private static PToolCall call(String id, String name, String input) {
        return new PToolCall(id, name, json(input));
    }

    /** One parent turn that calls these tools in order. */
    private static List<ProviderEvent> tools(PToolCall... calls) {
        List<ProviderEvent> turn = new ArrayList<>(List.of(calls));
        turn.add(new PStop(PStop.StopReason.TOOL_USE));
        return turn;
    }

    /**
     * The lock of the chat's slot pool. Held on the parent's loop thread, it
     * parks every child it spawns in {@code SessionSlots.acquire}, short of
     * its slot: spawned, listed, not working, the state the card saw. This
     * relies on {@code acquire} taking the lock also when no count is set.
     */
    private static java.util.concurrent.locks.ReentrantLock slotLock(SubagentManager manager) {
        try {
            java.lang.reflect.Field pool = SubagentManager.class.getDeclaredField("slots");
            pool.setAccessible(true);
            java.lang.reflect.Field lock = SessionSlots.class.getDeclaredField("lock");
            lock.setAccessible(true);
            return (java.util.concurrent.locks.ReentrantLock) lock.get(pool.get(manager));
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }

    /** The listing line of one agent. */
    private static String rowOf(String listing, String name) {
        return listing.lines().filter(line -> line.strip().startsWith(name + " [")).findFirst()
                .orElseThrow(() -> new AssertionError("no row for " + name + " in:\n" + listing));
    }

    private static final String STATUS_TO_EXPLORE_2 = "{\"to\":\"explore-2\",\"message\":\"status?\"}";

    /**
     * The card's turn: spawn_agents and send_message together, no slot limit.
     * The children's threads have started and are parked on the slot pool's
     * lock (see {@link #slotLock}) when the message leaves, so neither works
     * yet. The message waits in explore-2's inbox and its first turn reads it.
     * {@link #aBackgroundChildTakesAMessageBeforeItsThreadHasStarted} holds
     * the threads back before they start instead.
     */
    @Test
    void aMessageSentInTheTurnThatStartsTheChildWaitsAndItsFirstTurnReadsIt() {
        AtomicReference<Chat> chat = new AtomicReference<>();
        AtomicReference<java.util.concurrent.locks.ReentrantLock> held = new AtomicReference<>();
        Script script = new Script()
                .parentSays(request -> {
                    java.util.concurrent.locks.ReentrantLock lock = slotLock(chat.get().manager);
                    lock.lock();
                    held.set(lock);
                    return tools(call("p1", "spawn_agents", TWO_IN_BACKGROUND),
                            call("p2", "send_message", STATUS_TO_EXPLORE_2),
                            call("p3", "list_agents", "{}"));
                })
                .parentSays(request -> {
                    held.get().unlock();
                    return tool("p4", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        chat.set(chat(script));
        List<RunEvent> events = chat.get().run(new CancelSignal());

        List<String> turnOne = results(script.parentRequests.get(1));
        String sent = turnOne.get(1);
        assertTrue(sent.startsWith("Sent \"status?\" to explore-2"), sent);
        String listing = turnOne.get(2);
        assertTrue(rowOf(listing, "explore-2").contains(" · starting · "), listing);
        assertFalse(listing.contains("slot"), "no slot limit holds a child of this chat: " + listing);
        assertTrue(history(script.childRequests.get("task B").getFirst()).contains("status?"),
                "explore-2 reads the message in its first turn");
        assertFalse(history(script.childRequests.get("task A").getFirst()).contains("status?"),
                "and only explore-2 reads it");
        int sentAt = peerRecord(events, "status?", "sent");
        int receivedAt = peerRecord(events, "status?", "received");
        assertTrue(sentAt >= 0 && receivedAt > sentAt, "sent at " + sentAt + ", received at " + receivedAt);
    }

    /**
     * The inbox exists when spawn_agents returns, before the children's
     * threads run at all: the threads are held until the parent's next turn.
     */
    @Test
    void aBackgroundChildTakesAMessageBeforeItsThreadHasStarted() {
        List<Runnable> notStarted = new CopyOnWriteArrayList<>();
        Script script = new Script()
                .parentSays(tools(call("p1", "spawn_agents", TWO_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_2),
                        call("p3", "list_agents", "{}")))
                .parentSays(request -> {
                    notStarted.forEach(body -> Thread.ofVirtual().start(body));
                    return tool("p4", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        Chat chat = chat(script);
        chat.manager.backgroundStarterForTests((name, body) -> notStarted.add(body));
        List<RunEvent> events = chat.run(new CancelSignal());

        assertEquals(2, notStarted.size(), "both children were held");
        List<String> turnOne = results(script.parentRequests.get(1));
        assertTrue(turnOne.get(1).startsWith("Sent \"status?\" to explore-2"), turnOne.get(1));
        assertTrue(rowOf(turnOne.get(2), "explore-2").contains(" · starting · "), turnOne.get(2));
        assertTrue(history(script.childRequests.get("task B").getFirst()).contains("status?"),
                "explore-2 reads the message in its first turn");
        int sentAt = peerRecord(events, "status?", "sent");
        int receivedAt = peerRecord(events, "status?", "received");
        assertTrue(sentAt >= 0 && receivedAt > sentAt, "sent at " + sentAt + ", received at " + receivedAt);
    }

    /**
     * A real slot limit: explore-2 waits behind explore-1's slot. The message
     * waits too, the listing names the slot, and explore-2's first turn reads
     * the message once explore-1 has given its slot back.
     */
    @Test
    void aMessageToAChildTheSlotLimitHoldsWaitsAndItsFirstTurnReadsItOnceTheSlotIsFree() {
        CountDownLatch releaseA = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(releaseA, request);
                    return text("A done");
                })
                .parentSays(tools(call("p1", "spawn_agents", TWO_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_2),
                        call("p3", "list_agents", "{}")))
                .parentSays(request -> {
                    releaseA.countDown();
                    return tool("p4", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        chat.parent.setSessionsPerChat(2);
        List<RunEvent> events = chat.run(new CancelSignal());

        List<String> turnOne = results(script.parentRequests.get(1));
        String sent = turnOne.get(1);
        assertTrue(sent.startsWith("Sent \"status?\" to explore-2"), sent);
        assertTrue(rowOf(turnOne.get(2), "explore-2").contains(" · waiting for a slot · "), turnOne.get(2));
        assertTrue(history(script.childRequests.get("task B").getFirst()).contains("status?"),
                "explore-2 reads the message in its first turn");
        int waiting = indexOf(events, e -> e instanceof RunEvent.AgentMessage m && "explore-2".equals(m.from())
                && "status".equals(m.role()) && "submitted".equals(m.state()));
        int receivedAt = peerRecord(events, "status?", "received");
        int sentAt = peerRecord(events, "status?", "sent");
        assertTrue(waiting >= 0 && receivedAt > waiting,
                "explore-2 waited for its slot, then read it: waiting at " + waiting + ", received at " + receivedAt);
        assertTrue(sentAt >= 0 && receivedAt > sentAt, "sent at " + sentAt + ", received at " + receivedAt);
    }

    /**
     * The same limit, and the parent asks only once explore-2 has shown
     * itself waiting for its slot: the message still waits for its first turn.
     */
    @Test
    void aMessageSentWhileTheChildShowsItWaitsForItsSlotWaitsForItsFirstTurn() {
        CountDownLatch releaseA = new CountDownLatch(1);
        CountDownLatch shownWaiting = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(releaseA, request);
                    return text("A done");
                })
                .parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND))
                .parentSays(request -> {
                    hold(shownWaiting, request);
                    return tools(call("p2", "send_message", STATUS_TO_EXPLORE_2), call("p3", "list_agents", "{}"));
                })
                .parentSays(request -> {
                    releaseA.countDown();
                    return tool("p4", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        chat.parent.setSessionsPerChat(2);
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = chat.manager.run(chat.parent, "go", new RunOptions(new CancelSignal(), null))) {
            for (RunEvent event : stream) {
                events.add(event);
                if (event instanceof RunEvent.AgentMessage m && "explore-2".equals(m.from())
                        && "status".equals(m.role()) && "submitted".equals(m.state())) {
                    shownWaiting.countDown();
                }
            }
        }

        List<String> turnTwo = results(script.parentRequests.get(2));
        assertTrue(turnTwo.get(1).startsWith("Sent \"status?\" to explore-2"), turnTwo.toString());
        assertTrue(rowOf(turnTwo.get(2), "explore-2").contains(" · waiting for a slot · "), turnTwo.get(2));
        assertTrue(history(script.childRequests.get("task B").getFirst()).contains("status?"),
                "explore-2 reads the message in its first turn");
    }

    /**
     * The operator's reply from the page reaches a blocking child that waits
     * for its slot the same way: it waits in its inbox and the child's first
     * turn reads it.
     */
    @Test
    void anOperatorsMessageToABlockingChildThatWaitsForItsSlotWaitsAndItsFirstTurnReadsIt() {
        CountDownLatch releaseA = new CountDownLatch(1);
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(releaseA, request);
                    return text("A done");
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"},{\"type\":\"explore\",\"task\":\"task B\"}]}"))
                .parentSays(text("both done"));
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        chat.parent.setSessionsPerChat(2);
        String childB = null;
        MessagingSeat.Sent sent = null;
        try (EventStream stream = chat.manager.run(chat.parent, "go", new RunOptions(new CancelSignal(), null))) {
            for (RunEvent event : stream) {
                if (event instanceof RunEvent.AgentSpawn spawn && "task B".equals(spawn.task())) {
                    childB = spawn.agentId();
                }
                if (event instanceof RunEvent.AgentMessage m && "status".equals(m.role())
                        && "submitted".equals(m.state()) && m.from().equals(childB)) {
                    // Task B waits behind task A's slot, which task A keeps until it is released here.
                    sent = chat.manager.sendFromOperator(childB, "hello from the page", null);
                    releaseA.countDown();
                }
            }
        }
        assertTrue(sent != null && sent.ok(), "the reply left: " + sent);
        assertTrue(history(script.childRequests.get("task B").getFirst()).contains("hello from the page"),
                "task B reads the reply in its first turn");
    }

    @Test
    void aMessageToABackgroundChildThatHasEndedIsRefusedAsEnded() {
        Script script = new Script()
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(tool("p2", "wait_agents", "{}"))
                .parentSays(tool("p3", "send_message", "{\"to\":\"explore-1\",\"message\":\"one more thing\"}"))
                .parentSays(text("done"));
        chat(script).run(new CancelSignal());

        assertEquals("ERROR: Not sent: explore-1 has ended; collect its result with wait_agents.",
                lastResult(script.parentRequests.get(3)));
    }

    @Test
    void aMessageToABlockingChildThatHasEndedIsRefusedAsEnded() {
        Script script = new Script()
                .parentSays(tool("p1", "spawn_agents", "{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(tool("p2", "send_message", "{\"to\":\"explore-1\",\"message\":\"one more thing\"}"))
                .parentSays(text("done"));
        chat(script).run(new CancelSignal());

        assertEquals("ERROR: Not sent: explore-1 has ended and reads no more messages.",
                lastResult(script.parentRequests.get(2)));
    }

    @Test
    void aMessageToAChildThatDoesNotExistIsRefusedAsUnknown() {
        Script script = new Script()
                .parentSays(tools(call("p1", "spawn_agents",
                                "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"),
                        call("p2", "send_message", "{\"to\":\"explore-7\",\"message\":\"anyone?\"}")))
                .parentSays(tool("p3", "wait_agents", "{}"))
                .parentSays(text("done"));
        chat(script).run(new CancelSignal());

        assertEquals("ERROR: Not sent: no agent named 'explore-7' is reachable; call list_agents to see who is"
                + " reachable now.", results(script.parentRequests.get(1)).get(1));
    }

    /**
     * A child that ends while it still waits for its slot never ran: its
     * address leaves with it, and a later message is refused as to a child
     * that has ended.
     */
    @Test
    void aChildThatEndsBeforeItsSlotCameFreeLeavesNoAddressBehind() {
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tools(call("p1", "spawn_agents", TWO_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_2)))
                .parentSays(text("out of turns"));
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(2), 30_000, null, 2, true);
        chat.parent.setSessionsPerChat(2);
        List<RunEvent> events = chat.run(new CancelSignal());

        assertTrue(results(script.parentRequests.get(1)).get(1).startsWith("Sent \"status?\" to explore-2"),
                results(script.parentRequests.get(1)).toString());
        String resultB = messages(events, "result").stream().filter(m -> "explore-2".equals(m.from()))
                .findFirst().orElseThrow().text();
        assertTrue(resultB.endsWith("while it waited for a free slot."), resultB);
        assertFalse(script.childRequests.containsKey("task B"), "explore-2 never reached the model");
        assertFalse(chat.manager.isChild("explore-2"), "its address left with it");
        assertTrue(chat.manager.inboxOf("explore-2") == null, "and its inbox");
        MessagingSeat.Sent late = chat.manager.sendFromOperator("explore-2", "late", null);
        assertEquals("Not sent: explore-2 has ended and reads no more messages.", late.error());
    }

    // ── card 581 fix round: every registration leaves; step children too ──

    /** The child inboxes and slot tickets the manager still holds. */
    @SuppressWarnings("unchecked")
    private static String registrations(SubagentManager manager) {
        try {
            java.lang.reflect.Field inboxes = SubagentManager.class.getDeclaredField("childInboxes");
            java.lang.reflect.Field tickets = SubagentManager.class.getDeclaredField("childTickets");
            inboxes.setAccessible(true);
            tickets.setAccessible(true);
            return "inboxes=" + ((Map<String, ?>) inboxes.get(manager)).size()
                    + " tickets=" + ((Map<String, ?>) tickets.get(manager)).size();
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }

    private static SessionSlots slotsOf(SubagentManager manager) {
        try {
            java.lang.reflect.Field pool = SubagentManager.class.getDeclaredField("slots");
            pool.setAccessible(true);
            return (SessionSlots) pool.get(manager);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }

    private static boolean waitingStatus(RunEvent event, String child) {
        return event instanceof RunEvent.AgentMessage m && child.equals(m.from()) && "status".equals(m.role())
                && "submitted".equals(m.state());
    }

    private static final SubagentManager.StepChild STEP = new SubagentManager.StepChild(AgentType.EXPLORE,
            "task S", "task S", "playbook:s1", null);

    /** A step whose sink fails on the spawn record leaves no address: nobody would read a message to it. */
    @Test
    void aStepWhoseSinkFailsOnTheSpawnRecordLeavesNoAddressBehind() {
        Chat chat = chat(new Script());
        RuntimeException thrown = null;
        try {
            chat.manager.runStep(STEP, event -> {
                if (event instanceof RunEvent.AgentSpawn) {
                    throw new IllegalStateException("sink closed");
                }
            }, new CancelSignal());
        } catch (RuntimeException e) {
            thrown = e;
        }
        assertTrue(thrown != null && "sink closed".equals(thrown.getMessage()), "premise: the sink threw");
        assertEquals("inboxes=0 tickets=0", registrations(chat.manager));
        assertFalse(chat.manager.isChild("explore-1"));
        assertFalse(chat.manager.sendFromOperator("explore-1", "hello?", null).ok(),
                "a reply to it is refused, not queued for nobody");
    }

    /** A step whose sink fails on the waiting record leaves no address either. */
    @Test
    void aStepWhoseSinkFailsOnTheWaitingRecordLeavesNoAddressBehind() {
        Chat chat = new Chat(new Script(), SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        SessionSlots slots = slotsOf(chat.manager);
        SessionSlots.Ticket blocker = slots.enqueue();
        assertTrue(slots.acquire(blocker, () -> SessionCount.of(2), new CancelSignal()), "premise: the slot is held");
        RuntimeException thrown = null;
        try {
            chat.manager.runStep(STEP, event -> {
                if (waitingStatus(event, "explore-1")) {
                    throw new IllegalStateException("sink closed");
                }
            }, new CancelSignal());
        } catch (RuntimeException e) {
            thrown = e;
        } finally {
            slots.release();
        }
        assertTrue(thrown != null && "sink closed".equals(thrown.getMessage()), "premise: the sink threw");
        assertEquals("inboxes=0 tickets=0", registrations(chat.manager));
    }

    /**
     * A playbook step child that waits for the chat's only slot takes the
     * operator's reply, and its first turn reads it.
     */
    @Test
    void aStepChildThatWaitsForItsSlotReadsTheOperatorsMessageInItsFirstTurn() throws Exception {
        Script script = new Script();
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        SessionSlots slots = slotsOf(chat.manager);
        SessionSlots.Ticket blocker = slots.enqueue();
        assertTrue(slots.acquire(blocker, () -> SessionCount.of(2), new CancelSignal()), "premise: the slot is held");
        CountDownLatch waiting = new CountDownLatch(1);
        AtomicReference<SubagentManager.StepResult> result = new AtomicReference<>();
        Thread step = Thread.ofVirtual().start(() -> result.set(chat.manager.runStep(STEP, event -> {
            if (waitingStatus(event, "explore-1")) {
                waiting.countDown();
            }
        }, new CancelSignal())));
        assertTrue(waiting.await(20, TimeUnit.SECONDS), "the step child shows it waits for its slot");
        MessagingSeat.Sent sent = chat.manager.sendFromOperator("explore-1", "hello step", null);
        slots.release();
        step.join(20_000);

        assertTrue(sent.ok(), "the reply left: " + sent);
        assertFalse(result.get().failed(), result.get().outcome());
        assertTrue(history(script.childRequests.get("task S").getFirst()).contains("hello step"),
                "the step child reads the reply in its first turn");
        assertEquals("inboxes=0 tickets=0", registrations(chat.manager));
    }

    /**
     * A background child whose thread cannot be started leaves no address, no
     * ticket and no child the run would wait for; the spawn call fails.
     */
    @Test
    void aBackgroundChildWhoseThreadCannotStartLeavesNothingBehind() {
        Script script = new Script().parentSays(tool("p1", "spawn_agents", TWO_IN_BACKGROUND));
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(3), 30_000, null, null, true);
        chat.parent.setSessionsPerChat(3);
        chat.manager.backgroundStarterForTests((name, body) -> {
            throw new IllegalStateException("no thread for " + name);
        });
        long started = System.nanoTime();
        List<RunEvent> events = chat.run(new CancelSignal());
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);

        assertEquals("error", stopReason(events), "the spawn call failed the run");
        assertEquals("inboxes=0 tickets=0", registrations(chat.manager));
        assertEquals(0, chat.manager.slotsQueued(), "no ticket of the batch is left in line");
        assertFalse(chat.manager.isChild("explore-1"));
        assertTrue(tookMs < BackgroundRun.SETTLE_MS, "the run's end waited for no child: " + tookMs + " ms");
        assertTrue(messages(events, "result").stream().anyMatch(m -> "explore-1".equals(m.from())
                && "failed".equals(m.state()) && m.text().contains("did not start")), events.toString());
    }

    /**
     * A background child whose agent cannot be built fails inside
     * executeChild after its slot and before its run. Its address leaves on
     * that way out too: no spawn site releases a background child.
     */
    @Test
    void aBackgroundChildWhoseAgentCannotBeBuiltLeavesNoAddressBehind() {
        Tool broken = new Tool() {
            public String name() { throw new IllegalStateException("broken belt"); }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
        Script script = new Script()
                .parentSays(tool("p1", "spawn_agents",
                        "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(tool("p2", "wait_agents", "{}"))
                .parentSays(text("done"));
        Chat chat = new Chat(script, SubagentConfig.builder(), 30_000, null, null, true, UnaryOperator.identity(),
                List.of(broken));
        List<RunEvent> events = chat.run(new CancelSignal());

        String result = messages(events, "result").getFirst().text();
        assertTrue(result.startsWith("ERROR: [explore-1] unexpected failure: broken belt"), result);
        assertEquals("inboxes=0 tickets=0", registrations(chat.manager));
        assertFalse(chat.manager.isChild("explore-1"));
    }

    // ── card 594: a message to a helper that ends unread comes back ───────

    private static final String ONE_IN_BACKGROUND =
            "{\"background\":true,\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}";

    private static final String STATUS_TO_EXPLORE_1 = "{\"to\":\"explore-1\",\"message\":\"status?\"}";

    /** The one message of the run that came back to its sender. */
    private static RunEvent.AgentMessage theOnlyReturned(List<RunEvent> events) {
        List<RunEvent.AgentMessage> back = messages(events, "peer").stream()
                .filter(m -> "returned".equals(m.state())).toList();
        assertEquals(1, back.size(), "one message came back: " + messages(events, "peer"));
        return back.getFirst();
    }

    /** The msg id the sent record of {@code text} carries. */
    private static String sentMsgId(List<RunEvent> events, String text) {
        return messages(events, "peer").stream().filter(m -> "sent".equals(m.state()) && text.equals(m.text()))
                .findFirst().orElseThrow(() -> new AssertionError("no sent record of " + text)).label();
    }

    /**
     * The reason a returned line names, read from the child's own result record
     * and trimmed the way SubagentManager.howItEnded trims it: the first line of
     * the ERROR string without the prefix, the child's id and the closing period.
     */
    private static String reasonOf(List<RunEvent> events, String child) {
        String result = messages(events, "result").stream().filter(m -> child.equals(m.from())).findFirst()
                .orElseThrow(() -> new AssertionError("no result record of " + child)).text();
        String tag = "ERROR: [" + child + "] ";
        assertTrue(result.startsWith(tag), "premise: " + child + " ended with an error: " + result);
        return result.substring(tag.length()).lines().findFirst().orElse("").replaceFirst("\\.$", "");
    }

    /** A child belt whose tool cannot name itself, so a child's agent cannot be built. */
    private static Tool brokenBelt() {
        return new Tool() {
            public String name() { throw new IllegalStateException("broken belt"); }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    /**
     * The card's scenario: explore-1 and explore-2 on one free slot, a message
     * to explore-2 while it waits for its slot, and a stop before explore-2
     * starts. The message comes back from explore-2 to the parent under the
     * sent record's msg_id, and the model reads the same line at the start of
     * its next run.
     */
    @Test
    void aMessageToAChildStoppedBeforeItsSlotComesBackAndTheModelReadsTheSameLine() {
        CancelSignal stop = new CancelSignal();
        Script script = new Script();
        script.child("task A", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tools(call("p1", "spawn_agents", TWO_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_2)))
                .parentSays(request -> {
                    Thread.ofVirtual().start(() -> {
                        await("explore-1 at the model", () -> script.atModel.get() == 1);
                        stop.cancel();
                    });
                    return tool("p3", "wait_agents", "{}");
                })
                .parentSays(text("noted"));
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        chat.parent.setSessionsPerChat(2);
        List<RunEvent> events = chat.run(stop);
        // The stopped run may still ask once more, with the stop already set; the next run starts here.
        int nextRun = script.parentRequests.size();
        chat.run(new CancelSignal());

        assertTrue(script.parentRequests.size() > nextRun, "premise: the next run asked the model");
        assertTrue(results(script.parentRequests.get(1)).get(1).startsWith("Sent \"status?\" to explore-2"),
                "premise: the message was taken: " + results(script.parentRequests.get(1)));
        assertFalse(script.childRequests.containsKey("task B"), "premise: explore-2 never reached the model");
        assertEquals(-1, peerRecord(events, "status?", "received"), "premise: nobody read the message");
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals("explore-2", back.from());
        assertEquals("main", back.to());
        assertEquals(sentMsgId(events, "status?"), back.label(), "it names the message it hands back");
        String reason = reasonOf(events, "explore-2");
        assertTrue(reason.endsWith("while it waited for a free slot"), "premise: it ended waiting: " + reason);
        assertTrue(back.text().contains("explore-2") && back.text().contains("status?")
                && back.text().contains("(" + reason + ")"), "the line names how explore-2 ended: " + back.text());
        assertTrue(indexOf(events, e -> e == back) > peerRecord(events, "status?", "sent"),
                "the message comes back after it was sent");
        assertTrue(history(script.parentRequests.get(nextRun)).contains(back.text()),
                "the model reads the same line at its next turn");
    }

    /**
     * The operator's reply to a blocking child that waits for its slot, and a
     * stop before the child starts. The reply comes back to the operator; the
     * model sent nothing and reads nothing about it.
     */
    @Test
    void anOperatorsMessageToABlockingChildStoppedBeforeItsSlotComesBackToTheOperator() {
        CancelSignal stop = new CancelSignal();
        Script script = new Script()
                .child("task A", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tool("p1", "spawn_agents",
                        "{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"},{\"type\":\"explore\",\"task\":\"task B\"}]}"));
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        chat.parent.setSessionsPerChat(2);
        List<RunEvent> events = new ArrayList<>();
        String childB = null;
        MessagingSeat.Sent sent = null;
        try (EventStream stream = chat.manager.run(chat.parent, "go", new RunOptions(stop, null))) {
            for (RunEvent event : stream) {
                events.add(event);
                if (event instanceof RunEvent.AgentSpawn spawn && "task B".equals(spawn.task())) {
                    childB = spawn.agentId();
                }
                if (sent == null && childB != null && waitingStatus(event, childB)) {
                    sent = chat.manager.sendFromOperator(childB, "hello from the page", null);
                    stop.cancel();
                }
            }
        }

        assertTrue(sent != null && sent.ok(), "premise: the reply was taken: " + sent);
        assertFalse(script.childRequests.containsKey("task B"), "premise: the child never reached the model");
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals(childB, back.from());
        assertEquals("operator", back.to());
        assertEquals(sent.msgId(), back.label(), "it names the reply it hands back");
        assertTrue(back.text().contains("hello from the page")
                && back.text().contains("while it waited for a free slot"), back.text());
        assertFalse(back.text().contains("Do not wait for a reply"),
                "the operator's line gives the model no advice: " + back.text());
        assertEquals(List.of(), chat.inbox.takeNotices(), "the model sent nothing and reads nothing about it");
    }

    /**
     * A background child whose thread cannot start, with the operator's reply
     * already in its inbox: the reply comes back, naming "did not start".
     */
    @Test
    void anOperatorsMessageToABackgroundChildThatDidNotStartComesBack() {
        Script script = new Script().parentSays(tool("p1", "spawn_agents", ONE_IN_BACKGROUND));
        Chat chat = chat(script);
        AtomicReference<MessagingSeat.Sent> sent = new AtomicReference<>();
        chat.manager.backgroundStarterForTests((name, body) -> {
            // The page saw the spawn record and replied before the thread failed to start.
            sent.set(chat.manager.sendFromOperator("explore-1", "are you there?", null));
            throw new IllegalStateException("no thread for " + name);
        });
        List<RunEvent> events = chat.run(new CancelSignal());

        assertTrue(sent.get() != null && sent.get().ok(), "premise: the reply was taken: " + sent.get());
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals("explore-1", back.from());
        assertEquals("operator", back.to());
        assertEquals(sent.get().msgId(), back.label());
        assertTrue(back.text().contains("are you there?") && back.text().contains("did not start"), back.text());
    }

    /**
     * A background child whose agent cannot be built fails after its slot and
     * before its first turn. The model's message comes back, and the model
     * reads the line in the turn after wait_agents.
     */
    @Test
    void aMessageToAChildWhoseAgentCannotBeBuiltComesBackAndTheModelReadsIt() {
        List<Runnable> held = new CopyOnWriteArrayList<>();
        Script script = new Script()
                .parentSays(tools(call("p1", "spawn_agents", ONE_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_1)))
                .parentSays(request -> {
                    held.forEach(body -> Thread.ofVirtual().start(body));
                    return tool("p3", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        Chat chat = new Chat(script, SubagentConfig.builder(), 30_000, null, null, true, UnaryOperator.identity(),
                List.of(brokenBelt()));
        chat.manager.backgroundStarterForTests((name, body) -> held.add(body));
        List<RunEvent> events = chat.run(new CancelSignal());

        assertTrue(results(script.parentRequests.get(1)).get(1).startsWith("Sent \"status?\" to explore-1"),
                "premise: the message was taken: " + results(script.parentRequests.get(1)));
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals("explore-1", back.from());
        assertEquals("main", back.to());
        assertTrue(back.text().contains("status?") && back.text().contains("unexpected failure: broken belt"),
                back.text());
        assertTrue(history(script.parentRequests.get(2)).contains(back.text()),
                "the model reads the same line after wait_agents");
    }

    /**
     * A background child whose run fails while it starts: its own loop closes
     * its inbox before the first turn, with the model's message unread. The
     * message comes back, and the model reads it after wait_agents.
     */
    @Test
    void aMessageToAChildWhoseRunFailsBeforeItsFirstTurnComesBack() {
        List<Runnable> held = new CopyOnWriteArrayList<>();
        Script script = new Script();
        script.parentSays(request -> {
                    script.windowFails = true; // the parent's run asked already; a run that starts now fails
                    return tools(call("p1", "spawn_agents", ONE_IN_BACKGROUND),
                            call("p2", "send_message", STATUS_TO_EXPLORE_1));
                })
                .parentSays(request -> {
                    held.forEach(body -> Thread.ofVirtual().start(body));
                    return tool("p3", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        Chat chat = chat(script);
        chat.manager.backgroundStarterForTests((name, body) -> held.add(body));
        List<RunEvent> events = chat.run(new CancelSignal());

        assertTrue(results(script.parentRequests.get(1)).get(1).startsWith("Sent \"status?\" to explore-1"),
                "premise: the message was taken: " + results(script.parentRequests.get(1)));
        assertFalse(script.childRequests.containsKey("task A"), "premise: explore-1 sent no request");
        assertEquals(-1, peerRecord(events, "status?", "received"), "premise: it never read the message");
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals("explore-1", back.from());
        assertTrue(back.text().contains("status?") && back.text().contains("returned no final text"), back.text());
        assertTrue(history(script.parentRequests.get(2)).contains(back.text()),
                "the model reads the same line after wait_agents");
    }

    /**
     * A playbook step child that waits for the chat's only slot takes the
     * operator's reply, and the step is stopped before the child ever runs.
     * The reply comes back on the step's own stream.
     */
    @Test
    void anOperatorsMessageToAStepChildThatNeverRanComesBackOnTheStepsStream() throws Exception {
        Chat chat = new Chat(new Script(), SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        SessionSlots slots = slotsOf(chat.manager);
        SessionSlots.Ticket blocker = slots.enqueue();
        assertTrue(slots.acquire(blocker, () -> SessionCount.of(2), new CancelSignal()), "premise: the slot is held");
        CancelSignal stepStop = new CancelSignal();
        List<RunEvent> stepEvents = new CopyOnWriteArrayList<>();
        CountDownLatch waiting = new CountDownLatch(1);
        AtomicReference<SubagentManager.StepResult> result = new AtomicReference<>();
        MessagingSeat.Sent sent;
        try {
            Thread step = Thread.ofVirtual().start(() -> result.set(chat.manager.runStep(STEP, event -> {
                stepEvents.add(event);
                if (waitingStatus(event, "explore-1")) {
                    waiting.countDown();
                }
            }, stepStop)));
            assertTrue(waiting.await(20, TimeUnit.SECONDS), "the step child shows it waits for its slot");
            sent = chat.manager.sendFromOperator("explore-1", "hello step", null);
            stepStop.cancel();
            step.join(20_000);
        } finally {
            slots.release();
        }

        assertTrue(sent.ok(), "premise: the reply was taken: " + sent);
        assertTrue(result.get().outcome().endsWith("while it waited for a free slot."), result.get().outcome());
        RunEvent.AgentMessage back = theOnlyReturned(stepEvents);
        assertEquals("explore-1", back.from());
        assertEquals("operator", back.to());
        assertEquals(sent.msgId(), back.label());
        assertTrue(back.text().contains("hello step"), back.text());
        assertEquals(List.of(), chat.inbox.takeNotices(), "the model sent nothing and reads nothing about it");
    }

    /**
     * A working child that is stopped while the parent's message waits for its
     * next turn: its own loop ends without reading it, and the message comes
     * back.
     */
    @Test
    void aMessageToAWorkingChildThatIsStoppedBeforeItsNextTurnComesBack() {
        CancelSignal stop = new CancelSignal();
        Script script = new Script();
        script.child("task A", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tool("p1", "spawn_agents", ONE_IN_BACKGROUND))
                .parentSays(request -> {
                    await("explore-1 at the model", () -> script.atModel.get() == 1);
                    return tool("p2", "send_message", STATUS_TO_EXPLORE_1);
                })
                .parentSays(request -> {
                    Thread.ofVirtual().start(stop::cancel);
                    return tool("p3", "wait_agents", "{}");
                });
        Chat chat = chat(script);
        List<RunEvent> events = chat.run(stop);
        // The stopped run may still ask once more, with the stop already set; the next run starts here.
        int nextRun = script.parentRequests.size();
        chat.run(new CancelSignal());

        assertTrue(lastResult(script.parentRequests.get(2)).startsWith("Sent \"status?\" to explore-1"),
                "premise: the message was taken: " + lastResult(script.parentRequests.get(2)));
        assertEquals(1, script.childRequests.get("task A").size(), "premise: explore-1 was in its first turn");
        assertEquals(-1, peerRecord(events, "status?", "received"), "premise: it never read the message");
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals("explore-1", back.from());
        assertTrue(back.text().contains("status?") && back.text().contains("(" + reasonOf(events, "explore-1") + ")"),
                "the line names how explore-1 ended: " + back.text());
        assertTrue(script.parentRequests.size() > nextRun, "premise: the next run asked the model");
        assertTrue(history(script.parentRequests.get(nextRun)).contains(back.text()),
                "the model reads the same line at its next turn");
    }

    /**
     * Criterion 2: a message the helper read never comes back, and a message
     * to it after it ended is refused as ended, as before.
     */
    @Test
    void aMessageTheHelperReadNeverComesBackAndALaterOneIsRefusedAsEnded() {
        List<Runnable> held = new CopyOnWriteArrayList<>();
        Script script = new Script()
                .parentSays(tools(call("p1", "spawn_agents", ONE_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_1)))
                .parentSays(request -> {
                    held.forEach(body -> Thread.ofVirtual().start(body));
                    return tool("p3", "wait_agents", "{}");
                })
                .parentSays(tool("p4", "send_message", "{\"to\":\"explore-1\",\"message\":\"one more thing\"}"))
                .parentSays(text("done"));
        Chat chat = chat(script);
        chat.manager.backgroundStarterForTests((name, body) -> held.add(body));
        List<RunEvent> events = chat.run(new CancelSignal());

        assertTrue(history(script.childRequests.get("task A").getFirst()).contains("status?"),
                "premise: explore-1 read the message in its first turn");
        assertTrue(peerRecord(events, "status?", "received") >= 0, "premise: its loop recorded it as read");
        assertTrue(messages(events, "peer").stream().noneMatch(m -> "returned".equals(m.state())),
                "a message the helper read never comes back: " + messages(events, "peer"));
        assertEquals("ERROR: Not sent: explore-1 has ended; collect its result with wait_agents.",
                lastResult(script.parentRequests.get(3)));
        assertEquals(List.of(), chat.inbox.takeNotices(), "the model reads no line about either message");
    }

    // ── card 594 fix round 1: a message is read once its request goes out ──

    /**
     * Review 1, I1 (probe R1): the stop lands while the helper, holding its
     * slot, asks for its context window, so its first turn starts with the
     * stop set and its request never goes out. The message that turn took
     * comes back, and no received record claims it was read.
     */
    @Test
    void aMessageToAChildStoppedAfterItsSlotBeforeItsFirstTurnComesBack() {
        CancelSignal stop = new CancelSignal();
        List<Boolean> stoppedAtRequest = new CopyOnWriteArrayList<>();
        Script script = new Script();
        script.child("task A", (request, n) -> {
                    stoppedAtRequest.add(request.signal() != null && request.signal().isCancelled());
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(request -> {
                    script.holdNextWindow = true; // the child starts after this turn and waits in its window question
                    return tools(call("p1", "spawn_agents", ONE_IN_BACKGROUND),
                            call("p2", "send_message", STATUS_TO_EXPLORE_1));
                })
                .parentSays(request -> {
                    Thread.ofVirtual().start(() -> {
                        try {
                            script.windowAsked.await(20, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        stop.cancel();
                    });
                    return tool("p3", "wait_agents", "{}");
                });
        Chat chat = chat(script);
        List<RunEvent> events = chat.run(stop);

        assertTrue(results(script.parentRequests.get(1)).get(1).startsWith("Sent \"status?\" to explore-1"),
                "premise: the message was taken: " + results(script.parentRequests.get(1)));
        assertEquals(0L, script.windowAsked.getCount(), "premise: explore-1 held its slot and asked its window");
        assertEquals(List.of(true), stoppedAtRequest, "premise: its first request was made with the stop set");
        assertEquals(-1, peerRecord(events, "status?", "received"), "a request that never went out read nothing");
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals("explore-1", back.from());
        assertTrue(back.text().contains("status?"), back.text());
    }

    /**
     * Review 1, I1 (probe R3): a working helper is stopped while one of its
     * tools runs. Its next turn starts with the stop set and its request never
     * goes out, so the message that waited for that turn comes back.
     */
    @Test
    void aMessageToAChildStoppedInsideAToolCallComesBack() {
        CancelSignal stop = new CancelSignal();
        CountDownLatch inTool = new CountDownLatch(1);
        List<Boolean> stoppedAtRequest = new CopyOnWriteArrayList<>();
        Tool blocking = new Tool() {
            public String name() { return "list_dir"; }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) {
                inTool.countDown();
                long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
                while (!context.signal().isCancelled() && System.nanoTime() < until) {
                    try {
                        Thread.sleep(10);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                return "ok";
            }
        };
        Script script = new Script();
        script.child("task A", (request, n) -> {
                    if (n == 1) {
                        return tool("c1", "list_dir", "{}");
                    }
                    stoppedAtRequest.add(request.signal() != null && request.signal().isCancelled());
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tool("p1", "spawn_agents", ONE_IN_BACKGROUND))
                .parentSays(request -> {
                    await("explore-1 inside its tool call", () -> inTool.getCount() == 0);
                    return tool("p2", "send_message", STATUS_TO_EXPLORE_1);
                })
                .parentSays(request -> {
                    Thread.ofVirtual().start(stop::cancel);
                    return tool("p3", "wait_agents", "{}");
                });
        Chat chat = new Chat(script, SubagentConfig.builder(), 30_000, null, null, true, UnaryOperator.identity(),
                List.of(blocking));
        List<RunEvent> events = chat.run(stop);

        assertTrue(lastResult(script.parentRequests.get(2)).startsWith("Sent \"status?\" to explore-1"),
                "premise: the message was taken: " + lastResult(script.parentRequests.get(2)));
        assertEquals(List.of(true), stoppedAtRequest, "premise: the turn after the tool asked with the stop set");
        assertEquals(-1, peerRecord(events, "status?", "received"), "a request that never went out read nothing");
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals("explore-1", back.from());
        assertTrue(back.text().contains("status?"), back.text());
    }

    /**
     * The stop lands after the helper's turn took the message and handed its
     * request to the provider, before the provider dialled it or answered.
     * The request never went out, so the message comes back.
     */
    @Test
    void aMessageInARequestTheStopEndsBeforeItGoesOutComesBack() {
        CancelSignal stop = new CancelSignal();
        List<Runnable> held = new CopyOnWriteArrayList<>();
        Script script = new Script()
                .child("task A", (request, n) -> {
                    stop.cancel(); // the provider holds the request; nothing was dialled or answered
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tools(call("p1", "spawn_agents", ONE_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_1)))
                .parentSays(request -> {
                    held.forEach(body -> Thread.ofVirtual().start(body));
                    return tool("p3", "wait_agents", "{}");
                });
        Chat chat = chat(script);
        chat.manager.backgroundStarterForTests((name, body) -> held.add(body));
        List<RunEvent> events = chat.run(stop);

        assertTrue(history(script.childRequests.get("task A").getFirst()).contains("status?"),
                "premise: the turn put the message into the request it handed over");
        assertEquals(-1, peerRecord(events, "status?", "received"), "a request that never went out read nothing");
        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertEquals("explore-1", back.from());
        assertTrue(back.text().contains("status?"), back.text());
    }

    /**
     * The other side of the line: once the provider dialled the request that
     * carries the message, the message counts as read, even when the stop then
     * ends the turn before any answer.
     */
    @Test
    void aMessageInARequestThatWentOutIsReadEvenWhenTheStopEndsTheTurn() {
        CancelSignal stop = new CancelSignal();
        List<Runnable> held = new CopyOnWriteArrayList<>();
        AtomicReference<Boolean> dialled = new AtomicReference<>(false);
        Script script = new Script()
                .child("task A", (request, n) -> {
                    if (request.tap() != null) {
                        request.tap().begin(new dev.spectroscope.core.wire.LlmWireTap.WireRequest("script", "m",
                                "http", "POST", "http://localhost/script", Map.of(), "bytes", "{}", 0L));
                        dialled.set(true);
                    }
                    stop.cancel(); // dialled, then stopped before any answer
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tools(call("p1", "spawn_agents", ONE_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_1)))
                .parentSays(request -> {
                    held.forEach(body -> Thread.ofVirtual().start(body));
                    return tool("p3", "wait_agents", "{}");
                });
        Chat chat = chat(script);
        chat.manager.backgroundStarterForTests((name, body) -> held.add(body));
        List<RunEvent> events = chat.run(stop);

        assertTrue(history(script.childRequests.get("task A").getFirst()).contains("status?"),
                "premise: the request carried the message");
        assertTrue(dialled.get(), "premise: the provider dialled the request through its tap");
        assertTrue(peerRecord(events, "status?", "received") >= 0, "the request went out, so the message was read");
        assertTrue(messages(events, "peer").stream().noneMatch(m -> "returned".equals(m.state())),
                "and it does not come back: " + messages(events, "peer"));
    }

    /**
     * A request that went out and then failed in the provider still went out:
     * the message counts as read and does not come back.
     */
    @Test
    void aMessageInARequestThatWentOutIsReadEvenWhenTheProviderThenFails() {
        List<Runnable> held = new CopyOnWriteArrayList<>();
        AtomicReference<Boolean> dialled = new AtomicReference<>(false);
        Script script = new Script()
                .child("task A", (request, n) -> {
                    if (request.tap() != null) {
                        request.tap().begin(new dev.spectroscope.core.wire.LlmWireTap.WireRequest("script", "m",
                                "http", "POST", "http://localhost/script", Map.of(), "bytes", "{}", 0L));
                        dialled.set(true);
                    }
                    throw new IllegalStateException("the backend failed after the request went out");
                })
                .parentSays(tools(call("p1", "spawn_agents", ONE_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_1)))
                .parentSays(request -> {
                    held.forEach(body -> Thread.ofVirtual().start(body));
                    return tool("p3", "wait_agents", "{}");
                })
                .parentSays(text("done"));
        Chat chat = chat(script);
        chat.manager.backgroundStarterForTests((name, body) -> held.add(body));
        List<RunEvent> events = chat.run(new CancelSignal());

        assertTrue(history(script.childRequests.get("task A").getFirst()).contains("status?"),
                "premise: the request carried the message");
        assertTrue(dialled.get(), "premise: the provider dialled the request through its tap");
        assertTrue(peerRecord(events, "status?", "received") >= 0, "the request went out, so the message was read");
        assertTrue(messages(events, "peer").stream().noneMatch(m -> "returned".equals(m.state())),
                "and it does not come back: " + messages(events, "peer"));
    }

    /**
     * Review 1, probe R2: the model and the operator both write to a helper
     * that waits for its slot, and the helper is stopped before it starts.
     * Each message comes back once, to its own sender, and the model reads
     * only its own line, once.
     */
    @Test
    void twoSendersToAChildStoppedBeforeItsSlotEachGetTheirOwnLineOnce() {
        CancelSignal stop = new CancelSignal();
        AtomicReference<Chat> chatRef = new AtomicReference<>();
        AtomicReference<MessagingSeat.Sent> fromPage = new AtomicReference<>();
        Script script = new Script();
        script.child("task A", (request, n) -> {
                    hold(new CountDownLatch(1), request);
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                })
                .parentSays(tools(call("p1", "spawn_agents", TWO_IN_BACKGROUND),
                        call("p2", "send_message", STATUS_TO_EXPLORE_2)))
                .parentSays(request -> {
                    fromPage.set(chatRef.get().manager.sendFromOperator("explore-2", "hello from the page", null));
                    Thread.ofVirtual().start(() -> {
                        await("explore-1 at the model", () -> script.atModel.get() == 1);
                        stop.cancel();
                    });
                    return tool("p3", "wait_agents", "{}");
                })
                .parentSays(text("noted"));
        Chat chat = new Chat(script, SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        chat.parent.setSessionsPerChat(2);
        chatRef.set(chat);
        List<RunEvent> events = chat.run(stop);
        int nextRun = script.parentRequests.size();
        chat.run(new CancelSignal());

        assertTrue(fromPage.get() != null && fromPage.get().ok(), "premise: the page's reply was taken: "
                + fromPage.get());
        assertFalse(script.childRequests.containsKey("task B"), "premise: explore-2 never reached the model");
        List<RunEvent.AgentMessage> back = messages(events, "peer").stream()
                .filter(m -> "returned".equals(m.state())).toList();
        assertEquals(2, back.size(), "both messages came back, once each: " + back);
        RunEvent.AgentMessage toModel = back.stream().filter(m -> "main".equals(m.to())).findFirst().orElseThrow();
        RunEvent.AgentMessage toPage = back.stream().filter(m -> "operator".equals(m.to())).findFirst().orElseThrow();
        assertEquals(sentMsgId(events, "status?"), toModel.label());
        assertEquals(fromPage.get().msgId(), toPage.label());
        assertTrue(toModel.text().contains("status?") && toModel.text().contains("Do not wait"), toModel.text());
        assertTrue(toPage.text().contains("hello from the page") && !toPage.text().contains("Do not wait"),
                toPage.text());
        String next = history(script.parentRequests.get(nextRun));
        assertEquals(1, next.split(java.util.regex.Pattern.quote(toModel.text()), -1).length - 1,
                "the model reads its own line once: " + next);
        assertFalse(next.contains("hello from the page"), "the model reads nothing about the page's reply");
    }

    // ── card 594 fix round 1: failure paths around the return (review M7) ──

    /** How many children still hold unread messages that no return took. */
    @SuppressWarnings("unchecked")
    private static int unreadLeft(SubagentManager manager) {
        try {
            java.lang.reflect.Field field = SubagentManager.class.getDeclaredField("unreadAtEnd");
            field.setAccessible(true);
            return ((Map<String, ?>) field.get(manager)).size();
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }

    /** Throws {@code failure} past the compiler, checked or not. */
    @SuppressWarnings("unchecked")
    private static <T extends Throwable> RuntimeException sneaky(Throwable failure) throws T {
        throw (T) failure;
    }

    private static boolean returnedRecord(RunEvent event) {
        return event instanceof RunEvent.AgentMessage m && "peer".equals(m.role()) && "returned".equals(m.state());
    }

    /**
     * M7 a: a step child whose agent fails with a checked throwable, thrown
     * past the compiler, still hands the waiting reply back, and that failure
     * goes on up unchanged.
     */
    @Test
    void aStepChildThatFailsWithACheckedThrowableHandsTheReplyBackAndKeepsTheFailure() {
        Tool checked = new Tool() {
            public String name() { throw BackgroundFanOutTest.<RuntimeException>sneaky(new java.io.IOException("checked belt")); }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
        Chat chat = new Chat(new Script(), SubagentConfig.builder(), 30_000, null, null, true,
                UnaryOperator.identity(), List.of(checked));
        List<RunEvent> stepEvents = new CopyOnWriteArrayList<>();
        Throwable thrown = null;
        try {
            chat.manager.runStep(STEP, event -> {
                stepEvents.add(event);
                if (event instanceof RunEvent.AgentSpawn) {
                    chat.manager.sendFromOperator("explore-1", "hello step", null);
                }
            }, new CancelSignal());
        } catch (Throwable e) {
            thrown = e;
        }

        assertTrue(thrown instanceof java.io.IOException && "checked belt".equals(thrown.getMessage()),
                "the original failure goes on up: " + thrown);
        RunEvent.AgentMessage back = theOnlyReturned(stepEvents);
        assertTrue(back.text().contains("hello step") && back.text().contains("unexpected failure"), back.text());
        assertEquals(0, unreadLeft(chat.manager), "nothing is left behind");
    }

    /**
     * M7 b: the step's sink fails on the waiting record and again on the
     * returned line. The first failure goes on up with the second added to it.
     */
    @Test
    void aSinkThatFailsAgainOnTheReturnedLineKeepsTheFirstFailure() {
        Chat chat = new Chat(new Script(), SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        SessionSlots slots = slotsOf(chat.manager);
        SessionSlots.Ticket blocker = slots.enqueue();
        assertTrue(slots.acquire(blocker, () -> SessionCount.of(2), new CancelSignal()), "premise: the slot is held");
        List<RunEvent> offered = new CopyOnWriteArrayList<>();
        Throwable thrown = null;
        try {
            chat.manager.runStep(STEP, event -> {
                if (event instanceof RunEvent.AgentSpawn) {
                    chat.manager.sendFromOperator("explore-1", "hello step", null);
                }
                if (waitingStatus(event, "explore-1")) {
                    throw new IllegalStateException("sink closed on the waiting record");
                }
                if (returnedRecord(event)) {
                    offered.add(event);
                    throw new IllegalStateException("sink closed on the returned line");
                }
            }, new CancelSignal());
        } catch (RuntimeException e) {
            thrown = e;
        } finally {
            slots.release();
        }

        assertEquals(1, offered.size(), "premise: the returned line was offered to the sink");
        assertTrue(thrown != null && "sink closed on the waiting record".equals(thrown.getMessage()),
                "the first failure goes on up: " + thrown);
        assertTrue(java.util.Arrays.stream(thrown.getSuppressed())
                        .anyMatch(e -> "sink closed on the returned line".equals(e.getMessage())),
                "with the second added to it");
        assertEquals(0, unreadLeft(chat.manager), "nothing is left behind");
    }

    /**
     * M7 b: two replies wait when the step is stopped before its child starts,
     * and the sink fails on the first returned line only. The second line
     * still reaches it, and the sink's failure goes on up.
     */
    @Test
    void aSinkThatFailsOnOneReturnedLineStillGetsTheRest() {
        Chat chat = new Chat(new Script(), SubagentConfig.builder().sessionsPerChat(2), 30_000, null, null, true);
        SessionSlots slots = slotsOf(chat.manager);
        SessionSlots.Ticket blocker = slots.enqueue();
        assertTrue(slots.acquire(blocker, () -> SessionCount.of(2), new CancelSignal()), "premise: the slot is held");
        CancelSignal stepStop = new CancelSignal();
        List<String> offered = new CopyOnWriteArrayList<>();
        Throwable thrown = null;
        try {
            chat.manager.runStep(STEP, event -> {
                if (event instanceof RunEvent.AgentSpawn) {
                    chat.manager.sendFromOperator("explore-1", "first reply", null);
                    chat.manager.sendFromOperator("explore-1", "second reply", null);
                }
                if (waitingStatus(event, "explore-1")) {
                    stepStop.cancel(); // stopped before the child starts
                }
                if (event instanceof RunEvent.AgentMessage m && returnedRecord(event)) {
                    offered.add(m.text());
                    if (offered.size() == 1) {
                        throw new IllegalStateException("sink closed on the first line");
                    }
                }
            }, stepStop);
        } catch (RuntimeException e) {
            thrown = e;
        } finally {
            slots.release();
        }

        assertEquals(2, offered.size(), "both lines were offered: " + offered);
        assertTrue(offered.get(0).contains("first reply") && offered.get(1).contains("second reply"),
                offered.toString());
        assertTrue(thrown != null && "sink closed on the first line".equals(thrown.getMessage()),
                "the sink's failure goes on up: " + thrown);
        assertEquals(0, unreadLeft(chat.manager), "nothing is left behind");
    }

    /**
     * M7 c: the step's sink fails on the task record, after the page saw the
     * spawn record and replied. The reply comes back through the same sink,
     * and the failure goes on up.
     */
    @Test
    void aStepWhoseSinkFailsOnItsTaskRecordHandsTheReplyBack() {
        Chat chat = chat(new Script());
        List<RunEvent> stepEvents = new CopyOnWriteArrayList<>();
        Throwable thrown = null;
        try {
            chat.manager.runStep(STEP, event -> {
                if (event instanceof RunEvent.AgentSpawn) {
                    chat.manager.sendFromOperator("explore-1", "hello step", null);
                }
                if (event instanceof RunEvent.AgentMessage m && "task".equals(m.role())) {
                    throw new IllegalStateException("sink closed on the task record");
                }
                stepEvents.add(event);
            }, new CancelSignal());
        } catch (RuntimeException e) {
            thrown = e;
        }

        assertTrue(thrown != null && "sink closed on the task record".equals(thrown.getMessage()),
                "the failure goes on up: " + thrown);
        RunEvent.AgentMessage back = theOnlyReturned(stepEvents);
        assertTrue(back.text().contains("hello step") && back.text().contains("did not start"), back.text());
        assertEquals(0, unreadLeft(chat.manager), "nothing is left behind");
        assertEquals("inboxes=0 tickets=0", registrations(chat.manager));
    }

    /**
     * M7 c: a blocking child's envelope fails on the task record, after the
     * page saw the spawn record and replied. The reply comes back, and the
     * spawn call fails as before.
     */
    @Test
    void aBlockingChildWhoseEnvelopeFailsHandsTheReplyBack() {
        Script script = new Script()
                .parentSays(tool("p1", "spawn_agents", "{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"}]}"))
                .parentSays(text("done"));
        Chat chat = chat(script);
        chat.manager.blockingSinkForTests(sink -> event -> {
            if (event instanceof RunEvent.AgentMessage m && "task".equals(m.role())) {
                throw new IllegalStateException("queue closed on the task record");
            }
            sink.accept(event);
            if (event instanceof RunEvent.AgentSpawn) {
                chat.manager.sendFromOperator("explore-1", "hello from the page", null);
            }
        });
        List<RunEvent> events = chat.run(new CancelSignal());

        RunEvent.AgentMessage back = theOnlyReturned(events);
        assertTrue(back.text().contains("hello from the page") && back.text().contains("did not start"),
                back.text());
        assertTrue(lastResult(script.parentRequests.get(1)).contains("queue closed on the task record"),
                "the spawn call fails as before: " + lastResult(script.parentRequests.get(1)));
        assertEquals(0, unreadLeft(chat.manager), "nothing is left behind");
    }

}
