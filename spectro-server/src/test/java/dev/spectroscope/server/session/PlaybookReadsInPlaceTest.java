package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import dev.spectroscope.server.providers.ProviderRow;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 558, the run half of criterion 1 (card 554's note): the confirmation
 * and the run read what a step names from the playbook folder in place and
 * nowhere else. A skill only the user's folders hold is not taken; an agent
 * file in the folder runs without an install, and its bytes are in the start
 * hash the sheet shows and the start frame must repeat.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class PlaybookReadsInPlaceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String SKILL_STEP = """
        { "schema_version": 1, "id": "t", "name": "T", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "start": "write",
          "nodes": [
            { "kind": "step", "id": "write", "name": "Write", "performer": "chat", "model": "strong",
              "skills": ["house-rules"] },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [ { "from": "write", "to": "done" } ] }
        """;

    private static final String AGENT_STEP = """
        { "schema_version": 1, "id": "t", "name": "T", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "contents": { "agents": ["agents/reviewer.md"] },
          "start": "review",
          "nodes": [
            { "kind": "step", "id": "review", "name": "Review", "performer": "child", "role": "agent:reviewer",
              "model": "strong" },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [ { "from": "review", "to": "done" } ] }
        """;

    private static final String REVIEWER = """
        ---
        name: reviewer
        description: Reads the diff and returns pass or fail.
        type: explore
        ---
        You are the reviewer. Read the diff and never edit a file.
        """;

    @TempDir Path workspace;
    @TempDir Path playbookDir;

    private FakeSocket socket;
    private final List<String> sessions = new ArrayList<>();
    private final Path userSkill = Path.of(System.getProperty("user.home"), ".spectro", "skills", "house-rules");

    @AfterEach
    void clean() throws IOException {
        for (String id : sessions) {
            if (id != null) {
                Files.deleteIfExists(SessionStore.sessionFile(id));
            }
        }
        if (Files.exists(userSkill)) {
            try (Stream<Path> walk = Files.walk(userSkill)) {
                for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                    Files.delete(p);
                }
            }
        }
    }

    private SessionConnection session(String socketId) {
        socket = new FakeSocket(socketId, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())),
                null);
        connection.providerBuilderForTest(c -> says(c.model()));
        connection.providerCheckForTest(p -> new ProviderRow(p, "local", "reachable", false, null,
                "http://localhost:11434", List.of("qwen3:8b"), false, null, 1L));
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        sessions.add(connection.sessionId());
        return connection;
    }

    private static LlmProvider says(String model) {
        return new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
            }

            @Override
            public String modelName() {
                return model;
            }
        };
    }

    private Path registered(String json) throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), json);
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    /**
     * The nth playbook_confirm frame, waited for: card 584 sends it from a
     * virtual thread once every provider answered, not on the socket thread.
     */
    private JsonNode confirm(int nth) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (true) {
            List<JsonNode> found = new ArrayList<>();
            for (FakeSocket.Frame f : socket.frames()) {
                JsonNode n = JSON.readTree(f.payload());
                if ("playbook_confirm".equals(n.path("type").asText())) {
                    found.add(n);
                }
            }
            if (found.size() >= nth || System.nanoTime() > until) {
                assertThat(found).as("playbook_confirm frames").hasSizeGreaterThanOrEqualTo(nth);
                return found.get(nth - 1);
            }
            Thread.sleep(20);
        }
    }

    @Test
    void aStepSkillOnlyTheUsersFolderHoldsIsNotTakenAndTheStartIsRefused() throws Exception {
        Files.createDirectories(userSkill);
        Files.writeString(userSkill.resolve("SKILL.md"), "---\nname: house-rules\n---\nStage explicit paths.");
        Path dir = registered(SKILL_STEP);
        SessionConnection connection = session("ws-558-skill");

        connection.onConfirmPlaybook(dir.toString(), "add a CSV export");

        JsonNode preview = confirm(1).path("preview");
        assertThat(preview.path("skills").get(0).path("name").asText()).isEqualTo("house-rules");
        assertThat(preview.path("skills").get(0).path("source").asText())
                .as("the user's copy is not read for a run").isEqualTo("missing");
        assertThat(preview.path("refusals").toString()).contains("skill not found: house-rules");
    }

    @Test
    void anAgentFileInTheFolderRunsWithoutAnInstallAndItsBytesAreInTheStartHash() throws Exception {
        Path dir = registered(AGENT_STEP);
        Files.createDirectories(dir.resolve("agents"));
        Files.writeString(dir.resolve("agents/reviewer.md"), REVIEWER);
        SessionConnection connection = session("ws-558-agent");

        connection.onConfirmPlaybook(dir.toString(), "review the diff");
        JsonNode first = confirm(1).path("preview");

        assertThat(first.path("refusals")).as("nothing installed, nothing refused").isEmpty();

        Files.writeString(dir.resolve("agents/reviewer.md"), REVIEWER.replace("never edit", "edit"));
        connection.onConfirmPlaybook(dir.toString(), "review the diff");
        JsonNode second = confirm(2).path("preview");

        assertThat(second.path("hash").asText()).as("an edited preamble moves the start hash")
                .isNotEqualTo(first.path("hash").asText());
    }
}
