package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.playbook.run.PlaybookRecorder;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.server.playbooks.InstallLedger;
import dev.spectroscope.server.playbooks.PlaybookContents;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import dev.spectroscope.server.playbooks.PlaybookInstaller;
import dev.spectroscope.server.providers.ProviderRow;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 482: the inbound frame {@code start_playbook} on a real
 * {@link SessionConnection}. It starts only on the hash the confirmation
 * showed, holds the run slot while the playbook runs, drains like a prompt and
 * leaves a sidecar that ends; a step's permission floor makes the gate stricter.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class PlaybookStartFrameTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** VocabularyTest.LOOP with write_plan as the only step, build removed, both choices on ollama. */
    private static final String ONE_STEP = """
        { "schema_version": 1, "id": "t", "name": "T", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "plan.md", "sections": ["Tasks"] } },
          "checks": { "plan_ok": { "kind": "command", "run": "test -f plan.md" } },
          "start": "write_plan",
          "nodes": [
            { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "strong", "produces": ["plan"] },
            { "kind": "decision", "id": "plan_ok", "name": "Plan ok", "check": "plan_ok", "max_rounds": 2 },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "gave_up", "result": "gave_up" }
          ],
          "arrows": [
            { "from": "write_plan", "to": "plan_ok" },
            { "from": "plan_ok", "to": "done", "on": "pass" },
            { "from": "plan_ok", "to": "write_plan", "on": "fail" },
            { "from": "plan_ok", "to": "gave_up", "on": "exhausted" }
          ] }
        """;

    /** One child step whose role is an agent file of the playbook (card 485). */
    private static final String AGENT_STEP = """
        { "schema_version": 1, "id": "agentpb", "name": "A", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": {},
          "checks": {},
          "contents": { "agents": ["agents/reviewer.md"] },
          "start": "review",
          "nodes": [
            { "kind": "step", "id": "review", "name": "Review", "goal": "Review the diff.",
              "performer": "child", "role": "agent:reviewer", "model": "strong" },
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
    @TempDir Path installs;

    private FakeSocket socket;

    /** A provider whose every answer waits for the gate, so a test can act while the run is live. */
    private static LlmProvider says(String model, String text, CountDownLatch gate) {
        return new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                try {
                    gate.await(20, TimeUnit.SECONDS);
                } catch (InterruptedException stopped) {
                    Thread.currentThread().interrupt();
                }
                return List.of(new PTextDelta(text), new PUsage(2, 1), new PStop(PStop.StopReason.END_TURN));
            }

            @Override
            public String modelName() {
                return model;
            }
        };
    }

    private SessionConnection session(String socketId, CountDownLatch gate) {
        socket = new FakeSocket(socketId, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())),
                null);
        connection.providerBuilderForTest(c -> says(c.model(), "ok", gate));
        connection.providerCheckForTest(p -> new ProviderRow(p, "local", "reachable", false, null,
                "http://localhost:11434", List.of("qwen3:8b"), false, null, 1L));
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        return connection;
    }

    private Path writePlaybook() throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), ONE_STEP);
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    private List<JsonNode> frames() throws IOException {
        List<JsonNode> out = new ArrayList<>();
        for (FakeSocket.Frame f : socket.frames()) {
            out.add(JSON.readTree(f.payload()));
        }
        return out;
    }

    private List<String> errors() throws IOException {
        return frames().stream().filter(f -> "error".equals(f.path("type").asText()))
                .map(f -> f.path("message").asText()).toList();
    }

    private static Set<String> sidecars() throws IOException {
        Path folder = PlaybookRecorder.folder();
        if (!Files.isDirectory(folder)) {
            return Set.of();
        }
        try (Stream<Path> files = Files.list(folder)) {
            return files.map(f -> f.getFileName().toString()).collect(java.util.stream.Collectors.toCollection(TreeSet::new));
        }
    }

    @Test
    void aHashThatNoLongerMatchesStartsNothing() throws IOException {
        Path dir = writePlaybook();
        Set<String> before = sidecars();
        SessionConnection connection = session("ws-482-changed", new CountDownLatch(0));

        connection.onStartPlaybook(dir.toString(), "sha256:0000");

        assertThat(errors()).containsExactly(SessionConnection.PLAYBOOK_CHANGED);
        assertThat(connection.sessionId()).as("premise: the session has an id").isNotNull();
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).as("a refused start writes no sidecar")
                .doesNotExist();
        assertThat(sidecars()).as("and no other file beside the sessions").isEqualTo(before);
    }

    @Test
    void anUnregisteredFolderStartsNothing(@TempDir Path stranger) throws IOException {
        Files.writeString(stranger.resolve("playbook.json"), ONE_STEP);
        Playbook p = PlaybookReader.read(ONE_STEP).playbook();
        String hash = PinnedPlaybook.pin(stranger, p, n -> null).hash();
        SessionConnection connection = session("ws-482-stranger", new CountDownLatch(0));

        connection.onStartPlaybook(stranger.toString(), hash);

        assertThat(errors()).singleElement().asString().contains("not a registered playbook folder");
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).doesNotExist();
    }

    @Test
    void theConfirmedHashRunsThePlaybookAndHoldsTheRunSlot() throws Exception {
        Path dir = writePlaybook();
        Files.writeString(workspace.resolve("plan.md"), "## Tasks\n- one\n");
        Playbook p = PlaybookReader.read(ONE_STEP).playbook();
        String pinnedHash = PinnedPlaybook.pin(dir, p, n -> null).hash();
        CountDownLatch gate = new CountDownLatch(1);
        SessionConnection connection = session("ws-482-run", gate);
        connection.onSetPermissionMode("auto");

        connection.onStartPlaybook(dir.toString(), pinnedHash);
        connection.onUserMessage("x", null);
        assertThat(errors()).as("a prompt during the playbook run meets the run slot")
                .containsExactly(SessionConnection.RUN_ACTIVE);
        gate.countDown();

        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        Path sidecar = null;
        while (System.nanoTime() < until) {
            String id = connection.sessionId();
            if (id != null) {
                sidecar = PlaybookRecorder.fileFor(id);
                if (Files.exists(sidecar) && Files.readString(sidecar).contains("\"playbook_end\"")) {
                    break;
                }
            }
            Thread.sleep(50);
        }
        assertThat(sidecar).as("the run minted a session").isNotNull();
        String lines = Files.readString(sidecar);
        assertThat(lines).contains("\"playbook_end\"").contains("\"stopReason\":\"done\"")
                .contains(pinnedHash);
        assertThat(frames()).as("the plan rides the socket under the playbook's agent id")
                .anySatisfy(f -> {
                    assertThat(f.path("type").asText()).isEqualTo("plan");
                    assertThat(f.path("agentId").asText()).isEqualTo("playbook");
                });
        assertThat(errors()).containsExactly(SessionConnection.RUN_ACTIVE);
    }

    @Test
    void aStepFloorMakesTheGateStricterAndNeverWider() {
        SessionConnection connection = session("ws-482-floor", new CountDownLatch(0));
        connection.onSetPermissionMode("auto");
        connection.buildAgentOnce();
        RunEvent.PermissionRequest write = new RunEvent.PermissionRequest("main", "c1", "write_file",
                JsonNodeFactory.instance.objectNode().put("path", "a.txt"), System.currentTimeMillis());

        connection.permissionFloor("ask");
        assertThat(connection.effectiveMode()).isEqualTo("ask");
        connection.permissionFloor("readonly");
        assertThat(connection.effectiveMode()).isEqualTo("readonly");
        assertThat(connection.broker().decide(write)).as("auto under a readonly floor refuses").isFalse();

        connection.permissionFloor(null);
        assertThat(connection.effectiveMode()).isEqualTo("auto");
        assertThat(connection.broker().decide(write)).as("auto without a floor allows").isTrue();

        connection.onSetPermissionMode("extended");
        assertThat(connection.broker().reachesOutsideTheWorkingDirectory()).isTrue();
        connection.permissionFloor("auto");
        assertThat(connection.effectiveMode()).isEqualTo("auto");
        assertThat(connection.broker().reachesOutsideTheWorkingDirectory())
                .as("a floor below extended keeps the file tools inside the folder").isFalse();
    }

    /** The agent playbook in a registered folder, with the licence files an install needs. */
    private Path writeAgentPlaybook() throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), AGENT_STEP);
        Files.createDirectories(playbookDir.resolve("agents"));
        Files.writeString(playbookDir.resolve("agents/reviewer.md"), REVIEWER);
        Files.writeString(playbookDir.resolve("LICENSE"), "MIT\n");
        Files.writeString(playbookDir.resolve("PROVENANCE.md"), "Written for this test.\n");
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    /** Installs the folder's contents through the real installer into the given ledger. */
    private void install(Path dir, InstallLedger ledger) throws IOException {
        Playbook p = PlaybookReader.read(AGENT_STEP).playbook();
        Path home = installs.resolve("spectro-home");
        Path projectSkills = installs.resolve("project/.spectro/skills");
        String shown = PlaybookContents.preview(dir, p, home, projectSkills, ledger, null).contentsHash();
        PlaybookInstaller.Result result = new PlaybookInstaller(home, projectSkills, installs.resolve("settings.json"),
                ledger).install(dir, p, shown, false);
        assertThat(result.status()).as(result.message()).isEqualTo(PlaybookInstaller.Status.INSTALLED);
    }

    /** Starts the agent playbook on the hash the confirmation shows and returns its playbook_end line. */
    private String startAndAwaitTheEnd(Path dir, InstallLedger ledger, String socketId) throws Exception {
        String hash = PinnedPlaybook.pin(dir, PlaybookReader.read(AGENT_STEP).playbook(), n -> null).hash();
        SessionConnection connection = session(socketId, new CountDownLatch(0));
        connection.installLedgerForTest(ledger);
        connection.onSetPermissionMode("auto");

        connection.onStartPlaybook(dir.toString(), hash);

        assertThat(errors()).as("the frame itself is accepted").isEmpty();
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < until) {
            String id = connection.sessionId();
            if (id != null) {
                Path sidecar = PlaybookRecorder.fileFor(id);
                if (Files.exists(sidecar) && Files.readString(sidecar).contains("\"playbook_end\"")) {
                    return Files.readString(sidecar);
                }
            }
            Thread.sleep(50);
        }
        throw new AssertionError("the run did not end in 20 s");
    }

    @Test
    void anAgentStepRunsWhenTheLedgerHoldsItsFileAsInstalled() throws Exception {
        Path dir = writeAgentPlaybook();
        InstallLedger ledger = new InstallLedger(installs.resolve("playbook-installs.json"));
        install(dir, ledger);

        String lines = startAndAwaitTheEnd(dir, ledger, "ws-485-installed");

        assertThat(lines).contains("\"stopReason\":\"done\"").contains("\"agent\":\"reviewer\"")
                .doesNotContain("agent not installed");
    }

    @Test
    void anAgentStepWithoutALedgerEntryIsRefusedAtStartByName() throws Exception {
        Path dir = writeAgentPlaybook();
        InstallLedger ledger = new InstallLedger(installs.resolve("playbook-installs.json"));

        String lines = startAndAwaitTheEnd(dir, ledger, "ws-485-absent");

        assertThat(lines).contains("\"stopReason\":\"refused\"").contains("agent not installed: reviewer")
                .doesNotContain("\"step_start\"");
    }

    @Test
    void anAgentFileEditedAfterTheInstallIsRefusedAtStart() throws Exception {
        Path dir = writeAgentPlaybook();
        InstallLedger ledger = new InstallLedger(installs.resolve("playbook-installs.json"));
        install(dir, ledger);
        Files.writeString(dir.resolve("agents/reviewer.md"), REVIEWER.replace("never edit a file", "edit every file"));

        String lines = startAndAwaitTheEnd(dir, ledger, "ws-485-edited");

        assertThat(lines).contains("\"stopReason\":\"refused\"").contains("agent changed since install: reviewer")
                .doesNotContain("\"step_start\"");
    }
}
