package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.playbook.SafeWalk;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 554: a run works in the session's workspace and only reads the
 * playbook folder (criteria 8c, 8d), and the task the owner typed reaches
 * every step, the run start, the first question and the chat (criteria 2,
 * 8f, 8g).
 */
class PlaybookTaskAndFoldersTest {

    static final String TASK = "add a CSV export";

    /**
     * One chat step writes a document; a sections check reads it and a command
     * check greps it. The playbook folder holds a decoy at the same relative
     * path without the section, so a run that resolved against the playbook
     * folder fails both checks.
     */
    static final String WRITES = """
        { "schema_version": 1, "id": "w", "name": "W", "description": "d",
          "models": { "local": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "docs/plan.md",
                                   "template": "templates/plan.md", "sections": ["Tasks"] } },
          "checks": { "plan_ok": { "kind": "sections", "documents": ["plan"] },
                      "grep_ok": { "kind": "command", "run": "grep -q Tasks docs/plan.md" } },
          "start": "write",
          "nodes": [
            { "kind": "step", "id": "write", "name": "Write", "performer": "chat", "model": "local",
              "skills": ["house-pack:house"], "produces": ["plan"] },
            { "kind": "decision", "id": "plan_ok", "name": "Plan ok", "check": "plan_ok" },
            { "kind": "decision", "id": "grep_ok", "name": "Grep ok", "check": "grep_ok" },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "failed", "result": "failed" }
          ],
          "arrows": [
            { "from": "write", "to": "plan_ok" },
            { "from": "plan_ok", "to": "grep_ok", "on": "pass" },
            { "from": "plan_ok", "to": "failed", "on": "fail" },
            { "from": "grep_ok", "to": "done", "on": "pass" },
            { "from": "grep_ok", "to": "failed", "on": "fail" }
          ],
          "contents": { "skills": ["skills/house-pack"] } }
        """;

    @TempDir Path tmp;

