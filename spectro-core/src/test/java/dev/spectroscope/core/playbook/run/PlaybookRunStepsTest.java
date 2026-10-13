package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 586: a playbook run tells the run view every step and decision. */
class PlaybookRunStepsTest {

    @TempDir Path tmp;

    static List<RunEvent.RunStep> lines(FakeHost host) {
        return host.events.stream().filter(RunEvent.RunStep.class::isInstance).map(RunEvent.RunStep.class::cast).toList();
    }

    static List<String> shape(List<RunEvent.RunStep> lines) {
        return lines.stream().map(l -> l.phase() + (l.node() == null ? "" : ":" + l.node() + "#" + l.entry())).toList();
    }

    /**
     * Card 586, criterion 1: every step_start has exactly one step_end with the same run, node and entry,
     * after it, and no step_end comes without its start.
     */
    static void assertPaired(List<RunEvent.RunStep> lines) {
        Set<String> started = new HashSet<>();
        Set<String> ended = new HashSet<>();
        for (RunEvent.RunStep l : lines) {
            String key = l.runId() + " " + l.node() + "#" + l.entry();
            if (RunEvent.RunStep.STEP_START.equals(l.phase())) {
                assertTrue(started.add(key), "a second step_start for " + key);
            } else if (RunEvent.RunStep.STEP_END.equals(l.phase())) {
                assertTrue(started.contains(key), "a step_end without a step_start before it: " + key);
                assertTrue(ended.add(key), "a second step_end for " + key);
            }
        }
        assertEquals(started, ended, "every step_start has its step_end");
    }

    /** The id of the one child the run spawned. */
    static String onlyChild(FakeHost host) {
        List<String> ids = host.events.stream().filter(RunEvent.AgentSpawn.class::isInstance)
                .map(e -> ((RunEvent.AgentSpawn) e).agentId()).toList();
        assertEquals(1, ids.size(), ids.toString());
        return ids.get(0);
    }

    /** What the one child the run spawned came back with, as its result message says. */
    static String childOutcome(FakeHost host) {
        return host.events.stream().filter(e -> e instanceof RunEvent.AgentMessage m && "result".equals(m.role()))
                .map(e -> ((RunEvent.AgentMessage) e).text()).findFirst().orElseThrow();
    }

    /** An Error from the host, which no catch for exceptions sees. */
    static final class HostError extends Error {
        HostError(String message) {
            super(message);
        }
    }

    /**
     * Card 586, review I1: the first step reads a ticket at the location the test gives, the second reads
     * the spec the first wrote, at a path its pattern only sketches, and the ticket again.
     */
    static String readsPlaybook(String ticketAt) {
        return """
            { "schema_version": 1, "id": "rd", "name": "Rd", "description": "d",
              "models": { "strong": { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" } },
                          "fast":   { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
              "documents": { "ticket": { "name": "Ticket", "purpose": "p", "location": "%s" },
                             "spec":   { "name": "Spec", "purpose": "p", "location": "docs/*-spec.md" } },
              "checks": {},
              "start": "brainstorm",
              "nodes": [
                { "kind": "step", "id": "brainstorm", "name": "Brainstorm", "performer": "chat", "model": "strong",
                  "consumes": ["ticket"], "produces": ["spec"] },
                { "kind": "step", "id": "build", "name": "Build", "performer": "child", "role": "worker",
                  "model": "fast", "consumes": ["spec", "ticket"] },
                { "kind": "end", "id": "done", "result": "done" }
              ],
              "arrows": [
                { "from": "brainstorm", "to": "build" },
                { "from": "build", "to": "done" }
              ] }
            """.formatted(ticketAt);
    }

    /** The LOOP playbook with its build step private, so the refusal check asks the host for kinds. */
    static String privateBuild() {
        String json = VocabularyTest.LOOP.replace("\"model\": \"fast\", \"consumes\"",
                "\"model\": \"fast\", \"privacy\": \"private\", \"consumes\"");
        assertTrue(json.contains("\"privacy\": \"private\""), "positive: the build step is private");
        return json;
    }

