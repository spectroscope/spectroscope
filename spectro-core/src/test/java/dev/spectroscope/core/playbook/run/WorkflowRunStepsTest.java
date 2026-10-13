package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static dev.spectroscope.core.playbook.run.PlaybookRunStepsTest.assertPaired;
import static dev.spectroscope.core.playbook.run.PlaybookRunStepsTest.lines;
import static dev.spectroscope.core.playbook.run.PlaybookRunStepsTest.shape;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 586: a workflow run tells the run view its prompt and fan-out steps. */
@Timeout(value = 30, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class WorkflowRunStepsTest {

    @TempDir Path tmp;

    private FakeHost host() throws IOException {
        return new FakeHost(Files.createDirectories(tmp.resolve("ws")));
    }

    /** Runs a workflow on the fake host; its children and its summariser answer through {@code provider}. */
    private WorkflowRunner.Outcome run(String json, String input, FakeHost host, LlmProvider provider,
                                       CancelSignal signal) {
        try (PlaybookRecorder recorder = new PlaybookRecorder(tmp.resolve("s.playbook.jsonl"),
                PlaybookRecorder.DEFAULT_CEILING_BYTES)) {
            return new WorkflowRunner(new WorkflowRunner.Setup(WorkflowRunnerTest.workflow(json), "workflows/x.json",
                    "sha256:ab", "0123456789ab", input, "en", recorder, signal), host,
                    WorkflowRunnerTest.manager(provider, host.workspace, new PeerInbox())).run();
        }
    }

    private WorkflowRunner.Outcome run(String json, FakeHost host, LlmProvider provider, CancelSignal signal) {
        return run(json, "q", host, provider, signal);
    }

    private WorkflowRunner.Outcome run(FakeHost host, CancelSignal signal) {
        return run(WorkflowRunnerTest.RESEARCH, host, new WorkflowRunnerTest.Children(), signal);
    }

    /** {@link WorkflowRunnerTest#RESEARCH} with a first step that repeats until its answer holds READY, 3 rounds at most. */
    private static String repeating() {
        String json = WorkflowRunnerTest.RESEARCH.replace("\"template\": \"Frame the question: {{input}}\"",
                "\"template\": \"Frame the question: {{input}}\", \"repeat_until\": \"READY\", \"max_rounds\": 3");
        assertTrue(json.contains("\"max_rounds\": 3"), "positive: the first step repeats");
        return json;
    }

    private static String taskOf(ProviderRequest request) {
        for (ProviderContent c : request.messages().getFirst().content()) {
            if (c instanceof TextContent t) {
                return t.text().strip();
            }
        }
        return "";
    }

    @Test
    void aPromptStepAndAFanOutOpenAndCloseAndTheRunEnds() throws Exception {
        // Build the same two-step workflow (a prompt, then a fan-out with a join) that
        // WorkflowRunnerTest uses for its fan-out case, and run it the same way.
        WorkflowRunnerTest.Ran ran = WorkflowRunnerTest.promptThenFanout(tmp);

        List<RunEvent.RunStep> l = ran.host().events.stream().filter(RunEvent.RunStep.class::isInstance)
                .map(RunEvent.RunStep.class::cast).toList();
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start", "step_end", "step_start", "step_end", "run_end"),
                l.stream().map(RunEvent.RunStep::phase).toList());
        assertEquals("workflow", l.get(0).runKind());
        assertEquals(List.of("prompt", "fanout"), l.get(0).nodes().stream().map(RunEvent.RunNode::kind).toList());
        assertEquals("chat", l.get(1).performer());
        assertTrue(l.get(1).input() != null && !l.get(1).input().isBlank());
        assertEquals("child", l.get(3).performer());
        assertTrue(l.get(4).children() != null && !l.get(4).children().isEmpty(), "the fan-out names its children");
        assertEquals("done", l.get(4).status());
        assertEquals("done", l.get(5).stopReason());
    }

    /** Card 586, straggler M5: a workflow's run_start binds the run to the real path of its folder, and only it. */
    @Test
    void theRunStartCarriesTheFingerprintOfTheRealWorkspaceAndNoOtherLineDoes() throws IOException {
        Path real = Files.createDirectories(tmp.resolve("ws"));
        Path link = Files.createSymbolicLink(tmp.resolve("ws-link"), real);
        FakeHost host = new FakeHost(link);
        host.replies.add("the parser drops empty lines");
        run(host, new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertEquals("run_start", l.get(0).phase());
        assertEquals(RunEvent.RunStep.fingerprintOf(real.toRealPath()), l.get(0).workspaceFingerprint());
        assertNotEquals(RunEvent.RunStep.fingerprintOf(link), l.get(0).workspaceFingerprint(),
                "premise: the link and the real folder differ");
        assertTrue(l.size() > 2, "positive: the run wrote its step lines " + shape(l));
        assertEquals(List.of(), l.subList(1, l.size()).stream()
                .filter(s -> s.workspaceFingerprint() != null).map(RunEvent.RunStep::phase).toList());
    }

    @Test
    void theLinesNameEachStepItsModelItsInputAndItsOutput() throws IOException {
        String json = WorkflowRunnerTest.RESEARCH.replace("\"id\": \"explore\",",
                "\"id\": \"explore\", \"label\": \"Search three places\",");
        assertTrue(json.contains("\"label\": \"Search three places\""), "positive: the fan-out carries a label");
        FakeHost host = host();
        host.replies.add("the parser drops empty lines");
        WorkflowRunner.Outcome out = run(json, host, new WorkflowRunnerTest.Children(), new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "step_start:explore#1",
                "step_end:explore#1", "run_end"), shape(l));

        RunEvent.RunStep start = l.get(0);
        assertEquals("fanout-research", start.name());
        assertEquals("q", start.task());
        assertEquals(List.of(new RunEvent.RunNode("frame", "frame", "prompt"),
                new RunEvent.RunNode("explore", "Search three places", "fanout")), start.nodes(),
                "the step list without its end; a fan-out goes by its label");

        RunEvent.RunStep prompt = l.get(1);
        assertEquals("prompt", prompt.kind());
        assertEquals("frame", prompt.name());
        assertEquals("chat", prompt.performer());
        assertEquals("lmstudio", prompt.provider());
        assertEquals("start-model", prompt.model());
        assertEquals("Frame the question: q", prompt.input());
        assertEquals(List.of("Frame the question: q"), host.prompts, "positive: the chat was sent the same text");
        RunEvent.RunStep answered = l.get(2);
        assertEquals(RunSteps.DONE, answered.status());
        assertEquals("the parser drops empty lines", answered.output());

        RunEvent.RunStep fanout = l.get(3);
        assertEquals("fanout", fanout.kind());
        assertEquals("Search three places", fanout.name());
        assertEquals("child", fanout.performer());
        assertEquals("Look in the code for: the parser drops empty lines\n"
                + "Look in the docs for: the parser drops empty lines\n"
                + "Look in the tests for: the parser drops empty lines", fanout.input());
        RunEvent.RunStep joined = l.get(4);
        assertEquals("Search three places", joined.name());
        assertEquals(RunSteps.DONE, joined.status());
        assertEquals(List.of("explore-1", "explore-2", "explore-3", "explore-4"), joined.children(),
                "the three helpers and the summariser");
        assertEquals(out.answer(), joined.output(), "the fan-out's output is the summary");
        assertTrue(joined.output().startsWith("SUMMARY of"), joined.output());

        RunEvent.RunStep end = l.get(5);
        assertEquals(RunStop.DONE, end.stopReason());
        assertEquals("answered", end.result());
        assertNull(end.detail());
        assertTrue(l.stream().allMatch(x -> x.round() == null && x.maxRounds() == null),
                "no step of this workflow repeats, so no line names a round");
    }

    @Test
    void aPromptStepWhoseTurnFailsClosesAsFailedWithItsErrorAndTheRunEnds() throws IOException {
        FakeHost host = host();
        host.stopReasons.add("error");
        host.replies.add("the provider is unreachable");
        WorkflowRunner.Outcome out = run(host, new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertEquals(RunSteps.FAILED, l.get(2).status());
        assertEquals("frame: the provider is unreachable", l.get(2).error());
        assertNull(l.get(1).round(), "a step that does not repeat names no round");
        assertNull(l.get(2).round(), "also on the end of a failed run of it");
        assertEquals(RunStop.STEP_FAILED, l.get(3).stopReason());
        assertEquals("frame: the provider is unreachable", l.get(3).detail());
        assertEquals(RunStop.STEP_FAILED, out.stopReason(), "positive: the run failed at its first step");
    }

    @Test
    void aStopDuringAPromptStepClosesItAsStoppedAndTheRunEnds() throws IOException {
        CancelSignal signal = new CancelSignal();
        FakeHost host = host();
        host.onChat.put("?", h -> signal.cancel());
        run(host, signal);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertEquals(RunSteps.STOPPED, l.get(2).status());
        assertEquals(RunStop.ABORTED, l.get(3).stopReason());
        assertTrue(signal.isCancelled(), "positive: the Stop landed");
    }

    @Test
    void aChatTurnTheHostAbortsClosesTheStepAsStopped() throws IOException {
        // The chat's own Stop ends the turn as aborted while the run's signal stays live.
        CancelSignal signal = new CancelSignal();
        FakeHost host = host();
        host.stopReasons.add("aborted");
        run(host, signal);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertFalse(signal.isCancelled(), "positive: the run's signal was never cancelled");
        assertEquals(RunSteps.STOPPED, l.get(2).status());
        assertEquals(RunStop.ABORTED, l.get(3).stopReason());
    }

    @Test
    void aStopWhileTheSummariserRunsClosesTheFanOutAsStoppedAndNamesItsChildren() throws IOException {
        CancelSignal signal = new CancelSignal();
        WorkflowRunnerTest.Children children = new WorkflowRunnerTest.Children();
        LlmProvider stopAtTheSummary = new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (taskOf(request).startsWith("Summarise")) {
                    signal.cancel();
                }
                return children.stream(request);
            }
        };
        FakeHost host = host();
        WorkflowRunner.Outcome out = run(WorkflowRunnerTest.RESEARCH, host, stopAtTheSummary, signal);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "step_start:explore#1",
                "step_end:explore#1", "run_end"), shape(l));
        RunEvent.RunStep end = l.get(4);
        assertEquals(RunSteps.STOPPED, end.status());
        assertEquals(List.of("explore-1", "explore-2", "explore-3", "explore-4"), end.children(),
                "a stopped fan-out still names the children it started");
        assertEquals(RunStop.ABORTED, l.get(5).stopReason());
        assertEquals(RunStop.ABORTED, out.stopReason());
    }

    @Test
    void aStopBetweenStepsOpensNoEntryForTheNextStep() throws IOException {
        CancelSignal signal = new CancelSignal();
        FakeHost host = host();
        // The Stop lands while the first step's end line goes out, after that step's last check; the
        // predicate never fails an emit.
        host.failEmit = e -> {
            if (e instanceof RunEvent.RunStep s && RunEvent.RunStep.STEP_END.equals(s.phase())) {
                signal.cancel();
            }
            return false;
        };
        run(host, signal);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertEquals(RunSteps.DONE, l.get(2).status(), "the first step had ended when the Stop came");
        assertEquals(RunStop.ABORTED, l.get(3).stopReason());
        assertEquals("stopped during explore", l.get(3).detail());
        assertFalse(host.events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance), "no child after the Stop");
    }

    @Test
    void aHostThatThrowsDuringAPromptStepClosesItAsFailedAndTheRunEnds() throws IOException {
        FakeHost host = host();
        host.onChat.put("?", h -> { throw new IllegalStateException("host broke"); });
        WorkflowRunner.Outcome out = run(host, new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertEquals(RunSteps.FAILED, l.get(2).status());
        assertEquals("host broke", l.get(2).error());
        assertEquals(RunStop.STEP_FAILED, l.get(3).stopReason());
        assertEquals("host broke", l.get(3).detail());
        assertEquals(RunStop.STEP_FAILED, out.stopReason(), "positive: the run returned its outcome");
    }

    @Test
    void aHostThatThrowsAfterAStopClosesTheStepAsStopped() throws IOException {
        // Stop closes the chat's socket, and the host throws instead of returning an aborted turn.
        CancelSignal signal = new CancelSignal();
        FakeHost host = host();
        host.onChat.put("?", h -> {
            signal.cancel();
            throw new IllegalStateException("socket closed");
        });
        run(host, signal);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertEquals(RunSteps.STOPPED, l.get(2).status(), "the owner pressed Stop, the step did not fail");
        assertEquals("socket closed", l.get(2).error());
        assertEquals(RunStop.ABORTED, l.get(3).stopReason());
    }

    @Test
    void anErrorInAStepStillClosesItAndTheRun() throws IOException {
        FakeHost host = host();
        host.onChat.put("?", h -> { throw new PlaybookRunStepsTest.HostError("host broke"); });
        assertThrows(PlaybookRunStepsTest.HostError.class, () -> run(host, new CancelSignal()));

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertEquals(RunSteps.FAILED, l.get(2).status());
        assertEquals("host broke", l.get(2).error());
        assertEquals(RunStop.STEP_FAILED, l.get(3).stopReason());
        assertEquals("host broke", l.get(3).detail());
    }

    @Test
    void aStepWhoseStartLineFailsStillOpensAndClosesIt() throws IOException {
        FakeHost host = host();
        host.failEmit = e -> e instanceof RunEvent.RunStep s && RunEvent.RunStep.STEP_START.equals(s.phase());
        WorkflowRunner.Outcome out = run(host, new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertTrue(host.prompts.isEmpty(), "positive: the step failed before its chat turn");
        assertNull(l.get(1).round(), "the late start of a step that does not repeat names no round");
        assertEquals(RunSteps.FAILED, l.get(2).status());
        assertEquals("emit broke", l.get(2).error());
        assertEquals(RunStop.STEP_FAILED, l.get(3).stopReason());
        assertEquals(RunStop.STEP_FAILED, out.stopReason());
    }

    @Test
    void eachRoundOfARepeatingStepIsItsOwnEntryWithItsRoundOnStartAndEnd() throws IOException {
        FakeHost host = host();
        host.replies.addAll(List.of("not yet", "READY now"));
        run(repeating(), host, new WorkflowRunnerTest.Children(), new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "step_start:frame#2",
                "step_end:frame#2", "step_start:explore#1", "step_end:explore#1", "run_end"), shape(l));
        List<RunEvent.RunStep> frame = l.stream().filter(x -> "frame".equals(x.node())).toList();
        assertEquals(List.of(1, 1, 2, 2), frame.stream().map(RunEvent.RunStep::round).toList(),
                "a round's start and its end name the same round");
        assertTrue(frame.stream().allMatch(x -> Integer.valueOf(3).equals(x.maxRounds())), "the ceiling on every line");
        assertEquals(List.of("not yet", "READY now"), frame.stream()
                .filter(x -> RunEvent.RunStep.STEP_END.equals(x.phase())).map(RunEvent.RunStep::output).toList());
        assertTrue(l.stream().filter(x -> "explore".equals(x.node()))
                        .allMatch(x -> x.round() == null && x.maxRounds() == null),
                "a step that does not repeat names no round and no ceiling");
    }

    @Test
    void aRepeatingStepThatNeverHoldsItsTextEndsTheRunExhaustedAfterItsLastRound() throws IOException {
        FakeHost host = host();
        host.replies.addAll(List.of("no", "no", "no"));
        WorkflowRunner.Outcome out = run(repeating(), host, new WorkflowRunnerTest.Children(), new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "step_start:frame#2",
                "step_end:frame#2", "step_start:frame#3", "step_end:frame#3", "run_end"), shape(l));
        List<RunEvent.RunStep> ends = l.stream().filter(x -> RunEvent.RunStep.STEP_END.equals(x.phase())).toList();
        assertTrue(ends.stream().allMatch(x -> RunSteps.DONE.equals(x.status())), "every round ran to its end");
        assertEquals(List.of(1, 2, 3), ends.stream().map(RunEvent.RunStep::round).toList());
        RunEvent.RunStep last = l.get(l.size() - 1);
        assertEquals(WorkflowRunner.EXHAUSTED, last.stopReason());
        assertEquals("frame: 3 rounds ran and the answer never held \"READY\"", last.detail());
        assertEquals(WorkflowRunner.EXHAUSTED, out.stopReason());
    }

    // Fix round 1.

    @Test
    void aRunWithoutInputHasNoTask() throws IOException {
        FakeHost host = host();
        run(WorkflowRunnerTest.RESEARCH, "", host, new WorkflowRunnerTest.Children(), new CancelSignal());
        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(RunEvent.RunStep.RUN_START, l.get(0).phase());
        assertNull(l.get(0).task(), "an empty input is no task");
        assertEquals("Frame the question: ", host.prompts.get(0), "positive: the template still got the input");

        FakeHost blank = host();
        run(WorkflowRunnerTest.RESEARCH, " \n ", blank, new WorkflowRunnerTest.Children(), new CancelSignal());
        assertPaired(lines(blank));
        assertNull(lines(blank).get(0).task(), "a blank input is no task either");

        FakeHost none = host();
        run(WorkflowRunnerTest.RESEARCH, null, none, new WorkflowRunnerTest.Children(), new CancelSignal());
        assertPaired(lines(none));
        assertNull(lines(none).get(0).task(), "no input is no task");
        assertEquals("Frame the question: ", none.prompts.get(0), "positive: no input fills as empty");
    }

    // Straggler round.

    @Test
    void aLateStartOfARepeatingRoundKeepsItsRoundAndItsCeiling() throws IOException {
        FakeHost host = host();
        host.replies.add("not yet");
        AtomicInteger starts = new AtomicInteger();
        // The second step_start, round 2's, fails; FakeHost clears the predicate after that one failure.
        host.failEmit = e -> e instanceof RunEvent.RunStep s && RunEvent.RunStep.STEP_START.equals(s.phase())
                && starts.incrementAndGet() == 2;
        run(repeating(), host, new WorkflowRunnerTest.Children(), new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "step_start:frame#2",
                "step_end:frame#2", "run_end"), shape(l));
        assertEquals(List.of("Frame the question: q"), host.prompts, "positive: round 2 never reached the chat");
        RunEvent.RunStep late = l.get(3);
        assertNull(late.model(), "positive: round 2's start went out late, without a model");
        assertEquals(Integer.valueOf(2), late.round());
        assertEquals(Integer.valueOf(3), late.maxRounds());
        RunEvent.RunStep end = l.get(4);
        assertEquals(RunSteps.FAILED, end.status());
        assertEquals("emit broke", end.error());
        assertEquals(Integer.valueOf(2), end.round());
    }

    @Test
    void aRunStartLineThatFailsStillOpensAndEndsTheRun() throws IOException {
        FakeHost host = host();
        host.failEmit = e -> e instanceof RunEvent.RunStep s && RunEvent.RunStep.RUN_START.equals(s.phase());
        IllegalStateException thrown = assertThrows(IllegalStateException.class, () -> run(host, new CancelSignal()));
        assertEquals("emit broke", thrown.getMessage());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "run_end"), shape(l));
        assertEquals(RunStop.STEP_FAILED, l.get(1).stopReason());
        assertEquals("emit broke", l.get(1).detail());
        assertTrue(host.prompts.isEmpty(), "positive: no step ran");
    }

    @Test
    void aRoundThatFailsKeepsItsRoundAndItsCeiling() throws IOException {
        FakeHost host = host();
        host.replies.addAll(List.of("not yet", "the provider is unreachable"));
        host.stopReasons.addAll(List.of("end_turn", "error"));
        run(repeating(), host, new WorkflowRunnerTest.Children(), new CancelSignal());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "step_start:frame#2",
                "step_end:frame#2", "run_end"), shape(l));
        RunEvent.RunStep end = l.get(4);
        assertEquals(RunSteps.FAILED, end.status());
        assertEquals("frame: the provider is unreachable", end.error());
        assertEquals(Integer.valueOf(2), end.round());
        assertEquals(Integer.valueOf(3), end.maxRounds());
        assertEquals(RunStop.STEP_FAILED, l.get(5).stopReason());
    }

    @Test
    void aStepEndLineThatFailsLeavesOneFailedEnd() throws IOException {
        FakeHost host = host();
        host.failEmit = e -> e instanceof RunEvent.RunStep s && RunEvent.RunStep.STEP_END.equals(s.phase());
        WorkflowRunner.Outcome out = run(host, new CancelSignal());

        // The run_step lines only: the sidecar holds a second workflow_step record for this round.
        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:frame#1", "step_end:frame#1", "run_end"), shape(l));
        assertEquals(RunSteps.FAILED, l.get(2).status());
        assertEquals("emit broke", l.get(2).error());
        assertEquals(RunStop.STEP_FAILED, l.get(3).stopReason());
        assertEquals("emit broke", l.get(3).detail());
        assertEquals(RunStop.STEP_FAILED, out.stopReason());
    }
}
