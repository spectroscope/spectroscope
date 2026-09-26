package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 394: a child agent's token spend, against a child shaped like
 * {@code explore-4} of the session of 2026-09-23.
 *
 * <p>That child made 122 requests in 340 s, every one of them a small, distinct,
 * successful read, and every one resending a conversation that grew by about
 * 480 input tokens per request (first request 1,338 input tokens, least-squares
 * slope 480.3, mean output 86; {@code kanban/evidence/394/loop/child_curves.out.txt}
 * in the product home). No byte-identical call, no repeated failure and no plan,
 * so none of the three {@code ProgressGuard} detectors would have fired on it.
 * On 0.12.0 the 300 s wall clock was what ended it. On the 7,200 s clock of
 * card 372 nothing ended it before the wall clock did.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SubagentTokenBudgetTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The number this test states: ten million tokens, input plus output, the
     *  way the child's own running sum counts them. */
    private static final long STATED_TOKENS = 10_000_000L;

    /** explore-4's first request and its growth per request, rounded. */
    private static final int FIRST_INPUT = 1_338;
    private static final int GROWTH_PER_REQUEST = 480;
    private static final int OUTPUT_PER_REQUEST = 86;

    /** How long the fake backend waits, once the child's spend has passed the
     *  stated number, for the harness to cancel the next exchange. A real
     *  exchange on the owner's backends takes seconds; the harness reads the
     *  usage of the exchange before it the moment it arrives. */
    private static final long WAIT_FOR_A_CUT_MS = 3_000;

    /** How many more exchanges the child makes when nothing cuts it, before it
     *  answers on its own. Enough to carry the spend well past the number. */
    private static final int EXCHANGES_AFTER_AN_UNHEEDED_BUDGET = 10;

    /**
     * Parent turns are scripted. The child reads one line of one file per
     * request, at a new offset each time, and reports the usage explore-4's
     * curve predicts for that request.
     */
    private static class ReadThrashingChild implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final AtomicInteger requests = new AtomicInteger();
        final AtomicLong emitted = new AtomicLong();
        /** The spend at the first exchange that passed {@link #limit}, or -1. */
        final AtomicLong firstCrossing = new AtomicLong(-1);
        final AtomicInteger unheeded = new AtomicInteger(-1);
        /** Requests that reached this backend after the spend had passed
         *  {@link #limit} and ended on the harness's cancel. */
        final AtomicInteger abortedAfterTheLimit = new AtomicInteger();
        private final long limit;
        private final boolean narrates;

        ReadThrashingChild(long limit) {
            this(limit, false);
        }

        /** @param limit    the spend past which the backend waits for a cut
         *  @param narrates true writes one sentence of text before every read,
         *                  so a cut child has words in its last turn */
        ReadThrashingChild(long limit, boolean narrates) {
            this.limit = limit;
            this.narrates = narrates;
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
            CancelSignal signal = request.signal();
            if (emitted.get() > limit) {
                if (unheeded.get() < 0) {
                    long waited = 0;
                    while (!signal.isCancelled() && waited < WAIT_FOR_A_CUT_MS) {
                        sleep(10);
                        waited += 10;
                    }
                    if (signal.isCancelled()) {
                        abortedAfterTheLimit.incrementAndGet();
                        return List.of(new PStop(PStop.StopReason.ABORTED));
                    }
                    unheeded.set(0);
                }
                if (unheeded.getAndIncrement() >= EXCHANGES_AFTER_AN_UNHEEDED_BUDGET) {
                    return exchange(List.of(new PTextDelta("memo: nothing conclusive")),
                            PStop.StopReason.END_TURN);
                }
            }
            if (signal.isCancelled()) {
                return List.of(new PStop(PStop.StopReason.ABORTED));
            }
            int n = requests.get();
            int offset = 1 + (n * 37) % 4000;
            PToolCall read = new PToolCall("r" + n, "read_file",
                    JSON.createObjectNode().put("path", "SessionConnection.java")
                            .put("offset", offset).put("limit", 1));
            return exchange(narrates
                            ? List.of(new PTextDelta("Reading line " + offset + " next."), read)
                            : List.of(read),
                    PStop.StopReason.TOOL_USE);
        }

        private List<ProviderEvent> exchange(List<ProviderEvent> body, PStop.StopReason stop) {
            int n = requests.getAndIncrement();
            int input = FIRST_INPUT + GROWTH_PER_REQUEST * n;
            long after = emitted.addAndGet(input + OUTPUT_PER_REQUEST);
            if (after > limit) {
                firstCrossing.compareAndSet(-1, after);
            }
            List<ProviderEvent> events = new ArrayList<>(body);
            events.add(new PUsage(input, OUTPUT_PER_REQUEST));
            events.add(new PStop(stop));
            return events;
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static Tool fakeRead(String name) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return "fake"; }
            public com.fasterxml.jackson.databind.JsonNode inputSchema() {
                return JSON.createObjectNode();
            }
            public boolean needsPermission() { return false; }
            public String execute(com.fasterxml.jackson.databind.JsonNode input,
                                  ToolContext context) {
                return "    private final SessionStore store;";
            }
        };
    }

    private static List<LlmProvider.ProviderEvent> spawnTurn() {
        return List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                        JSON.createObjectNode().put("type", "explore")
                                .put("task", "Trace the concurrent holder in SessionConnection")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> closingTurn() {
        return List.of(new LlmProvider.PTextDelta("The child came back."),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    /** Runs one parent that spawns one explore child and collects the merged stream.
     *  @param provider the scripted backend
     *  @param config   the child wiring, built the way a face builds it */
    private static List<RunEvent> run(ReadThrashingChild provider, SubagentConfig config) {
        provider.parentTurns.add(spawnTurn());
        provider.parentTurns.add(closingTurn());
        SubagentManager manager = new SubagentManager(config);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Look into card 380",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    /** The shipped wiring: no budget override, no floor, no ceiling, nothing a
     *  settings file would have to set. The child runs on the 7,200 s floor of
     *  card 372 and the 1,000 turn ceiling of card 373. */
    private static SubagentConfig.Builder shipped(LlmProvider provider) {
        return SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(fakeRead("read_file"), fakeRead("list_dir")));
    }

    private static long childSpend(List<RunEvent> events, String childId) {
        return events.stream()
                .filter(RunEvent.Usage.class::isInstance)
                .map(RunEvent.Usage.class::cast)
                .filter(usage -> childId.equals(usage.agentId()))
                .mapToLong(usage -> (long) usage.inputTokens() + usage.outputTokens())
                .sum();
    }

    private static RunEvent.RunEnd childRunEnd(List<RunEvent> events, String childId) {
        return events.stream()
                .filter(RunEvent.RunEnd.class::isInstance)
                .map(RunEvent.RunEnd.class::cast)
                .filter(end -> events.stream()
                        .anyMatch(other -> other instanceof RunEvent.RunStart start
                                && start.runId().equals(end.runId())
                                && childId.equals(start.agentId())))
                .findFirst().orElseThrow();
    }

    private static RunEvent.ToolResult spawnResult(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> "main".equals(result.agentId()))
                .findFirst().orElseThrow();
    }

    @Test
    void aChildThatReadsItsWayPastTenMillionTokensIsStoppedAtTheExchangeThatPassedThem() {
        ReadThrashingChild provider = new ReadThrashingChild(STATED_TOKENS);

        List<RunEvent> events = run(provider, shipped(provider).build());

        long crossing = provider.firstCrossing.get();
        assertTrue(crossing > 0,
                "test premise: the child's usage passed " + STATED_TOKENS + " tokens, after "
                        + provider.requests.get() + " requests");
        long spent = childSpend(events, "explore-1");
        assertTrue(spent <= crossing,
                "the child must stop at the exchange that took it past " + STATED_TOKENS
                        + " tokens (" + crossing + "), and it spent " + spent + " over "
                        + provider.requests.get() + " requests");
    }

    @Test
    void aChildPastItsTokenBudgetEndsOnAStopReasonOfItsOwnAndTheParentIsToldWhichSetting() {
        // The card's scenario: a budget of four million, a child that reads its
        // way past it. The stop reason is compared as the wire string, because
        // that string is what a session file and a report read.
        ReadThrashingChild provider = new ReadThrashingChild(4_000_000L);

        List<RunEvent> events = run(provider,
                shipped(provider).subagentBudgetTokens(4_000_000).build());

        assertEquals("child_token_budget_exhausted", childRunEnd(events, "explore-1").stopReason(),
                "a child cut for its tokens must not read as one cut for its time");
        RunEvent.ToolResult result = spawnResult(events);
        assertTrue(result.isError(), "a cut is an error to the parent: " + result.output());
        assertTrue(result.output().startsWith("ERROR: [explore-1] out of tokens"),
                result.output());
        assertTrue(result.output().contains("4000000"),
                "the parent is told the budget it ran into: " + result.output());
        assertTrue(result.output().contains(Long.toString(provider.firstCrossing.get())),
                "and what the child had spent when it was cut: " + result.output());
        assertTrue(result.output().contains("Raise subagentBudgetTokens in the settings"),
                "and which setting raises it: " + result.output());
    }

    @Test
    void theRequestOfTheTurnAChildIsCutInStillReachesTheBackendIsAbortedAndIsNotCounted() {
        // What the settings note and the subagents chapter say about the cut.
        // The check runs on the forwarder thread when it reads the child's
        // turn_start; the child's own thread goes on to its model call, and
        // none of the Ollama, Anthropic and OpenAI-compatible providers checks
        // the signal before it posts. So one more request
        // reaches the backend and is torn down, and an aborted request reports
        // no usage. A check on the child's own thread before the call would
        // turn this red, and the two sentences would have to change with it.
        ReadThrashingChild provider = new ReadThrashingChild(4_000_000L);

        List<RunEvent> events = run(provider,
                shipped(provider).subagentBudgetTokens(4_000_000).build());

        long crossing = provider.firstCrossing.get();
        assertEquals(1, provider.abortedAfterTheLimit.get(),
                "the request after the crossing reached the backend once and was aborted");
        assertEquals(crossing, childSpend(events, "explore-1"),
                "the aborted request adds no usage to the child's spend");
        assertTrue(spawnResult(events).output().contains(": " + crossing + " spent ("),
                "the parent is told the spend without the aborted request: "
                        + spawnResult(events).output());
    }

    @Test
    void aChildCutByItsTokenBudgetHandsBackWhatItHadWritten() {
        ReadThrashingChild provider = new ReadThrashingChild(4_000_000L, true);

        List<RunEvent> events = run(provider,
                shipped(provider).subagentBudgetTokens(4_000_000).build());

        String output = spawnResult(events).output();
        assertTrue(output.startsWith("ERROR: [explore-1] out of tokens"), output);
        assertTrue(output.contains(SubagentManager.PARTIAL_OUTPUT_MARKER), output);
        assertTrue(output.indexOf("Reading line ") > output.indexOf(SubagentManager.PARTIAL_OUTPUT_MARKER),
                "the words of the child's last turn follow the marker: " + output);
    }

    @Test
    void aChildThatHasSpentExactlyItsTokenBudgetMayStartAnotherExchange() {
        // The boundary. The child reads once for 1,338 + 86 = 1,424 tokens and
        // its budget is 1,424, so when it starts its second exchange it has
        // reached the budget and not passed it. A budget is passed by the token
        // after it, as the card's scenario says, so the child answers.
        java.util.concurrent.atomic.AtomicInteger childRequests =
                new java.util.concurrent.atomic.AtomicInteger();
        ReadThrashingChild provider = new ReadThrashingChild(Long.MAX_VALUE) {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return super.stream(request);
                }
                if (request.signal().isCancelled()) {
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                }
                if (childRequests.getAndIncrement() == 0) {
                    return List.of(new PToolCall("r0", "read_file",
                                    JSON.createObjectNode().put("path", "SessionConnection.java")),
                            new PUsage(1_338, 86), new PStop(PStop.StopReason.TOOL_USE));
                }
                return List.of(new PTextDelta("memo: the holder is SessionStore"),
                        new PUsage(1_818, 86), new PStop(PStop.StopReason.END_TURN));
            }
        };

        List<RunEvent> events = run(provider,
                shipped(provider).subagentBudgetTokens(1_424).build());

        assertEquals(2, childRequests.get(), "the child was allowed its second exchange");
        assertEquals("end_turn", childRunEnd(events, "explore-1").stopReason());
        RunEvent.ToolResult result = spawnResult(events);
        assertFalse(result.isError(), result.output());
        assertTrue(result.output().contains("memo: the holder is SessionStore"), result.output());
    }

    @Test
    void aChildWhoseLastExchangePassesItsTokenBudgetKeepsItsAnswer() {
        // The budget is read when the child starts ANOTHER exchange. A child
        // whose final answer is the exchange that passed it has nothing left
        // to cut, and its answer is what the tokens paid for.
        ReadThrashingChild provider = new ReadThrashingChild(Long.MAX_VALUE) {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (request.system().contains("subagent")) {
                    return List.of(new PTextDelta("memo: the holder is SessionStore"),
                            new PUsage(1_338, 86), new PStop(PStop.StopReason.END_TURN));
                }
                return super.stream(request);
            }
        };

        List<RunEvent> events = run(provider,
                shipped(provider).subagentBudgetTokens(1_000).build());

        assertEquals("end_turn", childRunEnd(events, "explore-1").stopReason());
        RunEvent.ToolResult result = spawnResult(events);
        assertFalse(result.isError(), result.output());
        assertTrue(result.output().contains("memo: the holder is SessionStore"), result.output());
    }

    @Test
    void aChildUnderItsTokenBudgetIsStillCutByTheWallClockAsBefore() {
        // The card's second scenario. The run budget is the test override of
        // 300 ms (the production path is the 7,200 s floor); the token budget is
        // the shipped one, far above the few tokens this child spends.
        LlmProvider wedged = new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return request.messages().size() <= 1 ? spawnTurn() : closingTurn();
                }
                CancelSignal signal = request.signal();
                return () -> new java.util.Iterator<ProviderEvent>() {
                    private int served;

                    @Override
                    public boolean hasNext() {
                        if (served == 1) {
                            while (!signal.isCancelled()) {
                                sleep(10);
                            }
                        }
                        return served < 2;
                    }

                    @Override
                    public ProviderEvent next() {
                        return served++ == 0 ? new PTextDelta("starting")
                                : new PStop(PStop.StopReason.ABORTED);
                    }
                };
            }
        };
        SubagentManager manager = new SubagentManager(shipped(wedged).build(), 300);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(wedged).systemPrompt("You are the parent.").registry(registry)
                .cwd(Path.of(".")).agentId("main").onPermission(request -> true).build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Run a wedged child",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        assertEquals("child_budget_exhausted", childRunEnd(events, "explore-1").stopReason());
        assertTrue(spawnResult(events).output().contains("Raise subagentBudgetSeconds"),
                spawnResult(events).output());
    }

    @Test
    void aChildPastItsBudgetWhoseParentWasCancelledSaysTheParentStoppedIt() {
        // The operator stops the parent while the child's read is running. The
        // cancel reaches the child's signal at once; the agent loop still opens
        // its next turn, and by then the child is past its budget. Who stopped
        // it is the parent, and the result has to say that.
        CancelSignal parentSignal = new CancelSignal();
        LlmProvider provider = new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return request.messages().size() <= 1 ? spawnTurn() : closingTurn();
                }
                if (request.signal().isCancelled()) {
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                }
                return List.of(new PToolCall("r0", "read_file",
                                JSON.createObjectNode().put("path", "SessionConnection.java")),
                        new PUsage(1_338, 86), new PStop(PStop.StopReason.TOOL_USE));
            }
        };
        Tool readWhileTheOperatorStops = new Tool() {
            public String name() { return "read_file"; }
            public String description() { return "fake"; }
            public com.fasterxml.jackson.databind.JsonNode inputSchema() {
                return JSON.createObjectNode();
            }
            public boolean needsPermission() { return false; }
            public String execute(com.fasterxml.jackson.databind.JsonNode input,
                                  ToolContext context) {
                parentSignal.cancel();
                return "    private final SessionStore store;";
            }
        };
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider).cwd(Path.of(".")).parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(readWhileTheOperatorStops))
                .subagentBudgetTokens(1_000)
                .build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("You are the parent.").registry(registry)
                .cwd(Path.of(".")).agentId("main").onPermission(request -> true).build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Look into card 380",
                new RunOptions(parentSignal, null))) {
            stream.forEach(events::add);
        }

        String output = spawnResult(events).output();
        assertTrue(output.contains("ended by cancellation of the parent run"), output);
        assertFalse(output.contains("out of tokens"), output);
    }

    @Test
    void anUnsetTokenBudgetIsTheShippedOne() {
        assertEquals(dev.spectroscope.core.config.SpectroConfig.DEFAULT_SUBAGENT_BUDGET_TOKENS,
                shipped(new ReadThrashingChild(1)).build().subagentBudgetTokens());
    }

    @Test
    void aTokenBudgetOfZeroOrLessIsRefusedByName() {
        for (int refused : new int[] {0, -1}) {
            IllegalArgumentException thrown = assertThrows(IllegalArgumentException.class,
                    () -> shipped(new ReadThrashingChild(1)).subagentBudgetTokens(refused).build());
            assertTrue(thrown.getMessage().contains("subagentBudgetTokens"), thrown.getMessage());
            assertTrue(thrown.getMessage().contains(Integer.toString(refused)), thrown.getMessage());
        }
    }
}