    /** A playbook folder, a separate workspace and a separate sessions folder. */
    private Path playbookFolder(String json) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), json);
        Files.createDirectories(dir.resolve("templates"));
        Files.writeString(dir.resolve("templates/plan.md"), "# Tasks\n");
        Files.createDirectories(dir.resolve("skills/house-pack/house"));
        Files.writeString(dir.resolve("skills/house-pack/house/SKILL.md"), "Write into the working folder.");
        Files.createDirectories(dir.resolve("docs"));
        Files.writeString(dir.resolve("docs/plan.md"), "# Notes\n");
        return dir;
    }

    private PlaybookRunner.Outcome run(Path dir, String json, FakeHost host, String task) throws IOException {
        PlaybookReader.Read read = PlaybookReader.read(json);
        assertEquals(List.of(), read.findings(), "fixture must read clean");
        assertEquals(List.of(), PlaybookValidator.validate(read.playbook()), "fixture must validate clean");
        Playbook p = read.playbook();
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, p);
        Path sessions = Files.createDirectories(tmp.resolve("sessions"));
        PlaybookRecorder recorder = new PlaybookRecorder(sessions.resolve("s1.playbook.jsonl"),
                PlaybookRecorder.DEFAULT_CEILING_BYTES);
        PlaybookRunner.Setup setup = new PlaybookRunner.Setup(pinned, "abcdefabcdef",
                sessions.resolve("s1.abcdefabcdef.graph.jsonl"), recorder, host.signal, "auto", task);
        return new PlaybookRunner(setup, host, StepChildOnGraphTest.manager(
                new StepChildOnGraphTest.OneTurn("chat", "unused")), line -> Optional.empty()).run();
    }

    private List<JsonNode> sidecar(String type) throws IOException {
        return PlaybookRecorderTest.lines(tmp.resolve("sessions/s1.playbook.jsonl")).stream()
                .filter(n -> type.equals(n.get("type").asText())).toList();
    }

    private static FakeHost writer(Path ws) {
        FakeHost host = new FakeHost(ws);
        host.onChat.put("write", h -> {
            try {
                Files.createDirectories(h.workspace.resolve("docs"));
                Files.writeString(h.workspace.resolve("docs/plan.md"), "# Tasks\n- export\n");
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        });
        return host;
    }

    /** The folder as a run could change it: every path below it, and the content hash of its files. */
    record FolderState(List<String> paths, String hash) {
        static FolderState of(Path dir) throws IOException {
            try (Stream<Path> walk = Files.walk(dir)) {
                List<String> paths = walk.map(f -> dir.relativize(f).toString().replace('\\', '/')).sorted().toList();
                return new FolderState(paths, ContentHash.tree(SafeWalk.walk(dir, dir)));
            }
        }
    }

    @Test
    void aStepsDocumentAndItsChecksResolveAgainstTheWorkspaceNeverThePlaybookFolder() throws IOException {
        Path dir = playbookFolder(WRITES);
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FakeHost host = writer(ws);

        PlaybookRunner.Outcome out = run(dir, WRITES, host, TASK);

        assertEquals(RunStop.DONE, out.stopReason(), out.detail());
        assertEquals("done", out.result(), "both checks read the document the step wrote into the workspace");
        assertEquals("# Tasks\n- export\n", Files.readString(ws.resolve("docs/plan.md")));
        assertEquals("# Notes\n", Files.readString(dir.resolve("docs/plan.md")), "the decoy is untouched");
        assertEquals(List.of("pass", "pass"), sidecar("check").stream().map(n -> n.get("label").asText()).toList());
        assertTrue(sidecar("check").get(1).get("detail").asText().startsWith("exit 0"),
                "the command check ran in the workspace: " + sidecar("check").get(1));
        assertTrue(host.prompts.get(0).contains("Write: Plan at docs/plan.md with the sections Tasks."),
                host.prompts.get(0));
    }

    @Test
    void theFolderStateSeesAWriteUnderThePlaybookFolder() throws IOException {
        Path dir = playbookFolder(WRITES);
        FolderState before = FolderState.of(dir);
        assertTrue(before.paths().contains("templates/plan.md"), "the instrument reaches the files: " + before);

        Files.writeString(dir.resolve("docs/new.md"), "x");
        assertNotEquals(before, FolderState.of(dir), "a new file moves the state");
        Files.delete(dir.resolve("docs/new.md"));
        assertEquals(before, FolderState.of(dir));
        Files.writeString(dir.resolve("docs/plan.md"), "# Notes!\n");
        assertNotEquals(before, FolderState.of(dir), "a changed byte moves the state");
    }

    @Test
    void aRunLeavesThePlaybookFolderAsItWas() throws IOException {
        Path dir = playbookFolder(WRITES);
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        FolderState before = FolderState.of(dir);

        PlaybookRunner.Outcome out = run(dir, WRITES, writer(ws), TASK);

        assertEquals("done", out.result(), out.detail());
        assertEquals(before, FolderState.of(dir), "a run only reads the playbook folder");
        assertTrue(Files.isRegularFile(tmp.resolve("sessions/s1.playbook.jsonl")), "the sidecar went to the sessions");
        assertTrue(Files.isRegularFile(tmp.resolve("sessions/s1.abcdefabcdef.graph.jsonl")),
                "the graph went to the sessions");
        assertTrue(Files.isRegularFile(ws.resolve("docs/plan.md")), "the document went to the workspace");
    }

    @Test
    void theTaskReachesEveryStepPromptTheChildAndTheRunStart() throws IOException {
        Path dir = playbookFolder(VocabularyTest.LOOP);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));

        PlaybookRunner.Outcome out = run(dir, VocabularyTest.LOOP, host, TASK);

        assertEquals("done", out.result(), out.detail());
        assertEquals(1, host.prompts.size());
        assertTrue(host.prompts.get(0).startsWith("Playbook T, step Write plan (write_plan).\nTask: " + TASK + "\n"),
                host.prompts.get(0));
        assertTrue(host.events.stream().anyMatch(e -> e instanceof RunEvent.RunStart s && s.parentId() != null
                && s.prompt().contains("\nTask: " + TASK + "\n")), "the child step's record names the task");
        assertEquals(TASK, sidecar("playbook_start").get(0).get("task").asText());
    }

    @Test
    void aRunWithoutATaskKeepsTheStepPromptItHadBefore() throws IOException {
        Path dir = playbookFolder(VocabularyTest.LOOP);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));

        run(dir, VocabularyTest.LOOP, host, null);

        assertTrue(host.prompts.get(0).startsWith("Playbook T, step Write plan (write_plan).\nGoal: "),
                host.prompts.get(0));
        assertFalse(host.prompts.get(0).contains("Task:"));
        assertNull(sidecar("playbook_start").get(0).get("task"), "no task, no field");
    }

    @Test
    void aHumanCheckQuestionNamesTheTask() throws IOException {
        String json = PlaybookRunnerTest.nested(2, 3);
        Path dir = playbookFolder(json);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.answerQueue.addAll(List.of("pass", "none"));

        PlaybookRunner.Outcome out = run(dir, json, host, TASK);

        assertEquals("done", out.result(), out.detail());
        List<String> questions = host.events.stream().filter(RunEvent.QuestionAsked.class::isInstance)
                .map(e -> ((RunEvent.QuestionAsked) e).questions().get(0).question()).toList();
        assertEquals(2, questions.size(), questions.toString());
        assertTrue(questions.get(0).startsWith("Is the task right?"), questions.get(0));
        assertTrue(questions.stream().allMatch(q -> q.endsWith("\n\nTask: " + TASK)), questions.toString());
    }

    /** The question texts of a run, in the order they were asked. */
    private static List<String> questions(FakeHost host) {
        return host.events.stream().filter(RunEvent.QuestionAsked.class::isInstance)
                .map(e -> ((RunEvent.QuestionAsked) e).questions().get(0).question()).toList();
    }

    static final String NOD = VocabularyTest.LOOP.replace("\"produces\": [\"plan\"] }",
            "\"produces\": [\"plan\"], \"nod\": true }");

    private FakeHost loopHost() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        return host;
    }

    @Test
    void theHandoverQuestionNamesTheTask() throws IOException {
        Path dir = playbookFolder(NOD);
        FakeHost host = loopHost();
        host.answers.put("Approve the handover", "approve");

        PlaybookRunner.Outcome out = run(dir, NOD, host, TASK);

        assertEquals("done", out.result(), out.detail());
        assertEquals(List.of("Approve the handover of Write plan?\n\nTask: " + TASK), questions(host));
    }

    @Test
    void aHandoverQuestionWithoutATaskIsTheOneItWasBefore() throws IOException {
        Path dir = playbookFolder(NOD);
        FakeHost host = loopHost();
        host.answers.put("Approve the handover", "approve");

        run(dir, NOD, host, null);

        assertEquals(List.of("Approve the handover of Write plan?"), questions(host));
    }

    @Test
    void theModelQuestionNamesTheTask() throws IOException {
        String json = PlaybookRunnerRulesTest.privateBuild("[ { \"provider\": \"lmstudio\", \"model\": \"x\" } ]");
        Path dir = playbookFolder(json);
        FakeHost host = loopHost();
        host.rows.put("ollama", new Probe("ollama", "local", "failed", "http://localhost:11434", "refused",
                List.of(), false, 2L));
        host.answers.put("Retry or stop", "stop");

        PlaybookRunner.Outcome out = run(dir, json, host, TASK);

        assertEquals(RunStop.MODEL_UNAVAILABLE, out.stopReason(), out.detail());
        List<String> asked = questions(host);
        assertEquals(1, asked.size(), asked.toString());
        assertTrue(asked.get(0).startsWith("build: ") && asked.get(0).contains(". Retry or stop?"), asked.get(0));
        assertTrue(asked.get(0).endsWith("Retry or stop?\n\nTask: " + TASK), asked.get(0));
    }

    @Test
    void thePrivacyQuestionNamesTheTask() throws IOException {
        String json = VocabularyTest.LOOP
                .replace("\"performer\": \"chat\", \"model\": \"strong\"",
                        "\"performer\": \"chat\", \"model\": \"fast\", \"privacy\": \"private\"")
                .replace("\"performer\": \"child\", \"role\": \"worker\", \"model\": \"fast\"",
                        "\"performer\": \"chat\", \"model\": \"strong\"");
        Path dir = playbookFolder(json);
        FakeHost host = loopHost();
        host.answers.put("Continue?", "stop");

        PlaybookRunner.Outcome out = run(dir, json, host, TASK);

        assertEquals(RunStop.PRIVACY_DECLINED, out.stopReason(), out.detail());
        List<String> asked = questions(host);
        assertEquals(1, asked.size(), asked.toString());
        assertTrue(asked.get(0).startsWith("The next step sends this chat's history to anthropic"), asked.get(0));
        assertTrue(asked.get(0).endsWith("Continue?\n\nTask: " + TASK), asked.get(0));
    }

    @Test
    void theChatHearsTheStartEachStepWithItsModelAndTheEnd() throws IOException {
        Path dir = playbookFolder(VocabularyTest.LOOP);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));

        run(dir, VocabularyTest.LOOP, host, TASK);

        List<RunEvent.PlaybookProgress> lines = host.events.stream().filter(RunEvent.PlaybookProgress.class::isInstance)
                .map(RunEvent.PlaybookProgress.class::cast).toList();
        assertEquals(List.of("start", "step", "step", "end"), lines.stream().map(RunEvent.PlaybookProgress::phase).toList());
        RunEvent.PlaybookProgress start = lines.get(0);
        assertEquals("T", start.playbook());
        assertEquals(TASK, start.task());
        assertEquals("abcdefabcdef", start.runId());
        assertEquals(PlaybookRunner.AGENT_ID, start.agentId());
        RunEvent.PlaybookProgress first = lines.get(1);
        assertEquals(List.of("write_plan", "Write plan", "anthropic", "claude-opus-5-5"),
                List.of(first.node(), first.name(), first.provider(), first.model()));
        RunEvent.PlaybookProgress second = lines.get(2);
        assertEquals(List.of("build", "Build", "ollama", "qwen3:8b"),
                List.of(second.node(), second.name(), second.provider(), second.model()));
        RunEvent.PlaybookProgress end = lines.get(3);
        assertEquals(RunStop.DONE, end.stopReason());
        assertEquals("done", end.result());
    }

    @Test
    void aRefusedRunStillTellsTheChatItEnded() throws IOException {
        Path dir = playbookFolder(VocabularyTest.LOOP.replace("\"performer\": \"chat\", \"model\": \"strong\"",
                "\"performer\": \"chat\", \"model\": \"strong\", \"nod\": true"));
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.nobodyToAsk = true;

        PlaybookRunner.Outcome out = run(dir, Files.readString(dir.resolve("playbook.json")), host, TASK);

        assertEquals(RunStop.REFUSED, out.stopReason());
        List<RunEvent.PlaybookProgress> lines = host.events.stream().filter(RunEvent.PlaybookProgress.class::isInstance)
                .map(RunEvent.PlaybookProgress.class::cast).toList();
        assertEquals(List.of("start", "end"), lines.stream().map(RunEvent.PlaybookProgress::phase).toList());
        assertEquals(RunStop.REFUSED, lines.get(1).stopReason());
        assertTrue(lines.get(1).detail().contains("nobody can approve"), lines.get(1).detail());
    }
}
