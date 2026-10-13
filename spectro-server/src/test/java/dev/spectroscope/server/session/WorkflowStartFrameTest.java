package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.SafeWalk;
import dev.spectroscope.core.playbook.run.PlaybookRecorder;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import dev.spectroscope.server.providers.ProviderRow;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 506, criteria 2 and 3 on a real {@link SessionConnection}: the inbound
 * frame {@code start_workflow} starts only on the hash the playbook module
 * showed for a file the playbook lists, holds the run slot like a playbook
 * run, and while a fan-out runs the session's status line, which the
 * registry row carries, follows its children's status lines.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class WorkflowStartFrameTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String PLAYBOOK = """
        { "schema_version": 1, "id": "wf", "name": "W", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": {}, "checks": {},
          "contents": { "workflows": ["workflows/ask.json", "workflows/fan.json"] },
          "start": "go",
          "nodes": [
            { "kind": "step", "id": "go", "name": "Go", "performer": "chat", "model": "strong" },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [ { "from": "go", "to": "done" } ] }
        """;

    private static final String ASK = """
        { "name": "ask", "steps": [ { "kind": "prompt", "template": "Say hi to {{input}}" }, { "kind": "end" } ] }
        """;

    private static final String FAN = """
        { "name": "fan", "steps": [
            { "kind": "fanout", "agents": [ { "task": "count the files" }, { "task": "read the readme" } ],
              "join": { "task": "Summarise {{results}}" } },
            { "kind": "end", "result": "summarised" } ] }
        """;

    @TempDir Path workspace;
    @TempDir Path playbookDir;

    private FakeSocket socket;

    /** Chat turns wait for the gate; a child reports one status line and holds until the hold opens. */
    private static LlmProvider provider(CountDownLatch gate, CountDownLatch hold) {
        return new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                String first = "";
                for (ProviderContent c : request.messages().getFirst().content()) {
                    if (c instanceof TextContent t) {
                        first = t.text();
                        break;
                    }
                }
                boolean child = request.system().contains("subagent");
                if (child && first.startsWith("count the files") && request.messages().size() == 1) {
                    try {
                        return List.of(new PToolCall("s1", "report_status", JSON.readTree("{\"message\":\"seven files so far\"}")),
                                new PStop(PStop.StopReason.TOOL_USE));
                    } catch (IOException e) {
                        throw new AssertionError(e);
                    }
                }
                try {
                    (child ? hold : gate).await(20, TimeUnit.SECONDS);
                } catch (InterruptedException stopped) {
                    Thread.currentThread().interrupt();
                }
                return List.of(new PTextDelta(first.startsWith("Summarise") ? "SUMMARY" : "ok"), new PUsage(2, 1),
                        new PStop(PStop.StopReason.END_TURN));
            }

            @Override
            public String modelName() {
                return "qwen3:8b";
            }
        };
    }

    private SessionConnection session(String socketId, CountDownLatch gate, CountDownLatch hold) {
        socket = new FakeSocket(socketId, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())),
                null);
        connection.providerBuilderForTest(c -> provider(gate, hold));
        connection.providerCheckForTest(p -> new ProviderRow(p, "local", "reachable", false, null,
                "http://localhost:11434", List.of("qwen3:8b"), false, null, 1L));
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        connection.onSetPermissionMode("auto");
        return connection;
    }

    private Path writePlaybook() throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), PLAYBOOK);
        Files.createDirectories(playbookDir.resolve("workflows"));
        Files.writeString(playbookDir.resolve("workflows/ask.json"), ASK);
        Files.writeString(playbookDir.resolve("workflows/fan.json"), FAN);
        Files.writeString(playbookDir.resolve("workflows/stray.json"), ASK);
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    /** The hash the contents list shows for a file. */
    private static String hash(Path dir, String rel) throws IOException {
        return ContentHash.tree(SafeWalk.walk(dir, dir.resolve(rel)));
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

    private static String awaitEnd(SessionConnection connection) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < until) {
            String id = connection.sessionId();
            if (id != null) {
                Path sidecar = PlaybookRecorder.fileFor(id);
                if (Files.exists(sidecar) && Files.readString(sidecar).contains("\"workflow_end\"")) {
                    return Files.readString(sidecar);
                }
            }
            Thread.sleep(25);
        }
        throw new AssertionError("the workflow never ended");
    }

    @Test
    void aHashThatNoLongerMatchesStartsNothing() throws IOException {
        Path dir = writePlaybook();
        SessionConnection connection = session("ws-506-changed", new CountDownLatch(0), new CountDownLatch(0));
        connection.onStartWorkflow(dir.toString(), "workflows/ask.json", "0000", "x", "en");
        assertThat(errors()).containsExactly(SessionConnection.WORKFLOW_CHANGED);
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).doesNotExist();
    }

    @Test
    void aFileThePlaybookDoesNotListStartsNothingEvenOnItsOwnHash() throws IOException {
        Path dir = writePlaybook();
        SessionConnection connection = session("ws-506-stray", new CountDownLatch(0), new CountDownLatch(0));
        connection.onStartWorkflow(dir.toString(), "workflows/stray.json", hash(dir, "workflows/stray.json"), "x", "en");
        connection.onStartWorkflow(dir.toString(), "workflows/../playbook.json", hash(dir, "playbook.json"), "x", "en");
        assertThat(errors()).hasSize(2).allSatisfy(e -> assertThat(e).contains("not a workflow this playbook lists"));
    }

    @Test
    void aFileThatDoesNotReadAsAStepListStartsNothingAndSaysWhy() throws IOException {
        Path dir = writePlaybook();
        Files.writeString(dir.resolve("workflows/ask.json"), ASK.replace("{{input}}", "{{nobody}}"));
        SessionConnection connection = session("ws-506-bad", new CountDownLatch(0), new CountDownLatch(0));
        connection.onStartWorkflow(dir.toString(), "workflows/ask.json", hash(dir, "workflows/ask.json"), "x", "en");
        assertThat(errors()).singleElement().asString().contains("does not load").contains("{{nobody}}");
    }

    @Test
    void aListedPathThatLeavesTheFolderIsRefusedAsNotListedBeforeAnythingIsRead(@TempDir Path root) throws IOException {
        // Fix round 2: the playbook may list any string; the start refuses a path
        // that leaves the folder itself, before the pin reads the file.
        Path pb = Files.createDirectories(root.resolve("pb"));
        Files.writeString(pb.resolve("playbook.json"),
                PLAYBOOK.replace("\"workflows/ask.json\", \"workflows/fan.json\"", "\"../outside.json\""));
        Files.writeString(root.resolve("outside.json"), ASK);
        PlaybookFolders.inHome().register(pb);
        Path dir = pb.toRealPath();
        SessionConnection connection = session("ws-506-escape", new CountDownLatch(0), new CountDownLatch(0));
        connection.onStartWorkflow(dir.toString(), "../outside.json",
                ContentHash.entries(java.util.Map.of("outside.json", ASK.getBytes(java.nio.charset.StandardCharsets.UTF_8))),
                "x", "en");
        assertThat(errors()).singleElement().asString().contains("../outside.json is not a workflow this playbook lists");
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).doesNotExist();
    }

    @Test
    void aWorkflowThatStartsAWorkerIsRefusedFromTheModuleAndSaysWhich() throws IOException {
        // Fix round 2: a worker can write, and a workflow starts without a sheet.
        Path dir = writePlaybook();
        Files.writeString(dir.resolve("workflows/fan.json"), FAN.replace("{ \"task\": \"read the readme\" }",
                "{ \"role\": \"worker\", \"task\": \"read the readme\" }"));
        SessionConnection connection = session("ws-506-worker", new CountDownLatch(0), new CountDownLatch(0));
        connection.onStartWorkflow(dir.toString(), "workflows/fan.json", hash(dir, "workflows/fan.json"), "x", "en");
        assertThat(errors()).singleElement().asString().contains("worker").contains("fanout-1.agents[1]");
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).doesNotExist();
    }

    @Test
    void anUnregisteredFolderStartsNothing(@TempDir Path stranger) throws IOException {
        Files.writeString(stranger.resolve("playbook.json"), PLAYBOOK);
        Files.createDirectories(stranger.resolve("workflows"));
        Files.writeString(stranger.resolve("workflows/ask.json"), ASK);
        SessionConnection connection = session("ws-506-stranger", new CountDownLatch(0), new CountDownLatch(0));
        connection.onStartWorkflow(stranger.toString(), "workflows/ask.json", hash(stranger, "workflows/ask.json"), "x", "en");
        assertThat(errors()).singleElement().asString().contains("not a registered playbook folder");
    }

    @Test
    void theConfirmedHashRunsTheWorkflowAndHoldsTheRunSlot() throws Exception {
        Path dir = writePlaybook();
        CountDownLatch gate = new CountDownLatch(1);
        SessionConnection connection = session("ws-506-run", gate, new CountDownLatch(0));
        connection.onStartWorkflow(dir.toString(), "workflows/ask.json", hash(dir, "workflows/ask.json"), "Ada", "en");
        connection.onUserMessage("x", null);
        assertThat(errors()).as("a prompt during the workflow run meets the run slot")
                .containsExactly(SessionConnection.RUN_ACTIVE);
        gate.countDown();
        String sidecar = awaitEnd(connection);
        assertThat(sidecar).contains("\"workflow_start\"").contains("\"stopReason\":\"done\"")
                .contains(hash(dir, "workflows/ask.json"));
        assertThat(Files.readString(dev.spectroscope.core.session.SessionStore.sessionFile(connection.sessionId()))).contains("Say hi to Ada");
    }

    @Test
    void duringAFanoutTheSessionStatusLineFollowsItsChildrensStatusLines() throws Exception {
        Path dir = writePlaybook();
        CountDownLatch hold = new CountDownLatch(1);
        SessionConnection connection = session("ws-506-fan", new CountDownLatch(0), hold);
        List<String> seen = new CopyOnWriteArrayList<>();
        connection.onStartWorkflow(dir.toString(), "workflows/fan.json", hash(dir, "workflows/fan.json"), "", "en");
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < until && !connection.statusLine().contains("seven files so far")) {
            seen.add(connection.statusLine());
            Thread.sleep(10);
        }
        assertThat(connection.statusLine()).isEqualTo("explore-1: seven files so far");
        hold.countDown();
        String sidecar = awaitEnd(connection);
        assertThat(sidecar).contains("\"stopReason\":\"done\"").contains("\"result\":\"summarised\"");
        assertThat(connection.statusLine()).isEqualTo("idle");
    }

    /**
     * Card 554, criterion 8a: a workflow of the session's playbook starts from
     * the chat by its name, with its input as text, and runs at once: no sheet,
     * so no shown hash; the run records the hash of the bytes it read.
     */
    @Test
    void aWorkflowNamedInTheChatRunsAtOnceOnTheSessionsPlaybookWithItsInput() throws Exception {
        Path dir = writePlaybook();
        CountDownLatch gate = new CountDownLatch(1);
        SessionConnection connection = session("ws-554-wf-name", gate, new CountDownLatch(0));
        connection.onSetPlaybook(dir.toString());

        connection.onStartWorkflowByName(null, "ask", "Ada", "en");
        gate.countDown();

        String sidecar = awaitEnd(connection);
        assertThat(errors()).isEmpty();
        assertThat(sidecar).contains("\"workflow_start\"").contains("\"stopReason\":\"done\"")
                .contains(hash(dir, "workflows/ask.json"));
        assertThat(Files.readString(dev.spectroscope.core.session.SessionStore.sessionFile(connection.sessionId())))
                .contains("Say hi to Ada");
    }

    @Test
    void anUnknownWorkflowNameIsRefusedWithTheNamesThePlaybookHas() throws IOException {
        Path dir = writePlaybook();
        SessionConnection connection = session("ws-554-wf-unknown", new CountDownLatch(0), new CountDownLatch(0));

        connection.onStartWorkflowByName(dir.toString(), "nope", "x", "en");
        connection.onStartWorkflowByName(dir.toString(), " ", "", "en");

        assertThat(errors()).containsExactly("No workflow \"nope\" in W; it has: ask, fan",
                "Usage: /playbook workflow <name> [input]; W has: ask, fan");
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).doesNotExist();
    }

    @Test
    void withoutAPlaybookAWorkflowNameIsRefusedWithHowToPickOne() throws IOException {
        writePlaybook();
        SessionConnection connection = session("ws-554-wf-none", new CountDownLatch(0), new CountDownLatch(0));

        connection.onStartWorkflowByName(null, "ask", "x", "en");

        assertThat(errors()).containsExactly(SessionConnection.NO_PLAYBOOK);
    }

    @Test
    void aWorkflowByNameThatStartsAWorkerIsRefusedAsFromTheModule() throws IOException {
        Path dir = writePlaybook();
        Files.writeString(dir.resolve("workflows/fan.json"), FAN.replace("{ \"task\": \"read the readme\" }",
                "{ \"role\": \"worker\", \"task\": \"read the readme\" }"));
        SessionConnection connection = session("ws-554-wf-worker", new CountDownLatch(0), new CountDownLatch(0));

        connection.onStartWorkflowByName(dir.toString(), "fan", "", "en");

        assertThat(errors()).singleElement().asString().contains("worker").contains("fanout-1.agents[1]");
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).doesNotExist();
    }
}
