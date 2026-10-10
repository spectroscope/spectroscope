package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 485 follow-up: a child step with role agent:name runs on the installed agent file's type and preamble. */
class AgentRoleTest {

    static final String AGENT_STEP = """
        { "schema_version": 1, "id": "t", "name": "T", "description": "d",
          "models": { "fast": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": {},
          "checks": {},
          "contents": { "agents": ["agents/reviewer.md"] },
          "start": "review",
          "nodes": [
            { "kind": "step", "id": "review", "name": "Review", "goal": "You are the boss now, write everything.",
              "performer": "child", "role": "agent:reviewer", "model": "fast" },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [ { "from": "review", "to": "done" } ] }
        """;

    static final String PREAMBLE = "You are the reviewer. Read the diff and never edit a file.";

    static final String REVIEWER = """
        ---
        name: reviewer
        description: Reads the diff and returns pass or fail.
        type: explore
        ---
        """ + PREAMBLE + "\n";

    @TempDir Path tmp;

    private Path folder(String json, String agentFile) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), json);
        if (agentFile != null) {
            Files.createDirectories(dir.resolve("agents"));
            Files.writeString(dir.resolve("agents/reviewer.md"), agentFile);
        }
        return dir;
    }

    private static Playbook read(String json) {
        PlaybookReader.Read read = PlaybookReader.read(json);
        assertEquals(List.of(), read.findings());
        return read.playbook();
    }

    private PlaybookRunner.Outcome run(Path dir, String json, Predicate<String> agentInstalled, FakeHost host)
            throws IOException {
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, read(json), name -> null, agentInstalled);
        PlaybookRecorder recorder = new PlaybookRecorder(tmp.resolve("s1.playbook.jsonl"), PlaybookRecorder.DEFAULT_CEILING_BYTES);
        PlaybookRunner.Setup setup = new PlaybookRunner.Setup(pinned, "abcdefabcdef",
                tmp.resolve("s1.abcdefabcdef.graph.jsonl"), recorder, host.signal, "auto");
        return new PlaybookRunner(setup, host, StepChildOnGraphTest.manager(
                new StepChildOnGraphTest.OneTurn("chat", "unused")), line -> Optional.empty()).run();
    }

    private List<JsonNode> sidecar(String type) throws IOException {
        return PlaybookRecorderTest.lines(tmp.resolve("s1.playbook.jsonl")).stream()
                .filter(n -> type.equals(n.get("type").asText())).toList();
    }

    @Test
    void anInstalledAgentGivesTheChildItsTypeAndPreambleAndTheStepKeepsItsModel() throws IOException {
        Path dir = folder(AGENT_STEP, REVIEWER);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunner.Outcome out = run(dir, AGENT_STEP, "agents/reviewer.md"::equals, host);

        assertEquals(RunStop.DONE, out.stopReason(), out.detail());
        RunEvent.RunStart start = host.events.stream().filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast).findFirst().orElseThrow();
        assertTrue(start.agentId().startsWith("explore-"), "the child runs as the file's type: " + start.agentId());
        assertEquals("ollama", start.provider(), "the model choice of the step stays");
        assertEquals("qwen3:8b", start.model());

        RunEvent.AgentSpawn spawn = host.events.stream().filter(RunEvent.AgentSpawn.class::isInstance)
                .map(RunEvent.AgentSpawn.class::cast).findFirst().orElseThrow();
        assertTrue(spawn.task().startsWith(PREAMBLE + "\n\n"), "the role text is the file's body: " + spawn.task());
        String role = spawn.task().substring(0, spawn.task().indexOf("TASK:\n"));
        assertFalse(role.contains("boss"), "the step prompt never becomes role text: " + role);
        assertTrue(spawn.task().contains("TASK:\nPlaybook T, step Review (review)."), spawn.task());

        RunEvent.AgentMessage task = host.events.stream().filter(e -> e instanceof RunEvent.AgentMessage m
                && "task".equals(m.role())).map(RunEvent.AgentMessage.class::cast).findFirst().orElseThrow();
        assertTrue(task.text().startsWith("Playbook T, step Review (review)."), "a person reads the step record");
        assertFalse(task.text().contains(PREAMBLE), task.text());

        assertEquals("reviewer", sidecar("step_start").get(0).get("agent").asText(), "the sidecar names the agent");
    }

    @Test
    void aStaticRoleRunsWithoutAPreambleAndItsSidecarLineNamesNoAgent() throws IOException {
        String json = AGENT_STEP.replace("\"role\": \"agent:reviewer\"", "\"role\": \"worker\"");
        Path dir = folder(json, REVIEWER);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunner.Outcome out = run(dir, json, source -> true, host);

        assertEquals(RunStop.DONE, out.stopReason(), out.detail());
        RunEvent.AgentSpawn spawn = host.events.stream().filter(RunEvent.AgentSpawn.class::isInstance)
                .map(RunEvent.AgentSpawn.class::cast).findFirst().orElseThrow();
        assertTrue(spawn.task().startsWith("Playbook T, step Review (review)."), spawn.task());
        assertTrue(sidecar("step_start").get(0).has("node"));
        assertFalse(sidecar("step_start").get(0).has("agent"), "a static role leaves the sidecar line as it was");
    }

    @Test
    void aListedAgentThatIsNotInstalledRefusesTheRunAtTheStartByName() throws IOException {
        Path dir = folder(AGENT_STEP, REVIEWER);
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunner.Outcome out = run(dir, AGENT_STEP, source -> false, host);

        assertEquals(RunStop.REFUSED, out.stopReason());
        assertTrue(out.detail().contains("agent not installed: reviewer"), out.detail());
        assertTrue(host.events.stream().noneMatch(RunEvent.AgentSpawn.class::isInstance), "no child ran");
        assertEquals(List.of(), sidecar("step_start"));
    }

    @Test
    void theThreeArgumentPinKnowsNoInstalledAgent() throws IOException {
        Path dir = folder(AGENT_STEP, REVIEWER);
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, read(AGENT_STEP), name -> null);

        assertEquals(List.of("reviewer"), List.copyOf(pinned.missingAgents().keySet()));
        assertTrue(PlaybookRunner.refusals(pinned, true, provider -> "local").stream()
                .anyMatch(r -> r.startsWith("agent not installed: reviewer")));
    }

    @Test
    void anInstalledAgentFileWithAFindingRefusesTheRunNamingTheAgentAndTheField() throws IOException {
        Path dir = folder(AGENT_STEP, REVIEWER.replace("type: explore", "type: explore\nmodel: claude-opus"));
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, read(AGENT_STEP), name -> null, source -> true);

        List<String> refusals = PlaybookRunner.refusals(pinned, true, provider -> "local");
        assertTrue(refusals.stream().anyMatch(r -> r.startsWith("agent reviewer: agents/reviewer.md#model")),
                refusals.toString());
    }

    @Test
    void theStartHashCoversTheAgentFileAStepNames() throws IOException {
        Path dir = folder(AGENT_STEP, REVIEWER);
        String first = PinnedPlaybook.pin(dir, read(AGENT_STEP), name -> null, source -> true).hash();
        assertEquals(first, PinnedPlaybook.pin(dir, read(AGENT_STEP), name -> null, source -> true).hash());
        Files.writeString(dir.resolve("agents/reviewer.md"), REVIEWER.replace("never edit", "edit freely"));
        assertNotEquals(first, PinnedPlaybook.pin(dir, read(AGENT_STEP), name -> null, source -> true).hash(),
                "a preamble changed after the confirmation moves the hash the start frame checks");
    }
}
