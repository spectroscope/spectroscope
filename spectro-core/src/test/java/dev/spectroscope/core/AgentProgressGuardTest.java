package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.progress.ProgressGuard;
import dev.spectroscope.core.progress.ProgressSettings;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The guard inside the loop (card 262) — the half the detector tests cannot
 * reach: whether the run actually stops, whether the operator's word actually
 * lands where the model reads it, and whether a run ended at the question
 * leaves a history the next run can still be built on.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class AgentProgressGuardTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** 283 characters of the same thing, four times over — the measured shape. */
    private static final String BODY = "// spring toward the target, damped each step\n"
            + "export function stepParticle(p, tx, ty, k, dt) {\n"
            + "  const ax = (tx - p.x) * k;\n"
            + "  const ay = (ty - p.y) * k;\n"
            + "  p.vx = (p.vx + ax * dt) * 0.9;\n"
            + "  p.vy = (p.vy + ay * dt) * 0.9;\n"
            + "  p.x = p.x + p.vx * dt;\n"
            + "  p.y = p.y + p.vy * dt;\n"
            + "  return p;\n"
            + "}\n";

    /** Pops one scripted turn per stream() call and keeps every request. */
    private static final class FakeProvider implements LlmProvider {
        private final Deque<List<ProviderEvent>> turns = new ArrayDeque<>();
        final List<ProviderRequest> requests = new ArrayList<>();

        @Override public String modelName() {
            return "fake-model-1";
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            if (request.signal().isCancelled()) {
                return List.of(new PStop(PStop.StopReason.ABORTED));
            }
            return turns.isEmpty()
                    ? List.of(new PStop(PStop.StopReason.END_TURN))
                    : turns.poll();
        }

        FakeProvider write(String callId, String path) {
            return write(callId, path, BODY);
        }

        FakeProvider write(String callId, String path, String content) {
            ObjectNode input = JSON.createObjectNode().put("path", path).put("content", content);
            turns.add(List.of(new PToolCall(callId, "write_file", input),
                    new PStop(PStop.StopReason.TOOL_USE)));
            return this;
        }

        /** One call to a tool that always comes back an error, with byte-identical
         *  input every time — detector 2's shape. */
        FakeProvider failingCall(String callId) {
            ObjectNode input = JSON.createObjectNode()
                    .put("command", "node --test test/particle.test.js");
            turns.add(List.of(new PToolCall(callId, "always_fails", input),
                    new PStop(PStop.StopReason.TOOL_USE)));
            return this;
        }
    }

    /** A tool whose every call fails the same way — the loop reads the ERROR
     *  prefix, so this is exactly what a test command that never passes looks
     *  like from the loop's side. */
    private static final class AlwaysFails implements dev.spectroscope.core.tools.Tool {
        @Override public String name() {
            return "always_fails";
        }

        @Override public String description() {
            return "runs something that never passes";
        }

        @Override public JsonNode inputSchema() {
            return JSON.createObjectNode().put("type", "object");
        }

        @Override public boolean needsPermission() {
            return false;
        }

        @Override public String execute(JsonNode input, ToolContext context) {
            return "ERROR: 1 test failed — expected 0.2, got 0.18432";
        }
    }

    /** One run against a guard whose asker always says the same thing. */
    private record Run(List<RunEvent> events, FakeProvider provider, Agent agent) {}

    private static Run fourCopies(Path cwd, String answer) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        FakeProvider provider = new FakeProvider()
                .write("c1", "src/particleEngine.js")
                .write("c2", "src/particleEngine2.js")
                .write("c3", "src/particleEngine3.js")
                .write("c4", "src/particleEngine4.js")
                // A FIFTH copy, and it is load-bearing: with only four, a guard
                // that forgot to stand down after "carry on" would still emit
                // exactly one no_progress and the pin would pass in both
                // directions. Measured — the mutation was green until this line.
                .write("c5", "src/particleEngine5.js");
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                answer == null ? Asker.none()
                        : question -> new Asker.Answer(List.of(answer)));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> true)
                .progressGuard(guard)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            for (RunEvent event : stream) {
                events.add(event);
            }
        }
        return new Run(events, provider, agent);
    }

    @Test
    void theTranscriptSaysWhatTheHarnessSawWhenTheFourthCopyStarts(@TempDir Path cwd) {
        List<RunEvent> events = fourCopies(cwd, ProgressGuard.CARRY_ON_LABEL).events();

        RunEvent.NoProgress said = events.stream()
                .filter(RunEvent.NoProgress.class::isInstance)
                .map(RunEvent.NoProgress.class::cast)
                .findFirst()
                .orElseThrow(() -> new AssertionError(
                        "four identical copies and the transcript said nothing"));
        assertEquals("identical_writes", said.detector());
        assertEquals(3, said.count());
        assertEquals("main", said.agentId());
        assertNotNull(said.details());
        assertEquals("src/particleEngine4.js", said.details().getLast(),
                "the LAST detail is the copy that was starting — the contract the"
                        + " record's javadoc states");
        assertTrue(said.evidence().contains("283 bytes"),
                "the sentence carries the size; was: " + said.evidence());
    }

    @Test
    void carryOnLetsTheWriteHappenAndNeverAsksAgain(@TempDir Path cwd) {
        Run run = fourCopies(cwd, ProgressGuard.CARRY_ON_LABEL);

        assertTrue(Files.exists(cwd.resolve("src/particleEngine4.js")),
                "the operator said carry on; the write must go through");
        assertEquals(1, run.events().stream()
                        .filter(RunEvent.NoProgress.class::isInstance).count(),
                "answered for once, quiet for the rest of the run — a fifth copy"
                        + " follows the fourth and must not raise the question again");
        assertTrue(Files.exists(cwd.resolve("src/particleEngine5.js")));
        assertEquals("end_turn", stopReason(run.events()),
                "carry on does not end anything");
    }

    @Test
    void changeCourseStopsTheWriteAndHandsTheOperatorsWordsToTheModel(@TempDir Path cwd) {
        Run run = fourCopies(cwd, "stop copying it, fix the assertion instead");

        assertFalse(Files.exists(cwd.resolve("src/particleEngine4.js")),
                "the fourth copy must NOT be written after the operator stopped it");
        RunEvent.ToolResult result = resultFor(run.events(), "c4");
        assertFalse(result.isError(),
                "a person's decision is not a tool failure and must not invite a retry");
        assertTrue(result.output().contains("stop copying it, fix the assertion instead"),
                "the operator's own words land where the guess would have; was: "
                        + result.output());
        assertEquals(0L, result.durationMs(),
                "the tool never ran, so it took no time");
    }

    @Test
    void endStopsTheRunUnderItsOwnName(@TempDir Path cwd) {
        Run run = fourCopies(cwd, ProgressGuard.END_LABEL);

        assertEquals("no_progress", stopReason(run.events()),
                "\"the run just stopped\" is the one thing an observability product"
                        + " must not say — the reason names the guard");
        assertFalse(Files.exists(cwd.resolve("src/particleEngine4.js")));
    }

    @Test
    void aRunEndedAtTheQuestionLeavesAHistoryTheNextRunCanUse(@TempDir Path cwd) {
        // The trap: ending mid-round leaves an assistant message holding a
        // tool_call nothing ever answered, and the next request is a 400 from
        // every strict provider. Measured through the provider's own request.
        Run run = fourCopies(cwd, ProgressGuard.END_LABEL);
        try (EventStream stream = run.agent()
                .run("and now?", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(event -> { });
        }
        LlmProvider.ProviderRequest last = run.provider().requests.getLast();
        Set<String> called = last.messages().stream()
                .flatMap(message -> message.content().stream())
                .filter(LlmProvider.ToolCallContent.class::isInstance)
                .map(content -> ((LlmProvider.ToolCallContent) content).callId())
                .collect(Collectors.toSet());
        Set<String> answered = last.messages().stream()
                .flatMap(message -> message.content().stream())
                .filter(LlmProvider.ToolResultContent.class::isInstance)
                .map(content -> ((LlmProvider.ToolResultContent) content).callId())
                .collect(Collectors.toSet());
        assertTrue(called.contains("c4"), "the fourth call is in the history");
        assertEquals(called, answered,
                "every tool_call of the ended round carries a tool_result, or the next"
                        + " provider request is a 400");
    }

    @Test
    void nobodyToAskLeavesTheRunGoing(@TempDir Path cwd) {
        Run run = fourCopies(cwd, null); // Asker.none()

        assertTrue(run.events().stream().anyMatch(RunEvent.NoProgress.class::isInstance),
                "unanswered or not, the observation is on the wire");
        assertEquals("end_turn", stopReason(run.events()),
                "ending a run on nobody's word would be the silent abort criterion 3 forbids");
        assertTrue(Files.exists(cwd.resolve("src/particleEngine4.js")));
    }

    @Test
    void aRunWithNoGuardBehavesExactlyAsBefore(@TempDir Path cwd) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        FakeProvider provider = new FakeProvider()
                .write("c1", "src/particleEngine.js")
                .write("c2", "src/particleEngine2.js")
                .write("c3", "src/particleEngine3.js")
                .write("c4", "src/particleEngine4.js");
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> true)
                .build()); // no guard at all — the shipped default for every face without a person
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }
        assertFalse(events.stream().anyMatch(RunEvent.NoProgress.class::isInstance),
                "no guard, no line — the addition is additive");
        assertTrue(Files.exists(cwd.resolve("src/particleEngine4.js")));
    }

    /**
     * Review finding F3: this test used to be called
     * {@code theStalledPlanNetIsAskedAtTheTOPOfATurn} and its body could not tell
     * the top of a turn from anywhere else in it — the reviewer moved the whole
     * detector-3 block to AFTER the request was built and it stayed green.
     * Replaced, not loosened: this one keeps the claim it can actually measure,
     * and {@link #theStalledPlansSteerRidesTheRequestOfTheSAMETurn} measures the
     * placement.
     */
    @Test
    void aStalledPlanIsCaughtAndTheOperatorCanEndTheRun(@TempDir Path cwd) {
        // Detector 3 has no tool call to hang on, so the loop has to ask it
        // itself, once per turn, before the provider is called. Armed here on
        // purpose: its shipped default is off.
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        FakeProvider provider = new FakeProvider();
        for (int i = 1; i <= 6; i++) {
            provider.write("p" + i, "src/step" + i + ".js");
        }
        List<RunEvent> events = new ArrayList<>();
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 2),
                question -> new Asker.Answer(List.of(ProgressGuard.END_LABEL)));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> true)
                .progressGuard(guard)
                .build());
        // The agent's own plan ledger is fed by the plan tool; drive it directly
        // through the same sink the loop taps, by running update_plan first.
        registry.register(new dev.spectroscope.core.tools.UpdatePlanTool());
        provider.turns.addFirst(List.of(
                new LlmProvider.PToolCall("plan1", "update_plan", planInput()),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }
        RunEvent.NoProgress said = events.stream()
                .filter(RunEvent.NoProgress.class::isInstance)
                .map(RunEvent.NoProgress.class::cast)
                .findFirst()
                .orElseThrow(() -> new AssertionError("the plan never moved and nobody said so"));
        assertEquals("stalled_plan", said.detector());
        assertEquals("no_progress", stopReason(events));
    }

    /**
     * The placement itself, measured instead of asserted by name. Detector 3 is
     * asked at the TOP of a turn, so the operator's steer rides the request of
     * THAT turn — not the next one. A block that sits after the request is built
     * costs the run a whole turn of the thing the operator just stopped, and the
     * old test's name claimed this while its body could not see it.
     */
    @Test
    void theStalledPlansSteerRidesTheRequestOfTheSAMETurn(@TempDir Path cwd) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        registry.register(new dev.spectroscope.core.tools.UpdatePlanTool());
        FakeProvider provider = new FakeProvider();
        for (int i = 1; i <= 6; i++) {
            provider.write("p" + i, "src/step" + i + ".js", "// step " + i + "\n");
        }
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 2),
                question -> new Asker.Answer(List.of("try a different step")));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("test").registry(registry).cwd(cwd)
                .onPermission(request -> true).progressGuard(guard).build());
        provider.turns.addFirst(List.of(
                new LlmProvider.PToolCall("plan1", "update_plan", planInput()),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }

        // Which turn was the guard asked in? The last turn_start before the line.
        int turnOfTheStrike = 0;
        int turn = 0;
        for (RunEvent event : events) {
            if (event instanceof RunEvent.TurnStart start) {
                turn = start.turn();
            }
            if (event instanceof RunEvent.NoProgress && turnOfTheStrike == 0) {
                turnOfTheStrike = turn;
            }
        }
        assertTrue(turnOfTheStrike > 0, "the plan never moved and nobody said so");
        long turnStarts = events.stream().filter(RunEvent.TurnStart.class::isInstance).count();
        assertEquals(turnStarts, provider.requests.size(),
                "one request per turn is what makes the index below a turn number;"
                        + " if that ever stops holding this test must fail loudly");

        assertTrue(said(provider.requests.get(turnOfTheStrike - 1), "try a different step"),
                "the steer must ride the request of turn " + turnOfTheStrike + " itself —"
                        + " a guard asked after the request was built spends the very turn"
                        + " the operator just stopped");
        for (int i = 0; i < turnOfTheStrike - 1; i++) {
            assertFalse(said(provider.requests.get(i), "try a different step"),
                    "nothing was said before the guard fired, so request " + (i + 1)
                            + " cannot carry the steer");
        }
    }

    /** Whether one provider request carries the given text anywhere in its messages. */
    private static boolean said(LlmProvider.ProviderRequest request, String text) {
        return request.messages().stream()
                .flatMap(message -> message.content().stream())
                .anyMatch(content -> content instanceof LlmProvider.TextContent value
                        && value.text().contains(text));
    }

    @Test
    void aRoundEndedMidWayStillAnswersTheCallsBehindIt(@TempDir Path cwd) {
        // The model may put several calls in ONE turn. When the operator ends the
        // run at the first of them, the ones behind it never execute — and every
        // single one still needs a tool_result, or the assistant message left in
        // the history holds a tool_call nobody answered and the NEXT run is a 400
        // from every strict backend.
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        FakeProvider provider = new FakeProvider()
                .write("c1", "src/particleEngine.js")
                .write("c2", "src/particleEngine2.js")
                .write("c3", "src/particleEngine3.js");
        // One turn, three calls: the fourth copy plus two more behind it.
        provider.turns.add(List.of(
                new LlmProvider.PToolCall("c4", "write_file",
                        JSON.createObjectNode().put("path", "src/particleEngine4.js")
                                .put("content", BODY)),
                new LlmProvider.PToolCall("c5", "write_file",
                        JSON.createObjectNode().put("path", "src/particleEngine5.js")
                                .put("content", BODY)),
                new LlmProvider.PToolCall("c6", "run_command",
                        JSON.createObjectNode().put("command", "node --test test/x.test.js")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of(ProgressGuard.END_LABEL)));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("test").registry(registry).cwd(cwd)
                .onPermission(request -> true).progressGuard(guard).build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }

        assertEquals("no_progress", stopReason(events));
        for (String callId : List.of("c4", "c5", "c6")) {
            RunEvent.ToolResult result = resultFor(events, callId);
            assertFalse(result.isError(), callId + " is not a tool failure");
        }
        assertFalse(Files.exists(cwd.resolve("src/particleEngine5.js")),
                "a call behind the one that ended the run must not run either");

        // And the history proves it: another run, and every call is answered.
        try (EventStream stream = agent.run("and now?",
                new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(event -> { });
        }
        LlmProvider.ProviderRequest last = provider.requests.getLast();
        Set<String> called = last.messages().stream()
                .flatMap(message -> message.content().stream())
                .filter(LlmProvider.ToolCallContent.class::isInstance)
                .map(content -> ((LlmProvider.ToolCallContent) content).callId())
                .collect(Collectors.toSet());
        Set<String> answered = last.messages().stream()
                .flatMap(message -> message.content().stream())
                .filter(LlmProvider.ToolResultContent.class::isInstance)
                .map(content -> ((LlmProvider.ToolResultContent) content).callId())
                .collect(Collectors.toSet());
        assertTrue(called.containsAll(List.of("c4", "c5", "c6")));
        assertEquals(called, answered,
                "every tool_call of the ended round carries a tool_result");
    }

    @Test
    void theStalledPlansSteerNeverPutsTwoUserMessagesInARow(@TempDir Path cwd) {
        // The request path does NOT merge adjacent roles — mergeAdjacentRoles is
        // only ever applied when a session is read back or compacted. A turn
        // starts right after the previous turn's tool-results USER message, so a
        // steer added BESIDE it would reach Anthropic as "roles must alternate",
        // and the guard would break the run it exists to save.
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        registry.register(new dev.spectroscope.core.tools.UpdatePlanTool());
        FakeProvider provider = new FakeProvider();
        for (int i = 1; i <= 6; i++) {
            provider.write("p" + i, "src/step" + i + ".js");
        }
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 2),
                question -> new Asker.Answer(List.of("try a different step")));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("test").registry(registry).cwd(cwd)
                .onPermission(request -> true).progressGuard(guard).build());
        provider.turns.addFirst(List.of(
                new LlmProvider.PToolCall("plan1", "update_plan", planInput()),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(event -> { });
        }

        boolean steered = provider.requests.stream()
                .flatMap(request -> request.messages().stream())
                .flatMap(message -> message.content().stream())
                .anyMatch(content -> content instanceof LlmProvider.TextContent text
                        && text.text().contains("try a different step"));
        assertTrue(steered, "the operator's words never reached the model at all");
        for (LlmProvider.ProviderRequest request : provider.requests) {
            LlmProvider.ProviderMessage.Role previous = null;
            for (LlmProvider.ProviderMessage message : request.messages()) {
                assertFalse(message.role() == previous,
                        "two " + message.role() + " messages in a row went to the provider");
                previous = message.role();
            }
        }
    }

    // ---- the guard's memory belongs to the RUN, not to the agent -----------

    /**
     * Review finding F1, the measured one. A browser session builds its agent
     * ONCE ({@code SessionConnection.buildAgentOnce}) and runs every prompt
     * through it, and the REPL does the same between rebuilds. So an agent-lived
     * memory turns four honest prompts into a strike — which is criterion 5
     * broken by construction, on the one face the guard actually ships on.
     */
    @Test
    void fourSeparatePromptsWithOneWriteEachNeverTripTheGuard(@TempDir Path cwd) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        FakeProvider provider = new FakeProvider();
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of(ProgressGuard.END_LABEL)));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("test").registry(registry).cwd(cwd)
                .onPermission(request -> true).progressGuard(guard).build());

        List<RunEvent> all = new ArrayList<>();
        for (int i = 1; i <= 4; i++) {
            // Four finished tasks, one file each, and the same boilerplate body —
            // a licence header, a barrel file, a copied fixture. Honest work.
            provider.write("c" + i, "src/module" + i + "/index.js");
            try (EventStream stream = agent.run("task " + i,
                    new RunOptions(new CancelSignal(), List.of()))) {
                stream.forEach(all::add);
            }
        }

        assertEquals(0L, all.stream().filter(RunEvent.NoProgress.class::isInstance).count(),
                "each prompt wrote ONE copy and finished; a guard that adds four runs"
                        + " together pauses honest work, which criterion 5 forbids");
        assertTrue(Files.exists(cwd.resolve("src/module4/index.js")),
                "and nothing was stopped");
    }

    /**
     * The other half of F1, and the more dangerous one: "carry on" is a sentence
     * about THIS run. An agent-lived stand-down makes one wave-through deafen the
     * whole browser session, so the next prompt's genuine loop runs unwatched.
     */
    @Test
    void aFreshRunSpeaksAgainAfterTheLastOneWasWavedThrough(@TempDir Path cwd) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        FakeProvider provider = new FakeProvider()
                .write("a1", "src/one.js").write("a2", "src/two.js")
                .write("a3", "src/three.js").write("a4", "src/four.js");
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of(ProgressGuard.CARRY_ON_LABEL)));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("test").registry(registry).cwd(cwd)
                .onPermission(request -> true).progressGuard(guard).build());

        List<RunEvent> first = new ArrayList<>();
        try (EventStream stream = agent.run("first task",
                new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(first::add);
        }
        assertEquals(1L, first.stream().filter(RunEvent.NoProgress.class::isInstance).count(),
                "the first run's loop was caught once and waved through");

        // A brand-new task, DIFFERENT bytes, its own four-copy loop.
        String other = BODY.replace("0.9", "0.8");
        for (int i = 1; i <= 4; i++) {
            provider.write("b" + i, "src/other" + i + ".js", other);
        }
        List<RunEvent> second = new ArrayList<>();
        try (EventStream stream = agent.run("second task",
                new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(second::add);
        }

        assertEquals(1L, second.stream().filter(RunEvent.NoProgress.class::isInstance).count(),
                "\"carry on\" was said about the LAST run; a new run gets a fresh net,"
                        + " or one wave-through deafens the whole session");
    }

    // ---- detector 2 inside the loop, not only in the detector's own test ----

    /**
     * Review finding F2: the whole {@code observeResult} block could be deleted
     * from the loop and the full gate stayed green. Detector 2 is the net that
     * catches the measured loop when the model varies the filename, so its wiring
     * is worth its own reader — card 222's finding F4, again.
     */
    @Test
    void theRepeatedFailureNetSteersTheModelFromInsideTheLoop(@TempDir Path cwd) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        registry.register(new AlwaysFails());
        FakeProvider provider = new FakeProvider()
                .failingCall("f1").failingCall("f2").failingCall("f3");
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of("the expected value is wrong, fix the test")));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("test").registry(registry).cwd(cwd)
                .onPermission(request -> true).progressGuard(guard).build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }

        RunEvent.NoProgress said = events.stream()
                .filter(RunEvent.NoProgress.class::isInstance)
                .map(RunEvent.NoProgress.class::cast)
                .findFirst()
                .orElseThrow(() -> new AssertionError(
                        "the same call failed three times and the loop said nothing"));
        assertEquals("repeated_failure", said.detector());
        assertEquals(3, said.count());
        boolean steered = provider.requests.stream()
                .flatMap(request -> request.messages().stream())
                .flatMap(message -> message.content().stream())
                .anyMatch(content -> content instanceof LlmProvider.TextContent text
                        && text.text().contains("the expected value is wrong, fix the test"));
        assertTrue(steered, "the operator's words never reached the model at all");
    }

    /** The END half of the same wiring: the run stops under the guard's own name. */
    @Test
    void theRepeatedFailureNetCanEndTheRunUnderTheGuardsOwnName(@TempDir Path cwd) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        registry.register(new AlwaysFails());
        FakeProvider provider = new FakeProvider()
                .failingCall("f1").failingCall("f2").failingCall("f3").failingCall("f4");
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of(ProgressGuard.END_LABEL)));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("test").registry(registry).cwd(cwd)
                .onPermission(request -> true).progressGuard(guard).build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }

        assertEquals("no_progress", stopReason(events),
                "the operator ended it at the guard's question; the run says so");
        assertEquals(3, events.stream().filter(RunEvent.ToolCall.class::isInstance).count(),
                "and the fourth call never happened");
    }

    /** An update_plan input with one open step. */
    private static JsonNode planInput() {
        ObjectNode step = JSON.createObjectNode()
                .put("text", "write the engine").put("status", "in_progress");
        ObjectNode input = JSON.createObjectNode();
        input.set("steps", JSON.createArrayNode().add(step));
        return input;
    }

    /** The stop reason of the run_end in a stream. */
    private static String stopReason(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.RunEnd.class::isInstance)
                .map(event -> ((RunEvent.RunEnd) event).stopReason())
                .reduce((a, b) -> b)
                .orElseThrow(() -> new AssertionError("no run_end at all"));
    }

    /** The tool_result of one call id. */
    private static RunEvent.ToolResult resultFor(List<RunEvent> events, String callId) {
        Optional<RunEvent.ToolResult> found = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> callId.equals(result.callId()))
                .findFirst();
        return found.orElseThrow(() -> new AssertionError("no tool_result for " + callId));
    }
}
