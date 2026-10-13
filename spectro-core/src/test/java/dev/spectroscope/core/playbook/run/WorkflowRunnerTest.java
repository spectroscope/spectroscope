package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.playbook.Workflow;
import dev.spectroscope.core.playbook.WorkflowReader;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 506, criterion 2: the workflow runner runs a step list in the session
 * that started it. A prompt step is a chat turn through the host, a fan-out is
 * {@code spawn_agents} in the background plus {@code wait_agents} plus one
 * summariser child, an end is the run's end.
 */
@Timeout(value = 30, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class WorkflowRunnerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    static final String RESEARCH = """
            {
              "name": "fanout-research",
              "steps": [
                { "kind": "prompt", "id": "frame", "template": "Frame the question: {{input}}" },
                {
                  "kind": "fanout",
                  "id": "explore",
                  "agents": [
                    { "task": "Look in the code for: {{previous}}" },
                    { "task": "Look in the docs for: {{previous}}" },
                    { "task": "Look in the tests for: {{previous}}" }
                  ],
                  "join": { "task": "Summarise what the helpers found:\\n{{results}}" }
                },
                { "kind": "end", "id": "done", "result": "answered" }
              ]
            }
            """;

    /** Children answer by the start of their task; the summariser answers with what it was handed. */
    static final class Children implements LlmProvider {
        final AtomicInteger runs = new AtomicInteger();
        final List<String> tasks = new CopyOnWriteArrayList<>();
        final Map<String, AtomicInteger> turns = new ConcurrentHashMap<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            String task = "";
            for (ProviderContent c : request.messages().getFirst().content()) {
                if (c instanceof TextContent t) {
                    task = t.text().strip();
                    break;
                }
            }
            if (turns.computeIfAbsent(task, t -> new AtomicInteger()).incrementAndGet() == 1) {
                runs.incrementAndGet();
                tasks.add(task);
            }
            if (task.startsWith("Summarise")) {
                return List.of(new PTextDelta("SUMMARY of " + task.split("\n").length + " lines"),
                        new PStop(PStop.StopReason.END_TURN));
            }
            if (task.startsWith("Look in the docs") && turns.get(task).get() == 1) {
                try {
                    return List.of(new PToolCall("s1", "report_status", JSON.readTree("{\"message\":\"reading the guide\"}")),
                            new PStop(PStop.StopReason.TOOL_USE));
                } catch (Exception e) {
                    throw new AssertionError(e);
                }
            }
            return List.of(new PTextDelta("found it in " + task.substring(12, 16)), new PStop(PStop.StopReason.END_TURN));
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

    static SubagentManager manager(LlmProvider provider, Path cwd, PeerInbox inbox) {
        SubagentManager m = new SubagentManager(SubagentConfig.builder().provider(provider).cwd(cwd)
                .parentAgentId("main").onPermission(request -> true).baseTools(List.of(listDir())).build());
        m.parentInbox(inbox);
        return m;
    }

    static Workflow workflow(String json) {
        WorkflowReader.Read read = WorkflowReader.read(json);
        assertEquals(List.of(), read.findings());
        return read.workflow();
    }

    record Ran(WorkflowRunner.Outcome outcome, FakeHost host, Children children, List<String> sidecar) {
    }

    /** Card 586: the run the fan-out test makes, a prompt and then a fan-out with a join, for WorkflowRunStepsTest. */
    static Ran promptThenFanout(Path tmp) throws IOException {
        return run(tmp, RESEARCH, "q", new CancelSignal());
    }

    private static Ran run(Path tmp, String json, String input, CancelSignal signal) throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        host.replies.add("the parser drops empty lines");
        Children children = new Children();
        Path sidecar = tmp.resolve("s.playbook.jsonl");
        WorkflowRunner.Outcome outcome;
        try (PlaybookRecorder recorder = new PlaybookRecorder(sidecar, PlaybookRecorder.DEFAULT_CEILING_BYTES)) {
            outcome = new WorkflowRunner(new WorkflowRunner.Setup(workflow(json), "workflows/x.json", "sha256:ab",
                    "0123456789ab", input, "en", recorder, signal), host,
                    manager(children, ws, new PeerInbox())).run();
        }
        return new Ran(outcome, host, children, Files.exists(sidecar) ? Files.readAllLines(sidecar) : List.of());
    }

    private static List<RunEvent.AgentMessage> messages(List<RunEvent> events, String role) {
        return events.stream().filter(RunEvent.AgentMessage.class::isInstance).map(RunEvent.AgentMessage.class::cast)
                .filter(m -> role.equals(m.role())).toList();
    }

    @Test
    void aPromptStepIsAChatTurnThroughTheHostWithItsTemplateFilled(@TempDir Path tmp) throws IOException {
        Ran r = run(tmp, RESEARCH, "why does the parser drop lines?", new CancelSignal());
        assertEquals(List.of("Frame the question: why does the parser drop lines?"), r.host().prompts);
    }

    @Test
    void aFanoutRunsThreeChildrenOnThePreviousAnswerAndOneSummariserOnTheirResults(@TempDir Path tmp) throws IOException {
        Ran r = run(tmp, RESEARCH, "q", new CancelSignal());
        assertEquals("done", r.outcome().stopReason(), r.outcome().toString());
        assertEquals("answered", r.outcome().result());
        assertEquals(4, r.children().runs.get(), "three children and one summariser: " + r.children().tasks);
        assertTrue(r.children().tasks.contains("Look in the code for: the parser drops empty lines"), r.children().tasks.toString());
        String summariser = r.children().tasks.stream().filter(t -> t.startsWith("Summarise")).findFirst().orElseThrow();
        for (String id : List.of("explore-1", "explore-2", "explore-3")) {
            assertTrue(summariser.contains("--- " + id + " (completed) ---"), summariser);
        }
        assertTrue(summariser.contains("found it in code") && summariser.contains("found it in test"), summariser);
        List<RunEvent> spawns = r.host().events.stream().filter(RunEvent.AgentSpawn.class::isInstance).toList();
        assertEquals(4, spawns.size(), "three in the background, then the summariser");
    }

    @Test
    void theSummaryIsTheRunsLastAnswerInTheChat(@TempDir Path tmp) throws IOException {
        Ran r = run(tmp, RESEARCH, "q", new CancelSignal());
        assertTrue(r.outcome().answer().startsWith("SUMMARY of"), r.outcome().toString());
        List<RunEvent.AgentMessage> peer = messages(r.host().events, "peer");
        RunEvent.AgentMessage last = peer.get(peer.size() - 1);
        assertEquals("explore-4", last.from());
        assertEquals("main", last.to());
        assertEquals("received", last.state());
        assertEquals(r.outcome().answer(), last.text());
        // Card 586: the run view's two closing lines, the fan-out's step_end and the run's run_end, come
        // after the summary; no other event of the run does.
        List<RunEvent> events = r.host().events;
        List<String> after = events.subList(events.lastIndexOf(last) + 1, events.size()).stream()
                .map(e -> e instanceof RunEvent.RunStep s ? s.phase() + (s.node() == null ? "" : ":" + s.node())
                        : e.getClass().getSimpleName())
                .toList();
        assertEquals(List.of("step_end:explore", "run_end"), after,
                "after the summary only the run's closing lines follow");
    }

    @Test
    void aChildsStatusLineDuringTheFanoutReachesTheChatAsAMessage(@TempDir Path tmp) throws IOException {
        Ran r = run(tmp, RESEARCH, "q", new CancelSignal());
        assertTrue(messages(r.host().events, "status").stream().anyMatch(m -> m.from().equals("explore-2")
                && m.text().equals("reading the guide")), r.host().events.toString());
        assertTrue(messages(r.host().events, "peer").stream().anyMatch(m -> m.from().equals("explore-2")
                && m.text().contains("reading the guide")), r.host().events.toString());
    }

    @Test
    void theSidecarRecordsTheRunItsStepsAndItsEnd(@TempDir Path tmp) throws IOException {
        Ran r = run(tmp, RESEARCH, "q", new CancelSignal());
        List<String> types = r.sidecar().stream().map(line -> {
            try {
                return JSON.readTree(line).path("type").asText() + ":" + JSON.readTree(line).path("step").asText("");
            } catch (IOException e) {
                throw new AssertionError(e);
            }
        }).toList();
        assertEquals(List.of("workflow_start:", "workflow_step:frame", "workflow_step:explore", "workflow_end:"), types);
        assertTrue(r.sidecar().get(0).contains("\"hash\":\"sha256:ab\""), r.sidecar().get(0));
        assertTrue(r.sidecar().get(3).contains("\"stopReason\":\"done\""), r.sidecar().get(3));
    }

    @Test
    void theRunWritesNoFileIntoTheWorkingFolder(@TempDir Path tmp) throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Files.writeString(ws.resolve("a.txt"), "x");
        Map<String, Long> before = listing(ws);
        run(tmp, RESEARCH, "q", new CancelSignal());
        assertEquals(before, listing(ws));
        assertEquals(1, before.size());
    }

    private static Map<String, Long> listing(Path dir) throws IOException {
        Map<String, Long> out = new TreeMap<>();
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path f : (Iterable<Path>) walk::iterator) {
                if (Files.isRegularFile(f)) {
                    out.put(dir.relativize(f).toString(), Files.size(f));
                }
            }
        }
        return out;
    }

    @Test
    void aRepeatingStepRunsUntilItsAnswerHoldsTheTextAndAtMostItsRounds(@TempDir Path tmp) throws IOException {
        String json = RESEARCH.replace("\"template\": \"Frame the question: {{input}}\"",
                "\"template\": \"Frame the question: {{input}}\", \"repeat_until\": \"READY\", \"max_rounds\": 3");
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        host.replies.addAll(List.of("not yet", "READY now"));
        WorkflowRunner.Outcome done = new WorkflowRunner(new WorkflowRunner.Setup(workflow(json), "w", "h",
                "0123456789ab", "q", "en", new PlaybookRecorder(tmp.resolve("a.jsonl"), 1 << 20), new CancelSignal()),
                host, manager(new Children(), ws, new PeerInbox())).run();
        assertEquals(2, host.prompts.size());
        assertEquals("done", done.stopReason());

        FakeHost never = new FakeHost(ws);
        never.replies.addAll(List.of("no", "no", "no", "no"));
        WorkflowRunner.Outcome exhausted = new WorkflowRunner(new WorkflowRunner.Setup(workflow(json), "w", "h",
                "0123456789ab", "q", "en", new PlaybookRecorder(tmp.resolve("b.jsonl"), 1 << 20), new CancelSignal()),
                never, manager(new Children(), ws, new PeerInbox())).run();
        assertEquals(3, never.prompts.size(), "max_rounds is the ceiling");
        assertEquals(WorkflowRunner.EXHAUSTED, exhausted.stopReason());
    }

    @Test
    void aCancelledRunStopsAsAbortedBeforeTheNextStep(@TempDir Path tmp) throws IOException {
        CancelSignal signal = new CancelSignal();
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        host.onChat.put("?", h -> signal.cancel());
        host.turnsIgnoreCancel = true;
        WorkflowRunner.Outcome out = new WorkflowRunner(new WorkflowRunner.Setup(workflow(RESEARCH), "w", "h",
                "0123456789ab", "q", "en", new PlaybookRecorder(tmp.resolve("c.jsonl"), 1 << 20), signal),
                host, manager(new Children(), ws, new PeerInbox())).run();
        assertEquals(RunStop.ABORTED, out.stopReason());
        assertFalse(host.events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance), "no child after the stop");
    }

    @Test
    void aFanoutWithoutAJoinAnswersWithTheJoinedResultsAndStartsNoSummariser(@TempDir Path tmp) throws IOException {
        String json = RESEARCH.replace(",\n      \"join\": { \"task\": \"Summarise what the helpers found:\\n{{results}}\" }", "");
        assertFalse(json.contains("\"join\""), json);
        Ran r = run(tmp, json, "q", new CancelSignal());
        assertEquals(3, r.children().runs.get());
        assertTrue(r.outcome().answer().contains("--- explore-3 (completed) ---"), r.outcome().answer());
    }

    @Test
    void theInputAndTheFolderReachTheTemplatesAndTheGermanTextIsUsedForGerman(@TempDir Path tmp) throws IOException {
        String json = RESEARCH.replace("\"template\": \"Frame the question: {{input}}\"",
                "\"template\": { \"en\": \"Frame: {{input}} in {{folder}}\", \"de\": \"Rahme: {{input}} in {{folder}}\" }");
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        new WorkflowRunner(new WorkflowRunner.Setup(workflow(json), "w", "h", "0123456789ab", "frage", "de",
                new PlaybookRecorder(tmp.resolve("d.jsonl"), 1 << 20), new CancelSignal()),
                host, manager(new Children(), ws, new PeerInbox())).run();
        assertEquals("Rahme: frage in " + ws, host.prompts.get(0));
    }

    @Test
    void aPlaceholderInsideTheInputStaysLiteral(@TempDir Path tmp) throws IOException {
        // Fix round 1: one pass over the template; an inserted value is never scanned again.
        String json = RESEARCH.replace("\"template\": \"Frame the question: {{input}}\"",
                "\"template\": \"Frame: {{input}} in {{folder}}\"");
        Ran r = run(tmp, json, "a {{previous}} and a {{folder}} and a {{results}}", new CancelSignal());
        assertEquals("Frame: a {{previous}} and a {{folder}} and a {{results}} in " + tmp.resolve("ws"),
                r.host().prompts.get(0));
    }

    @Test
    void aPlaceholderInsideThePreviousAnswerStaysLiteralInAJoinTask(@TempDir Path tmp) throws IOException {
        String json = RESEARCH.replace("\"task\": \"Summarise what the helpers found:\\n{{results}}\"",
                "\"task\": \"Summarise for {{previous}}:\\n{{results}}\"");
        assertTrue(json.contains("Summarise for {{previous}}"), json);
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        host.replies.add("the parser {{results}} drops {{folder}}");
        Children children = new Children();
        new WorkflowRunner(new WorkflowRunner.Setup(workflow(json), "w", "h", "0123456789ab", "q", "en",
                new PlaybookRecorder(tmp.resolve("d.jsonl"), 1 << 20), new CancelSignal()),
                host, manager(children, ws, new PeerInbox())).run();
        String summariser = children.tasks.stream().filter(t -> t.startsWith("Summarise")).findFirst().orElseThrow();
        assertTrue(summariser.startsWith("Summarise for the parser {{results}} drops {{folder}}:\n"), summariser);
        assertTrue(summariser.contains("--- explore-1 (completed) ---"), summariser);
    }

    @Test
    void theSummarisersTaskCarriesTheWorkflowLabelThePageReadsAsTheRunsAnswer(@TempDir Path tmp) throws IOException {
        // Fix round 1: the page draws the summariser's message in full in the main
        // thread by this label (peerMessages.ts); the reviewers carry none.
        Ran r = run(tmp, RESEARCH, "q", new CancelSignal());
        List<RunEvent.AgentMessage> tasks = messages(r.host().events, "task");
        assertEquals(4, tasks.size(), tasks.toString());
        RunEvent.AgentMessage summariser = tasks.get(3);
        assertEquals("explore-4", summariser.to());
        assertEquals(WorkflowRunner.SUMMARISER_LABEL_PREFIX + "explore", summariser.label());
        for (RunEvent.AgentMessage child : tasks.subList(0, 3)) {
            assertTrue(child.label() == null || !child.label().startsWith(WorkflowRunner.SUMMARISER_LABEL_PREFIX),
                    child.toString());
        }
    }

    // ---- Fix round 2: the failure exits ------------------------------------------------------

    private record Failed(WorkflowRunner.Outcome outcome, FakeHost host, Children children, List<JsonNode> sidecar) {
    }

    private static Failed runWith(Path tmp, String json, FakeHost host, LlmProvider provider, Children children,
                                  SubagentManager manager) throws IOException {
        Path sidecar = tmp.resolve("f.playbook.jsonl");
        WorkflowRunner.Outcome outcome;
        try (PlaybookRecorder recorder = new PlaybookRecorder(sidecar, PlaybookRecorder.DEFAULT_CEILING_BYTES)) {
            outcome = new WorkflowRunner(new WorkflowRunner.Setup(workflow(json), "workflows/x.json", "sha256:ab",
                    "0123456789ab", "q", "en", recorder, new CancelSignal()), host, manager).run();
        }
        List<JsonNode> records = new java.util.ArrayList<>();
        for (String line : Files.readAllLines(sidecar)) {
            records.add(JSON.readTree(line));
        }
        return new Failed(outcome, host, children, records);
    }

    private static JsonNode end(List<JsonNode> sidecar) {
        JsonNode last = sidecar.get(sidecar.size() - 1);
        assertEquals("workflow_end", last.path("type").asText(), sidecar.toString());
        return last;
    }

    private static List<RunEvent.AgentMessage> answers(FakeHost host) {
        return messages(host.events, "peer").stream().filter(m -> "main".equals(m.to()) && "received".equals(m.state()))
                .toList();
    }

    /** Card 586: holds the run's run_step lines to their pairing and returns the end line of one step. */
    private static RunEvent.RunStep pairedEnd(FakeHost host, String node) {
        List<RunEvent.RunStep> lines = PlaybookRunStepsTest.lines(host);
        PlaybookRunStepsTest.assertPaired(lines);
        return lines.stream().filter(l -> RunEvent.RunStep.STEP_END.equals(l.phase()) && node.equals(l.node()))
                .findFirst().orElseThrow();
    }

    @Test
    void aSpawnTheManagerRefusesEndsTheRunAsStepFailedWithNoSummariserAndNoAnswer(@TempDir Path tmp)
            throws IOException {
        // Agent messaging off: spawn_agents offers no background and answers with an ERROR: string.
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        Children children = new Children();
        SubagentManager off = new SubagentManager(SubagentConfig.builder().provider(children).cwd(ws)
                .parentAgentId("main").onPermission(request -> true).baseTools(List.of(listDir()))
                .agentMessaging(false).build());
        off.parentInbox(new PeerInbox());
        Failed f = runWith(tmp, RESEARCH, host, children, children, off);
        assertEquals(RunStop.STEP_FAILED, f.outcome().stopReason(), f.outcome().toString());
        assertTrue(f.outcome().detail().startsWith("explore: ERROR:"), f.outcome().detail());
        assertEquals(0, children.runs.get(), "no child ran, the summariser neither: " + children.tasks);
        assertFalse(host.events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance), host.events.toString());
        assertEquals(List.of(), answers(host));
        JsonNode end = end(f.sidecar());
        assertEquals(RunStop.STEP_FAILED, end.path("stopReason").asText());
        assertTrue(end.path("detail").asText().contains("background is not available"), end.toString());
        assertEquals(RunSteps.FAILED, pairedEnd(host, "explore").status());
    }

    @Test
    void aSummariserThatFailsEndsTheRunAsStepFailedWithNoAnswerBlock(@TempDir Path tmp) throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        Children children = new Children();
        LlmProvider silentSummariser = new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                for (ProviderContent c : request.messages().getFirst().content()) {
                    if (c instanceof TextContent t && t.text().strip().startsWith("Summarise")) {
                        return List.of(new PStop(PStop.StopReason.END_TURN));
                    }
                }
                return children.stream(request);
            }
        };
        Failed f = runWith(tmp, RESEARCH, host, silentSummariser, children,
                manager(silentSummariser, ws, new PeerInbox()));
        assertEquals(RunStop.STEP_FAILED, f.outcome().stopReason(), f.outcome().toString());
        assertTrue(f.outcome().detail().startsWith("explore: the summariser failed: ERROR:"), f.outcome().detail());
        assertTrue(host.events.stream().anyMatch(e -> e instanceof RunEvent.AgentSpawn s && s.agentId().equals("explore-4")),
                "the summariser was started");
        assertEquals(List.of(), answers(host).stream().filter(m -> m.from().equals("explore-4")).toList(),
                "a failed summariser gives the run no answer");
        JsonNode end = end(f.sidecar());
        assertEquals(RunStop.STEP_FAILED, end.path("stopReason").asText());
        assertTrue(end.path("detail").asText().contains("the summariser failed"), end.toString());
        assertTrue(end.path("result").isNull(), end.toString());
        assertEquals(RunSteps.FAILED, pairedEnd(host, "explore").status());
    }

    @Test
    void aPromptTurnThatEndsInAnErrorEndsTheRunAsStepFailedBeforeTheFanout(@TempDir Path tmp) throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        host.stopReasons.add("error");
        host.replies.add("the provider is unreachable");
        Children children = new Children();
        Failed f = runWith(tmp, RESEARCH, host, children, children, manager(children, ws, new PeerInbox()));
        assertEquals(RunStop.STEP_FAILED, f.outcome().stopReason(), f.outcome().toString());
        assertEquals("frame: the provider is unreachable", f.outcome().detail());
        assertEquals(0, children.runs.get(), children.tasks.toString());
        assertFalse(host.events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance));
        JsonNode end = end(f.sidecar());
        assertEquals(RunStop.STEP_FAILED, end.path("stopReason").asText());
        assertEquals("frame: the provider is unreachable", end.path("detail").asText());
    }

    @Test
    void aPromptTurnThatWasAbortedEndsTheRunAsAbortedEvenWhenTheRunsSignalIsNotCancelled(@TempDir Path tmp)
            throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = new FakeHost(ws);
        host.stopReasons.add("aborted");
        Children children = new Children();
        Failed f = runWith(tmp, RESEARCH, host, children, children, manager(children, ws, new PeerInbox()));
        assertEquals(RunStop.ABORTED, f.outcome().stopReason(), f.outcome().toString());
        assertEquals("frame: the chat turn was aborted", f.outcome().detail());
        assertEquals(0, children.runs.get(), children.tasks.toString());
        assertFalse(host.events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance));
        assertEquals(RunStop.ABORTED, end(f.sidecar()).path("stopReason").asText());
    }
}
