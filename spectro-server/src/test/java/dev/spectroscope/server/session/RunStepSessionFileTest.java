package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import dev.spectroscope.server.providers.ProviderRow;
import dev.spectroscope.server.workspace.WorkspaceController;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * Card 586: a playbook run started through the socket writes its
 * {@code run_step} lines into the session's own file, through the run's drain
 * and in the order the runner emitted them, and a document the run wrote
 * opens through {@code GET /api/run-document} on that record. Modelled on
 * {@code PlaybookConfirmFrameTest}, which proves the same file holds
 * {@code playbook_progress}.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class RunStepSessionFileTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TASK = "add a CSV export";
    private static final String PLAN = "## Tasks\n- export\n";

    /** A chat step that writes docs/plan.md through the session's file tool, then two checks that read it. */
    private static final String WRITES_A_PLAN = """
        { "schema_version": 1, "id": "w", "name": "W", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "docs/plan.md", "sections": ["Tasks"] } },
          "checks": { "plan_ok": { "kind": "sections", "documents": ["plan"] },
                      "grep_ok": { "kind": "command", "run": "grep -q Tasks docs/plan.md" } },
          "start": "write_plan",
          "nodes": [
            { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "strong", "produces": ["plan"] },
            { "kind": "decision", "id": "plan_ok", "name": "Plan ok", "check": "plan_ok" },
            { "kind": "decision", "id": "grep_ok", "name": "Grep ok", "check": "grep_ok" },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "failed", "result": "failed" }
          ],
          "arrows": [
            { "from": "write_plan", "to": "plan_ok" },
            { "from": "plan_ok", "to": "grep_ok", "on": "pass" },
            { "from": "plan_ok", "to": "failed", "on": "fail" },
            { "from": "grep_ok", "to": "done", "on": "pass" },
            { "from": "grep_ok", "to": "failed", "on": "fail" }
          ] }
        """;

    @TempDir Path workspace;
    @TempDir Path playbookDir;

    private FakeSocket socket;
    private final List<String> sessions = new ArrayList<>();

    @AfterEach
    void dropTheSessionFiles() throws IOException {
        for (String id : sessions) {
            if (id != null) {
                Files.deleteIfExists(SessionStore.sessionFile(id));
            }
        }
    }

    /** Writes docs/plan.md through write_file on the first request of a turn, then ends the turn. */
    private static LlmProvider writer(String model) {
        return new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (request.messages().size() == 1) {
                    return List.of(new PToolCall("w1", "write_file", JSON.createObjectNode()
                                    .put("path", "docs/plan.md").put("content", PLAN)),
                            new PStop(PStop.StopReason.TOOL_USE));
                }
                return List.of(new PTextDelta("written"), new PUsage(2, 1), new PStop(PStop.StopReason.END_TURN));
            }

            @Override
            public String modelName() {
                return model;
            }
        };
    }

    private SessionConnection session(String socketId) {
        socket = new FakeSocket(socketId, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())),
                null);
        connection.providerBuilderForTest(c -> writer(c.model()));
        connection.providerCheckForTest(p -> new ProviderRow(p, "local", "reachable", false, null,
                "http://localhost:11434", List.of("qwen3:8b"), false, null, 1L));
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        sessions.add(connection.sessionId());
        return connection;
    }

    private Path registered() throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), WRITES_A_PLAN);
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    private static String hash(Path dir) throws IOException {
        return PinnedPlaybook.pin(dir, PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).playbook()).hash();
    }

    private List<String> errors() throws IOException {
        List<String> out = new ArrayList<>();
        for (FakeSocket.Frame f : socket.frames()) {
            JsonNode n = JSON.readTree(f.payload());
            if ("error".equals(n.path("type").asText())) {
                out.add(n.path("message").asText());
            }
        }
        return out;
    }

    /** The run_step lines of the session's file, read the way every reader of the file reads it. */
    private static List<RunEvent.RunStep> runSteps(String sessionId) throws IOException {
        if (!Files.exists(SessionStore.sessionFile(sessionId))) {
            return List.of();
        }
        List<RunEvent.RunStep> out = new ArrayList<>();
        for (RunEvent event : SessionStore.readSessionEvents(sessionId)) {
            if (event instanceof RunEvent.RunStep step) {
                out.add(step);
            }
        }
        return out;
    }

    /**
     * Starts the playbook and waits for the run's run_end line in the session's
     * file. The sidecar's playbook_end is written before run_end leaves the
     * runner's finally, so waiting on the sidecar would read the file too early.
     */
    private List<RunEvent.RunStep> runToTheEnd(SessionConnection connection) throws Exception {
        Path dir = registered();
        connection.onSetPermissionMode("auto");
        connection.onStartPlaybook(dir.toString(), hash(dir), TASK);
        String id = connection.sessionId();
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        List<RunEvent.RunStep> lines = runSteps(id);
        while (System.nanoTime() < until
                && (lines.isEmpty() || !RunEvent.RunStep.RUN_END.equals(lines.getLast().phase()))) {
            Thread.sleep(50);
            lines = runSteps(id);
        }
        assertThat(errors()).isEmpty();
        return lines;
    }

    private static RunEvent.RunStep endOf(List<RunEvent.RunStep> lines, String node) {
        return lines.stream()
                .filter(s -> RunEvent.RunStep.STEP_END.equals(s.phase()) && node.equals(s.node()))
                .findFirst().orElseThrow(() -> new AssertionError("no step_end of " + node + " in " + lines));
    }

    @Test
    void aPlaybookRunWritesItsRunStepLinesIntoTheSessionFileInOrder() throws Exception {
        SessionConnection connection = session("ws-586-lines");

        List<RunEvent.RunStep> lines = runToTheEnd(connection);

        assertThat(lines).extracting(s -> s.node() == null ? s.phase() : s.phase() + ":" + s.node())
                .containsExactly("run_start",
                        "step_start:write_plan", "step_end:write_plan",
                        "step_start:plan_ok", "step_end:plan_ok",
                        "step_start:grep_ok", "step_end:grep_ok",
                        "run_end");
        assertThat(lines).extracting(RunEvent.RunStep::agentId).containsOnly("playbook");
        assertThat(lines.getFirst().runId()).matches("[0-9a-f]{12}");
        assertThat(lines).extracting(RunEvent.RunStep::runId).containsOnly(lines.getFirst().runId());
        assertThat(lines.getFirst().task()).isEqualTo(TASK);
        assertThat(lines.getFirst().workspaceFingerprint())
                .as("the run_start binds the run to the real path of the session's folder")
                .isEqualTo(RunEvent.RunStep.fingerprintOf(workspace.toRealPath()));
        assertThat(lines.getLast().stopReason()).isEqualTo("done");
        assertThat(endOf(lines, "write_plan").documents())
                .containsExactly(new RunEvent.RunDoc("plan", "docs/plan.md", "created"));
    }

    @Test
    void aDocumentTheRunWroteOpensThroughTheRunDocumentRoute() throws Exception {
        SessionConnection connection = session("ws-586-open");

        List<RunEvent.RunStep> lines = runToTheEnd(connection);
        String run = lines.getFirst().runId();
        String path = endOf(lines, "write_plan").documents().getFirst().path();

        MockHttpServletResponse res = MockMvcBuilders.standaloneSetup(new WorkspaceController()).build()
                .perform(get("http://localhost/api/run-document")
                        .param("session", connection.sessionId())
                        .param("run", run)
                        .param("path", path))
                .andReturn().getResponse();

        assertThat(res.getStatus()).isEqualTo(200);
        assertThat(res.getContentAsString(StandardCharsets.UTF_8)).isEqualTo(PLAN);
    }
}