    /**
     * A chat step writes the plan and a review decides on it. The reviewing child of {@link FakeHost}
     * answers "built", so the label "built" passes and any other label leaves the review without one.
     */
    static String review(String label, String start) {
        return """
            { "schema_version": 1, "id": "r", "name": "R", "description": "d",
              "models": { "strong": { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" } } },
              "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "plan.md" } },
              "checks": { "plan_ok": { "kind": "review", "model": "strong", "reads": ["plan"], "ask": "Is it right?",
                                       "labels": ["%1$s", "redo"] } },
              "start": "%2$s",
              "nodes": [
                { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "strong",
                  "produces": ["plan"] },
                { "kind": "decision", "id": "review", "name": "Review", "check": "plan_ok" },
                { "kind": "end", "id": "done", "result": "done" }
              ],
              "arrows": [
                { "from": "write_plan", "to": "review" },
                { "from": "review", "to": "done", "on": "%1$s" },
                { "from": "review", "to": "write_plan", "on": "redo" }
              ] }
            """.formatted(label, start);
    }

    @Test
    void aChatStepADecisionAndAChildStepEachOpenAndClose() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        host.replies.add("the plan is written");
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:plan_ok#1", "step_end:plan_ok#1", "step_start:build#1", "step_end:build#1", "run_end"),
                shape(l));

        RunEvent.RunStep start = l.get(0);
        assertEquals("playbook", start.runKind());
        assertEquals(List.of("write_plan", "plan_ok", "build"), start.nodes().stream().map(RunEvent.RunNode::id).toList());
        assertEquals("T", start.name());
        assertEquals(List.of(new RunEvent.RunNode("write_plan", "Write plan", "step"),
                new RunEvent.RunNode("plan_ok", "Plan ok", "decision"), new RunEvent.RunNode("build", "Build", "step")),
                start.nodes());

        RunEvent.RunStep chatStart = l.get(1);
        assertEquals("chat", chatStart.performer());
        assertEquals("anthropic", chatStart.provider());
        assertEquals("claude-opus-5-5", chatStart.model());
        assertTrue(chatStart.input().contains("Write: Plan at plan.md"), chatStart.input());

        RunEvent.RunStep chatEnd = l.get(2);
        assertEquals("done", chatEnd.status());
        assertEquals("the plan is written", chatEnd.output());
        assertEquals(List.of(new RunEvent.RunDoc("plan", "plan.md", "created")), chatEnd.documents());

        RunEvent.RunStep checkEnd = l.get(4);
        assertEquals("decision", checkEnd.kind());
        assertEquals("pass", checkEnd.label());

        RunEvent.RunStep childStart = l.get(5);
        assertEquals("child", childStart.performer());
        assertEquals("worker", childStart.role());
        assertEquals(List.of(new RunEvent.RunDoc("plan", "plan.md", null)), childStart.reads());
        RunEvent.RunStep childEnd = l.get(6);
        assertNotNull(childEnd.childId());
        assertTrue(childEnd.childId().startsWith("worker-"), childEnd.childId());

        RunEvent.RunStep end = l.get(7);
        assertEquals("done", end.stopReason());
        assertEquals("done", end.result());
    }

    /**
     * Card 586, straggler M5: the run_start line binds the run to its folder by the
     * fingerprint of the folder's real path, never the path itself; no other line
     * carries it. The host works through a link, so only the real path matches.
     */
    @Test
    void theRunStartCarriesTheFingerprintOfTheRealWorkspaceAndNoOtherLineDoes() throws IOException {
        Path real = Files.createDirectories(tmp.resolve("ws"));
        Path link = Files.createSymbolicLink(tmp.resolve("ws-link"), real);
        FakeHost host = new FakeHost(link);
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        host.replies.add("the plan is written");
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertEquals("run_start", l.get(0).phase());
        assertEquals(RunEvent.RunStep.fingerprintOf(real.toRealPath()), l.get(0).workspaceFingerprint());
        assertNotEquals(RunEvent.RunStep.fingerprintOf(link), l.get(0).workspaceFingerprint(),
                "premise: the link and the real folder differ");
        assertEquals(List.of(), l.subList(1, l.size()).stream()
                .filter(s -> s.workspaceFingerprint() != null).map(RunEvent.RunStep::phase).toList());
    }

    @Test
    void aLoopGivesTheSameNodeASecondEntryAndTheDecisionItsRounds() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        assertPaired(lines(host));
        List<RunEvent.RunStep> ends = lines(host).stream()
                .filter(x -> "step_end".equals(x.phase()) && "plan_ok".equals(x.node())).toList();
        assertEquals(List.of("fail", "fail", "exhausted"), ends.stream().map(RunEvent.RunStep::label).toList());
        assertEquals(List.of(1, 2, 3), ends.stream().map(RunEvent.RunStep::entry).toList());
        assertEquals(List.of(1, 2, 3), ends.stream().map(RunEvent.RunStep::round).toList(),
                "an end names the round its entry opened, so the exhausted entry reads round 3 of 2");
        assertTrue(ends.stream().allMatch(x -> Integer.valueOf(2).equals(x.maxRounds())));

        List<RunEvent.RunStep> starts = lines(host).stream()
                .filter(x -> "step_start".equals(x.phase()) && "plan_ok".equals(x.node())).toList();
        assertEquals(List.of(1, 2, 3), starts.stream().map(RunEvent.RunStep::round).toList(),
                "a start names the round it opens, counted from 1 within the loop");
        assertTrue(starts.stream().allMatch(x -> Integer.valueOf(2).equals(x.maxRounds())));
    }

    @Test
    void aChangedDocumentSaysChanged() throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Files.writeString(ws.resolve("plan.md"), "# Tasks\nold\n");
        // A minute back, so the rewrite is newer even when both writes fall in the same millisecond.
        Files.setLastModifiedTime(ws.resolve("plan.md"), FileTime.fromMillis(System.currentTimeMillis() - 60_000));
        FakeHost host = new FakeHost(ws);
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nnew\n"));
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        assertPaired(lines(host));
        RunEvent.RunStep end = lines(host).stream()
                .filter(x -> "step_end".equals(x.phase()) && "write_plan".equals(x.node())).findFirst().orElseThrow();
        assertEquals("changed", end.documents().get(0).change());
    }

    @Test
    void aFailedChatStepClosesAsFailedAndTheRunEnds() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.stopReasons.add("error");
        host.replies.add("the backend refused");
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        RunEvent.RunStep end = l.stream().filter(x -> "step_end".equals(x.phase())).findFirst().orElseThrow();
        assertEquals("failed", end.status());
        assertTrue(end.error().contains("the backend refused"), end.error());
        assertEquals("the backend refused", end.output(), "a failed turn keeps its text as the output");
        assertEquals("step_failed", l.get(l.size() - 1).stopReason());
    }

    @Test
    void aStopClosesTheRunningStepAsStopped() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> h.signal.cancel());
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        assertPaired(lines(host));
        RunEvent.RunStep end = lines(host).stream().filter(x -> "step_end".equals(x.phase())).findFirst().orElseThrow();
        assertEquals("stopped", end.status());
        assertEquals("aborted", lines(host).get(lines(host).size() - 1).stopReason());
    }

    @Test
    void aRefusedRunOpensAndClosesWithoutSteps() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.nobodyToAsk = true;
        PlaybookRunnerTest.run(tmp, PlaybookRunnerTest.nested(2, 2), host);

        assertPaired(lines(host));
        assertEquals(List.of("run_start", "run_end"), shape(lines(host)));
        assertEquals("refused", lines(host).get(1).stopReason());
    }

    @Test
    void aHostThatThrowsDuringAChatStepClosesTheStepAsFailed() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> { throw new IllegalStateException("host broke"); });
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1", "run_end"), shape(l));
        RunEvent.RunStep end = l.get(2);
        assertEquals(RunSteps.FAILED, end.status());
        assertEquals("host broke", end.error());
        RunEvent.RunStep last = l.get(l.size() - 1);
        assertEquals(RunEvent.RunStep.RUN_END, last.phase());
        assertEquals(RunStop.STEP_FAILED, last.stopReason());
    }

    @Test
    void aStepWhoseModelDoesNotAnswerStillOpensAndCloses() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.rows.put("anthropic", new Probe("anthropic", "cloud", "failed", "https://api.anthropic.com", "refused",
                List.of(), false, 2L));
        host.answers.put("Retry or stop", "stop");
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1", "run_end"), shape(l));
        RunEvent.RunStep start = l.get(1);
        assertEquals("chat", start.performer());
        assertNull(start.provider(), "no model resolved, so the start names none");
        assertNull(start.model());
        RunEvent.RunStep end = l.get(2);
        assertEquals(RunSteps.FAILED, end.status());
        assertTrue(end.error().contains("anthropic claude-opus-5-5 does not answer"), end.error());
        assertEquals(RunStop.MODEL_UNAVAILABLE, l.get(3).stopReason());
    }

    @Test
    void aReviewDecisionNamesItsChild() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunnerTest.run(tmp, review("built", "write_plan"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:review#1", "step_end:review#1", "run_end"), shape(l));
        RunEvent.RunStep end = l.get(4);
        assertEquals(RunSteps.DONE, end.status());
        assertEquals("built", end.label());
        assertEquals(onlyChild(host), end.childId(), "the end names the reviewing child that ran");
        assertTrue(end.childId().startsWith("explore-"), end.childId());
        assertEquals("done", l.get(5).result());
    }

    @Test
    void aReviewThatNamesNoLabelClosesItsDecisionAsFailed() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunnerTest.run(tmp, review("approved", "write_plan"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:review#1", "step_end:review#1", "run_end"), shape(l));
        RunEvent.RunStep end = l.get(4);
        assertEquals(RunSteps.FAILED, end.status());
        assertNull(end.label());
        assertTrue(end.error().contains("named no label"), end.error());
        assertEquals(onlyChild(host), end.childId());
        assertEquals(RunStop.REVIEW_UNLABELLED, l.get(5).stopReason());
    }

    @Test
    void aStopDuringAReviewClosesTheDecisionAsStoppedAndNamesItsChild() throws IOException {
        // A Stop that lands while the review runs: the run's signal is already cancelled, so the reviewing
        // child ends at once and the runner sees the Stop when the check returns.
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.signal.cancel();
        PlaybookRunnerTest.run(tmp, review("built", "review"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:review#1", "step_end:review#1", "run_end"), shape(l));
        RunEvent.RunStep end = l.get(2);
        assertEquals("decision", end.kind());
        assertEquals(RunSteps.STOPPED, end.status());
        assertEquals(onlyChild(host), end.childId());
        assertEquals(childOutcome(host), end.output(), "a stopped decision keeps the detail its check gave");
        assertEquals(RunStop.ABORTED, l.get(3).stopReason());
    }

    @Test
    void aHostGuardThatThrowsDuringADecisionClosesItAsFailed() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host, line -> { throw new IllegalStateException("guard broke"); });

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:plan_ok#1", "step_end:plan_ok#1", "run_end"), shape(l));
        RunEvent.RunStep end = l.get(4);
        assertEquals(RunSteps.FAILED, end.status());
        assertEquals("guard broke", end.error());
        assertEquals(RunStop.STEP_FAILED, l.get(5).stopReason());
    }

    @Test
    void theRunsTaskAndAPickedModelReachTheirLines() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        PlaybookRunnerPicksTest.run(tmp, VocabularyTest.LOOP, host,
                Map.of("write_plan", new Playbook.ModelRef("ollama", "qwen3:8b")));

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals("add a CSV export", l.get(0).task());
        RunEvent.RunStep picked = l.get(1);
        assertEquals("step_start:write_plan#1", shape(List.of(picked)).get(0));
        assertEquals(Boolean.TRUE, picked.picked());
        assertEquals("ollama", picked.provider());
        assertEquals("qwen3:8b", picked.model());
        RunEvent.RunStep build = l.get(5);
        assertEquals("step_start:build#1", shape(List.of(build)).get(0));
        assertNull(build.picked(), "a step on the playbook's model leaves the flag off");
    }

    @Test
    void aStopDuringAnAgentStepKeepsTheAgentTheChildAndItsOutcome() throws IOException {
        // The agent file sits in the playbook folder the run pins; the run's signal is already cancelled,
        // so the child ends at once with an ERROR outcome and the runner sees the Stop when it returns.
        Path agents = Files.createDirectories(tmp.resolve("pb").resolve("agents"));
        Files.writeString(agents.resolve("reviewer.md"), AgentRoleTest.REVIEWER);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.signal.cancel();
        PlaybookRunnerTest.run(tmp, AgentRoleTest.AGENT_STEP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:review#1", "step_end:review#1", "run_end"), shape(l));
        assertEquals("reviewer", l.get(1).role(), "an agent step names the agent, not its role text");
        RunEvent.RunStep end = l.get(2);
        assertEquals(RunSteps.STOPPED, end.status());
        assertEquals(onlyChild(host), end.childId());
        assertTrue(childOutcome(host).startsWith("ERROR:"), childOutcome(host));
        assertEquals(childOutcome(host), end.output(), "a failed child's outcome is the step's output");
    }

    // Review I1: reads mirrors what the step prompt tells the step to read.

    @Test
    void aFirstStepReadsADocumentThatIsAlreadyInTheWorkspace() throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Files.writeString(ws.resolve("ticket.md"), "# Ticket\n");
        FakeHost host = new FakeHost(ws);
        PlaybookRunnerTest.run(tmp, readsPlaybook("ticket.md"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals("step_start:brainstorm#1", shape(List.of(l.get(1))).get(0));
        assertEquals(List.of(new RunEvent.RunDoc("ticket", "ticket.md", null)), l.get(1).reads());
    }

    @Test
    void aDocumentThatIsNotThereIsReadByItsIdAlone() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunnerTest.run(tmp, readsPlaybook("ticket.md"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals("step_start:brainstorm#1", shape(List.of(l.get(1))).get(0));
        assertEquals(List.of(new RunEvent.RunDoc("ticket", null, null)), l.get(1).reads());
    }

    @Test
    void aDocumentWrittenEarlierInTheRunIsReadWhereItWasWritten() throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Files.writeString(ws.resolve("ticket.md"), "# Ticket\n");
        Files.createDirectories(ws.resolve("docs"));
        FakeHost host = new FakeHost(ws);
        host.onChat.put("brainstorm", h -> PlaybookRunnerTest.write(h.workspace.resolve("docs/2026-spec.md"), "# Spec\n"));
        PlaybookRunnerTest.run(tmp, readsPlaybook("ticket.md"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of(new RunEvent.RunDoc("spec", "docs/2026-spec.md", "created")), l.get(2).documents());
        assertEquals("step_start:build#1", shape(List.of(l.get(3))).get(0));
        assertEquals(List.of(new RunEvent.RunDoc("spec", "docs/2026-spec.md", null),
                new RunEvent.RunDoc("ticket", "ticket.md", null)), l.get(3).reads(),
                "the spec is read where the first step wrote it, not at its pattern");
    }

    @Test
    void aDocumentOutsideTheWorkspaceIsReadByItsIdAlone() throws IOException {
        Files.writeString(tmp.resolve("ticket.md"), "# Ticket\n");
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunnerTest.run(tmp, readsPlaybook("../ticket.md"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertTrue(Files.isRegularFile(host.workspace.resolve("../ticket.md")), "positive: the file is there");
        assertEquals(List.of(new RunEvent.RunDoc("ticket", null, null)), l.get(1).reads(),
                "a path outside the workspace never reaches a line");
    }

    @Test
    void aDocumentUnderASymlinkedFolderThatLeadsOutsideIsReadByItsIdAlone() throws IOException {
        Path outside = Files.createDirectories(tmp.resolve("outside"));
        Files.writeString(outside.resolve("ticket.md"), "# Ticket\n");
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Files.createSymbolicLink(ws.resolve("linked"), outside);
        FakeHost host = new FakeHost(ws);
        PlaybookRunnerTest.run(tmp, readsPlaybook("linked/ticket.md"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertTrue(Files.isRegularFile(ws.resolve("linked/ticket.md")), "positive: the file is there through the link");
        assertEquals(List.of(new RunEvent.RunDoc("ticket", null, null)), l.get(1).reads(),
                "a folder inside the workspace that leads outside it gives no path to a line");
    }

    @Test
    void aLocationThatIsAFolderIsReadByItsIdAlone() throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Files.createDirectories(ws.resolve("tickets"));
        FakeHost host = new FakeHost(ws);
        PlaybookRunnerTest.run(tmp, readsPlaybook("tickets"), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertTrue(Files.isDirectory(ws.resolve("tickets")), "positive: the folder is there");
        assertEquals(List.of(new RunEvent.RunDoc("ticket", null, null)), l.get(1).reads(),
                "a folder is not a document a step reads");
    }

    // Review M2 and M9: every open entry and the run close, whatever throws.

    @Test
    void aPlanLineThatFailsAfterAStepEndedLeavesItOneEnd() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> h.failEmit = RunEvent.Plan.class::isInstance);
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1", "run_end"), shape(l));
        assertEquals(RunSteps.DONE, l.get(2).status(), "the step had ended when its plan line failed");
        assertEquals(RunStop.STEP_FAILED, l.get(3).stopReason());
    }

    @Test
    void aPlanLineThatFailsAfterADecisionEndedLeavesItOneEnd() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host, line -> {
            host.failEmit = RunEvent.Plan.class::isInstance;
            return Optional.empty();
        });

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:plan_ok#1", "step_end:plan_ok#1", "run_end"), shape(l));
        assertEquals(RunSteps.DONE, l.get(4).status(), "the decision had ended when its plan line failed");
        assertEquals("pass", l.get(4).label());
    }

    @Test
    void anErrorInAStepStillClosesItAndTheRun() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> { throw new HostError("host broke"); });
        assertThrows(HostError.class, () -> PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host));

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1", "run_end"), shape(l));
        assertEquals(RunSteps.FAILED, l.get(2).status());
        assertEquals("host broke", l.get(2).error());
        assertEquals(RunStop.STEP_FAILED, l.get(3).stopReason());
        assertEquals("host broke", l.get(3).detail());
    }

    @Test
    void anErrorInADecisionStillClosesItAndTheRun() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        assertThrows(HostError.class, () -> PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host,
                line -> { throw new HostError("guard broke"); }));

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:plan_ok#1", "step_end:plan_ok#1", "run_end"), shape(l));
        assertEquals(RunSteps.FAILED, l.get(4).status());
        assertEquals("guard broke", l.get(4).error());
        assertEquals(RunStop.STEP_FAILED, l.get(5).stopReason());
    }

    @Test
    void aHostThatThrowsInsideTheRefusalCheckStillOpensAndEndsTheRun() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.failKindOf = new IllegalStateException("kind broke");
        String json = privateBuild();
        IllegalStateException thrown = assertThrows(IllegalStateException.class,
                () -> PlaybookRunnerTest.run(tmp, json, host));
        assertEquals("kind broke", thrown.getMessage());

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "run_end"), shape(l));
        assertEquals(RunStop.STEP_FAILED, l.get(1).stopReason());
        assertEquals("kind broke", l.get(1).detail());
    }

    @Test
    void aPlanLineThatFailsBeforeTheFirstStepStillEndsTheRun() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.failEmit = RunEvent.Plan.class::isInstance;
        assertThrows(IllegalStateException.class, () -> PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host));

        assertPaired(lines(host));
        assertEquals(List.of("run_start", "run_end"), shape(lines(host)));
        assertEquals(RunStop.STEP_FAILED, lines(host).get(1).stopReason());
        assertEquals("emit broke", lines(host).get(1).detail());
    }

    @Test
    void aChatSwitchBackThatFailsStillEndsTheRun() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        host.failSwitchTo = "lmstudio";
        assertThrows(IllegalStateException.class, () -> PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host));

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:plan_ok#1", "step_end:plan_ok#1", "step_start:build#1", "step_end:build#1", "run_end"),
                shape(l));
        assertEquals(RunStop.DONE, l.get(7).stopReason(), "the graph had reached its end before the switch back");
        assertEquals("done", l.get(7).result());
    }

    @Test
    void anEndThatFailsStillLeavesOneRunEnd() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        host.failEmit = e -> e instanceof RunEvent.PlaybookProgress pp && RunEvent.PlaybookProgress.END.equals(pp.phase());
        assertThrows(IllegalStateException.class, () -> PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host));

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(1, l.stream().filter(x -> RunEvent.RunStep.RUN_END.equals(x.phase())).count());
        assertEquals(RunEvent.RunStep.RUN_END, l.get(l.size() - 1).phase());
        assertEquals(RunStop.DONE, l.get(l.size() - 1).stopReason());
    }

    // Review M4 and M5: the step a Stop or an unresolved model ends before its start.

    @Test
    void aStopWhileTheModelQuestionIsOpenClosesTheStepAsStopped() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.rows.put("anthropic", new Probe("anthropic", "cloud", "failed", "https://api.anthropic.com", "refused",
                List.of(), false, 2L));
        host.onAsk.put("Retry or stop", h -> h.signal.cancel());
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1", "run_end"), shape(l));
        assertEquals(RunSteps.STOPPED, l.get(2).status(), "the owner pressed Stop, the model did not fail");
    }

    @Test
    void aChatTurnTheHostAbortsClosesTheStepAsStopped() throws IOException {
        // The chat's own Stop ends the turn as aborted while the run's signal stays live.
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.stopReasons.add("aborted");
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1", "run_end"), shape(l));
        assertFalse(host.signal.isCancelled(), "positive: the run's signal was never cancelled");
        assertEquals(RunSteps.STOPPED, l.get(2).status());
        assertEquals(RunStop.ABORTED, l.get(3).stopReason());
    }

    @Test
    void anAgentStepWhoseModelDoesNotAnswerNamesTheAgentWithoutItsPrefix() throws IOException {
        Path agents = Files.createDirectories(tmp.resolve("pb").resolve("agents"));
        Files.writeString(agents.resolve("reviewer.md"), AgentRoleTest.REVIEWER);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.rows.put("ollama", new Probe("ollama", "local", "failed", "http://localhost:11434", "refused",
                List.of(), false, 2L));
        host.answers.put("Retry or stop", "stop");
        PlaybookRunnerTest.run(tmp, AgentRoleTest.AGENT_STEP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:review#1", "step_end:review#1", "run_end"), shape(l));
        assertNull(l.get(1).model(), "positive: the start went out without a model");
        assertEquals("reviewer", l.get(1).role());
    }

    // Review M10: every end of a decision names the round its start opened.

    @Test
    void aFailedDecisionWithACeilingKeepsItsRound() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.answerQueue.add("fail");
        PlaybookRunnerTest.run(tmp, PlaybookRunnerTest.nested(2, 2), host);

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        List<RunEvent.RunStep> ends = l.stream()
                .filter(x -> RunEvent.RunStep.STEP_END.equals(x.phase()) && "review".equals(x.node())).toList();
        assertEquals(2, ends.size(), shape(l).toString());
        RunEvent.RunStep end = ends.get(1);
        assertEquals(RunSteps.FAILED, end.status(), "nobody answered the second review");
        assertEquals(Integer.valueOf(2), end.round());
        assertEquals(Integer.valueOf(2), end.maxRounds());
        assertEquals(RunStop.UNANSWERED, l.get(l.size() - 1).stopReason());
    }

    @Test
    void aStoppedDecisionWithACeilingKeepsItsRoundAndItsDetail() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        AtomicInteger checks = new AtomicInteger();
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host, line -> {
            if (checks.incrementAndGet() == 2) {
                host.signal.cancel();
            }
            return Optional.empty();
        });

        List<RunEvent.RunStep> l = lines(host);
        assertPaired(l);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:plan_ok#1", "step_end:plan_ok#1", "step_start:write_plan#2", "step_end:write_plan#2",
                "step_start:plan_ok#2", "step_end:plan_ok#2", "run_end"), shape(l));
        RunEvent.RunStep end = l.get(8);
        assertEquals(RunSteps.STOPPED, end.status());
        assertEquals(Integer.valueOf(2), end.round());
        assertEquals(Integer.valueOf(2), end.maxRounds());
        assertTrue(end.output() != null && end.output().startsWith("not run"), String.valueOf(end.output()));
    }
}
