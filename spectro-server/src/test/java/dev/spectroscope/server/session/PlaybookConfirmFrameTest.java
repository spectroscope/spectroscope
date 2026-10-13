package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.SafeWalk;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.playbook.run.PlaybookRecorder;
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
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 554: {@code /run-with-playbook <prompt>} on a real
 * {@link SessionConnection}. {@code confirm_playbook} resolves the session's
 * playbook (the frame's folder, else the session's pick, else the folder
 * pinned for the workspace) and answers {@code playbook_confirm} for the sheet;
 * {@code start_playbook} carries the prompt as the run's task. The run works in
 * the workspace and leaves the playbook folder as it was.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class PlaybookConfirmFrameTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TASK = "add a CSV export";

    /** One chat step that writes a document, then a command check in the workspace. */
    private static final String ONE_STEP = """
        { "schema_version": 1, "id": "t", "name": "T", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "plan.md", "sections": ["Tasks"] } },
          "checks": { "plan_ok": { "kind": "command", "run": "test -f plan.md" } },
          "start": "write_plan",
          "nodes": [
            { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "strong", "produces": ["plan"] },
            { "kind": "decision", "id": "plan_ok", "name": "Plan ok", "check": "plan_ok" },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "failed", "result": "failed" }
          ],
          "arrows": [
            { "from": "write_plan", "to": "plan_ok" },
            { "from": "plan_ok", "to": "done", "on": "pass" },
            { "from": "plan_ok", "to": "failed", "on": "fail" }
          ] }
        """;

    @TempDir Path workspace;
    @TempDir Path playbookDir;

    private FakeSocket socket;
    private final List<String> sessions = new ArrayList<>();

    @AfterEach
    void unpin() throws IOException {
        for (String id : sessions) {
            if (id != null) {
                Files.deleteIfExists(SessionStore.sessionFile(id));
            }
        }
    }

    private static LlmProvider says(String model, String text) {
        return new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                return List.of(new PTextDelta(text), new PUsage(2, 1), new PStop(PStop.StopReason.END_TURN));
            }

            @Override
            public String modelName() {
                return model;
            }
        };
    }

    private SessionConnection session(String socketId) {
        return session(socketId, c -> says(c.model(), "ok"));
    }

    private SessionConnection session(String socketId,
                                      java.util.function.Function<SpectroConfig, LlmProvider> providers) {
        socket = new FakeSocket(socketId, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())),
                null);
        connection.providerBuilderForTest(providers);
        connection.providerCheckForTest(p -> new ProviderRow(p, "local", "reachable", false, null,
                "http://localhost:11434", List.of("qwen3:8b"), false, null, 1L));
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        sessions.add(connection.sessionId());
        return connection;
    }

    private Path registered(String json) throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), json);
        Files.writeString(playbookDir.resolve("plan.md"), "## Notes\n"); // a decoy beside the playbook
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    private List<JsonNode> frames(String type) throws IOException {
        List<JsonNode> out = new ArrayList<>();
        for (FakeSocket.Frame f : socket.frames()) {
            JsonNode n = JSON.readTree(f.payload());
            if (type.equals(n.path("type").asText())) {
                out.add(n);
            }
        }
        return out;
    }

    /**
     * The first playbook_confirm frame, waited for: card 584 sends it from a
     * virtual thread once every provider answered, not on the socket thread.
     */
    private JsonNode awaitConfirm() throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (frames("playbook_confirm").isEmpty() && System.nanoTime() < until) {
            Thread.sleep(20);
        }
        assertThat(frames("playbook_confirm")).as("a playbook_confirm frame").isNotEmpty();
        return frames("playbook_confirm").getFirst();
    }

    private List<String> errors() throws IOException {
        return frames("error").stream().map(f -> f.path("message").asText()).toList();
    }

    private static String hash(Path dir) throws IOException {
        return PinnedPlaybook.pin(dir, PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).playbook()).hash();
    }

    @Test
    void theFramesFolderIsConfirmedWithItsPreviewAndThePrompt() throws Exception {
        Path dir = registered(ONE_STEP);
        SessionConnection connection = session("ws-554-confirm");

        connection.onConfirmPlaybook(dir.toString(), "  " + TASK + "  ");

        assertThat(errors()).isEmpty();
        JsonNode confirm = awaitConfirm();
        assertThat(confirm.path("dir").asText()).isEqualTo(dir.toString());
        assertThat(confirm.path("prompt").asText()).isEqualTo(TASK);
        assertThat(confirm.path("preview").path("hash").asText()).isEqualTo(hash(dir));
        assertThat(confirm.path("preview").path("commands").get(0).asText()).isEqualTo("test -f plan.md");
        assertThat(confirm.path("preview").path("steps").get(0).path("id").asText()).isEqualTo("write_plan");
        assertThat(confirm.path("preview").path("refusals")).isEmpty();
        assertThat(errors()).as("a playbook without findings adds no line").isEmpty();
    }

    @Test
    void withoutAFolderInTheFrameTheSessionsPickIsConfirmed() throws Exception {
        Path dir = registered(ONE_STEP);
        SessionConnection connection = session("ws-554-picked");
        connection.onSetPlaybook(dir.toString());

        connection.onConfirmPlaybook(null, TASK);

        assertThat(errors()).isEmpty();
        assertThat(awaitConfirm().path("dir").asText()).isEqualTo(dir.toString());
    }

    @Test
    void withoutAPickTheFolderPinnedForTheWorkspaceIsConfirmed() throws Exception {
        Path dir = registered(ONE_STEP);
        PlaybookFolders.inHome().pin(workspace, dir);
        SessionConnection connection = session("ws-554-pinned");

        connection.onConfirmPlaybook(null, TASK);

        assertThat(errors()).isEmpty();
        assertThat(awaitConfirm().path("dir").asText()).isEqualTo(dir.toString());
        assertThat(connection.playbookDir()).as("a confirm is no pick").isNull();
    }

    @Test
    void withNothingPickedOrPinnedTheConfirmIsRefusedWithHowToPickOne() throws IOException {
        SessionConnection connection = session("ws-554-none");

        connection.onConfirmPlaybook(null, TASK);

        assertThat(errors()).containsExactly(SessionConnection.NO_PLAYBOOK);
        assertThat(SessionConnection.NO_PLAYBOOK).isEqualTo("No playbook is picked for this session: pick one in"
                + " the header dropdown or pin one in the Playbook view.");
        assertThat(frames("playbook_confirm")).isEmpty();
    }

    /**
     * Card 554, integrator decision b: "No playbook" picked in the dropdown
     * does not fall back to the folder pinned for the workspace.
     */
    @Test
    void anExplicitNoneIsRefusedAlthoughAFolderIsPinnedForTheWorkspace() throws IOException {
        Path dir = registered(ONE_STEP);
        PlaybookFolders.inHome().pin(workspace, dir);
        SessionConnection connection = session("ws-554-explicit-none");
        connection.onSetPlaybook(null, true);

        connection.onConfirmPlaybook(null, TASK);
        connection.onStartPlaybook("", hash(dir), TASK);
        connection.onStartWorkflowByName(null, "ask", "x", "en");

        // Coordinator follow-up: the explicit none has a refusal of its own,
        // apart from the one for a session that picked nothing.
        String none = "This session is set to no playbook: pick one in the header dropdown.";
        assertThat(errors()).containsExactly(none, none, none);
        assertThat(none).isNotEqualTo(SessionConnection.NO_PLAYBOOK);
        assertThat(frames("playbook_confirm")).isEmpty();
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).as("nothing ran").doesNotExist();
    }

    @Test
    void anEmptyPromptIsRefusedWithTheUsageLine() throws IOException {
        Path dir = registered(ONE_STEP);
        SessionConnection connection = session("ws-554-empty");

        connection.onConfirmPlaybook(dir.toString(), "   ");
        connection.onStartPlaybook(dir.toString(), hash(dir), "");

        assertThat(errors()).containsExactly(SessionConnection.RUN_WITH_PLAYBOOK_USAGE,
                SessionConnection.RUN_WITH_PLAYBOOK_USAGE);
        assertThat(SessionConnection.RUN_WITH_PLAYBOOK_USAGE).startsWith("Usage: /run-with-playbook <prompt>");
        assertThat(frames("playbook_confirm")).isEmpty();
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).as("nothing ran").doesNotExist();
    }

    @Test
    void aPickedFolderThatIsGoneIsRefusedAndNothingElseRuns() throws IOException {
        Path dir = registered(ONE_STEP);
        PlaybookFolders.inHome().pin(workspace, dir); // a pin that must not stand in for the gone pick
        String id = "20261012-220000-w554gone";
        Path gone = workspace.resolveSibling(workspace.getFileName() + "-gone-playbook");
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id), """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"ALPHA","ts":1}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":2}
                {"type":"playbook_picked","dir":%s,"name":"Old","ts":3}
                """.formatted(JSON.writeValueAsString(gone.toString())));
        sessions.add(id);
        socket = new FakeSocket("ws-554-gone", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())), null);
        connection.start();
        connection.onWakeSession(id);

        connection.onConfirmPlaybook(null, TASK);
        connection.onStartPlaybook("", hash(dir), TASK);

        assertThat(errors()).containsExactly(SessionConnection.PICKED_PLAYBOOK_GONE,
                SessionConnection.PICKED_PLAYBOOK_GONE);
        assertThat(SessionConnection.PICKED_PLAYBOOK_GONE).isEqualTo("The picked playbook folder was not found.");
        assertThat(frames("playbook_confirm")).isEmpty();
    }

    @Test
    void aDocumentThatLeavesTheWorkspaceIsRefusedAtLoad() throws IOException {
        Path dir = registered(ONE_STEP.replace("\"location\": \"plan.md\"", "\"location\": \"../plan.md\""));
        SessionConnection connection = session("ws-554-escape");

        connection.onConfirmPlaybook(dir.toString(), TASK);
        assertThat(errors()).as("criterion 7: a finding at the confirm is a line in the chat, not only in the sheet")
                .singleElement().asString().startsWith("The playbook does not load").contains("leaves the workspace");
        connection.onStartPlaybook(dir.toString(), hash(dir), TASK);

        JsonNode preview = frames("playbook_confirm").getFirst().path("preview");
        assertThat(preview.path("refusals").toString()).contains("leaves the workspace");
        assertThat(preview.path("hash").isNull()).as("a playbook with findings offers no hash to start on").isTrue();
        assertThat(errors()).hasSize(2).allSatisfy(e -> assertThat(e).startsWith("The playbook does not load")
                .contains("leaves the workspace"));
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).doesNotExist();
    }

    /** The folder as a run could change it: every path below it, and the content hash of its files. */
    private static String folderState(Path dir) throws IOException {
        try (Stream<Path> walk = Files.walk(dir)) {
            return walk.map(f -> dir.relativize(f).toString()).sorted().toList() + " "
                    + ContentHash.tree(SafeWalk.walk(dir, dir));
        }
    }

    @Test
    void theStartRunsTheTaskInTheWorkspaceRecordsThePickAndLeavesThePlaybookFolderAsItWas() throws Exception {
        Path dir = registered(ONE_STEP);
        Files.writeString(workspace.resolve("plan.md"), "## Tasks\n- one\n");
        String before = folderState(dir);
        SessionConnection connection = session("ws-554-run");
        connection.onSetPermissionMode("auto");

        connection.onStartPlaybook(dir.toString(), hash(dir), TASK);

        String id = connection.sessionId();
        Path sidecar = PlaybookRecorder.fileFor(id);
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < until
                && !(Files.exists(sidecar) && Files.readString(sidecar).contains("\"playbook_end\""))) {
            Thread.sleep(50);
        }
        assertThat(errors()).isEmpty();
        String lines = Files.readString(sidecar);
        assertThat(lines).contains("\"stopReason\":\"done\"").contains("\"task\":\"" + TASK + "\"");

        String record = Files.readString(SessionStore.sessionFile(id));
        assertThat(record).as("the chat hears the start with the task (8f)")
                .contains("\"type\":\"playbook_progress\"").contains("\"phase\":\"start\"")
                .contains("\"task\":\"" + TASK + "\"").contains("\"phase\":\"end\"");
        assertThat(record).as("the step turn is the playbook's and names the task")
                .contains("\"origin\":\"playbook\"").contains("Task: " + TASK);
        assertThat(connection.playbookDir()).as("a start is a pick").isEqualTo(dir.toString());
        assertThat(SessionStore.recordedPlaybook(id)).isEqualTo(dir.toString());

        assertThat(folderState(dir)).as("a run only reads the playbook folder (8d)").isEqualTo(before);
        assertThat(sidecar.getParent()).isEqualTo(PlaybookRecorder.folder());
        try (Stream<Path> graphs = Files.list(PlaybookRecorder.folder())) {
            assertThat(graphs.map(p -> p.getFileName().toString())
                    .filter(n -> n.startsWith(id) && n.endsWith(".graph.jsonl")).toList())
                    .as("the graph went to the sessions' sidecar folder").hasSize(1);
        }
        assertThat(sidecar.startsWith(dir)).isFalse();
        assertThat(Files.readString(dir.resolve("plan.md"))).isEqualTo("## Notes\n");
    }

    /** A step that writes its document through the session's own file tool, then two checks that read it. */
    private static final String WRITES_THROUGH_THE_HOST = """
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

    /** Writes docs/plan.md through write_file on the first request of a turn, then ends the turn. */
    private static LlmProvider writer(String model) {
        return new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (request.messages().size() == 1) {
                    return List.of(new PToolCall("w1", "write_file", JSON.createObjectNode()
                            .put("path", "docs/plan.md").put("content", "## Tasks\n- export\n")),
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

    /**
     * Card 554 fix round 1, criterion 8c at the server: the document exists
     * only in the workspace, the step writes it through the session's own file
     * tool, and both checks pass only when they read the workspace. A host
     * built on another folder ends the run "failed".
     */
    @Test
    void aStepWritesItsDocumentIntoTheWorkspaceAndTheChecksReadItThere() throws Exception {
        Path dir = registered(WRITES_THROUGH_THE_HOST);
        Files.delete(dir.resolve("plan.md"));
        SessionConnection connection = session("ws-554-8c", c -> writer(c.model()));
        connection.onSetPermissionMode("auto");

        connection.onStartPlaybook(dir.toString(), hash(dir), TASK);

        String id = connection.sessionId();
        Path sidecar = PlaybookRecorder.fileFor(id);
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < until
                && !(Files.exists(sidecar) && Files.readString(sidecar).contains("\"playbook_end\""))) {
            Thread.sleep(50);
        }
        assertThat(errors()).isEmpty();
        assertThat(Files.readString(SessionStore.sessionFile(id))).as("premise: the step called the file tool")
                .contains("\"name\":\"write_file\"").contains("Wrote: docs/plan.md");
        assertThat(Files.readString(workspace.resolve("docs/plan.md"))).isEqualTo("## Tasks\n- export\n");
        assertThat(dir.resolve("docs")).as("nothing landed beside the playbook").doesNotExist();
        assertThat(Files.readString(sidecar)).as("both checks read the workspace")
                .contains("\"result\":\"done\"").doesNotContain("\"label\":\"fail\"");
    }
}
