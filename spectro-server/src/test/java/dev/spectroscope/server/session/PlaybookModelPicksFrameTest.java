package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.run.ModelPicks;
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
import org.springframework.web.socket.TextMessage;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 584 on a real {@link SessionConnection}: the start sheet asks every
 * provider for its model list, names why a step's model does not serve and
 * which models answered; {@code start_playbook} carries the owner's picks,
 * which the server checks again as untrusted input, and the run uses them for
 * this run only, without writing the playbook folder.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class PlaybookModelPicksFrameTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TASK = "build a frogger clone";

    /** A cheap chat step on anthropic, then a private chat step on ollama, then a command check. */
    private static final String TWO_STEPS = """
        { "schema_version": 1, "id": "k", "name": "K", "description": "d",
          "models": { "strong": { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" } },
                      "local":  { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "plan.md", "sections": ["Tasks"] } },
          "checks": { "plan_ok": { "kind": "command", "run": "test -f plan.md" } },
          "start": "write_plan",
          "nodes": [
            { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "strong",
              "produces": ["plan"] },
            { "kind": "step", "id": "tidy", "name": "Tidy", "performer": "chat", "model": "local",
              "privacy": "private" },
            { "kind": "decision", "id": "plan_ok", "name": "Plan ok", "check": "plan_ok" },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "failed", "result": "failed" }
          ],
          "arrows": [
            { "from": "write_plan", "to": "tidy" },
            { "from": "tidy", "to": "plan_ok" },
            { "from": "plan_ok", "to": "done", "on": "pass" },
            { "from": "plan_ok", "to": "failed", "on": "fail" }
          ] }
        """;

    @TempDir Path workspace;
    @TempDir Path playbookDir;

    private FakeSocket socket;
    private final List<String> sessions = new ArrayList<>();
    /** Every provider the registry check was asked for, in the order asked. */
    private final List<String> checked = new CopyOnWriteArrayList<>();
    /** provider/model of every provider the session built. */
    private final List<String> built = new CopyOnWriteArrayList<>();

    @AfterEach
    void forget() throws IOException {
        for (String id : sessions) {
            if (id != null) {
                Files.deleteIfExists(SessionStore.sessionFile(id));
            }
        }
    }

    /** anthropic rejects the key with 401, ollama and openai answer, every other provider is refused. */
    private ProviderRow check(String provider) {
        checked.add(provider);
        return switch (provider) {
            case "anthropic" -> new ProviderRow("anthropic", "cloud", "failed", true, null, null, List.of(), false,
                    "rejected-key", 1L, 401);
            case "ollama" -> new ProviderRow("ollama", "local", "reachable", false, null, "http://localhost:11434",
                    List.of("qwen3:8b", "llama3:8b"), true, null, 1L, null);
            case "openai" -> new ProviderRow("openai", "cloud", "reachable", true, null, null, List.of("gpt-5"), true,
                    null, 1L, null);
            default -> new ProviderRow(provider, "local", "failed", false, null, "http://localhost:1", List.of(),
                    false, "refused", 1L, null);
        };
    }

    private static LlmProvider says(String model) {
        return new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                return List.of(new PTextDelta("ok"), new PUsage(2, 1), new PStop(PStop.StopReason.END_TURN));
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
        connection.providerBuilderForTest(c -> {
            built.add(c.provider() + "/" + c.model());
            return says(c.model());
        });
        connection.providerCheckForTest(this::check);
        connection.keySourceForTest(provider -> "anthropic".equals(provider) ? "environment" : null);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        sessions.add(connection.sessionId());
        return connection;
    }

    private Path registered() throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), TWO_STEPS);
        Files.writeString(playbookDir.resolve("notes.md"), "## Notes\n");
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    private static String hash(Path dir) throws IOException {
        return PinnedPlaybook.pin(dir, PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).playbook())
                .hash();
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

    private List<String> errors() throws IOException {
        return frames("error").stream().map(f -> f.path("message").asText()).toList();
    }

    /** The errors once there are {@code n}: a pick is checked again on the run's own thread (fix round, D1). */
    private List<String> awaitErrors(int n) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (errors().size() < n && System.nanoTime() < until) {
            Thread.sleep(20);
        }
        return errors();
    }

    /** The first playbook_confirm frame, sent once every provider answered (fix round, D1). */
    private JsonNode awaitConfirm() throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (frames("playbook_confirm").isEmpty() && System.nanoTime() < until) {
            Thread.sleep(20);
        }
        assertThat(frames("playbook_confirm")).as("a playbook_confirm frame").isNotEmpty();
        return frames("playbook_confirm").getFirst();
    }

    /** Every file below the folder with its bytes, so a change of one byte shows. */
    private static Map<String, String> bytesOf(Path dir) throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path f : walk.toList()) {
                String name = dir.relativize(f).toString();
                out.put(name, Files.isDirectory(f) ? "dir" : HexFormat.of().formatHex(Files.readAllBytes(f)));
            }
        }
        return out;
    }

    private static JsonNode picks(String json) throws IOException {
        return JSON.readTree(json);
    }

    private static void awaitEnd(Path sidecar) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < until
                && !(Files.exists(sidecar) && Files.readString(sidecar).contains("\"playbook_end\""))) {
            Thread.sleep(50);
        }
    }

    // ---- the sheet -------------------------------------------------------- //

    @Test
    void theConfirmAsksEveryProviderAndNamesWhyAStepsModelDoesNotServe() throws Exception {
        Path dir = registered();
        SessionConnection connection = session("ws-584-confirm");

        connection.onConfirmPlaybook(dir.toString(), TASK);

        JsonNode preview = awaitConfirm().path("preview");
        assertThat(errors()).isEmpty();
        assertThat(new TreeSet<>(checked)).as("every provider was asked for its model list before the sheet")
                .isEqualTo(new TreeSet<>(SpectroConfig.knownProviders()));
        JsonNode plan = preview.path("models").get(0);
        assertThat(plan.path("node").asText()).isEqualTo("write_plan");
        assertThat(plan.path("serves").asBoolean(true)).isFalse();
        assertThat(plan.path("reason").asText()).isEqualTo("rejected-key");
        assertThat(plan.path("httpStatus").asInt()).isEqualTo(401);
        assertThat(plan.path("keySource").asText()).isEqualTo("environment");
        JsonNode tidy = preview.path("models").get(1);
        assertThat(tidy.path("node").asText()).isEqualTo("tidy");
        assertThat(tidy.path("serves").asBoolean(false)).isTrue();
        assertThat(tidy.path("privacy").asText()).isEqualTo("private");
        assertThat(preview.path("offers").toString())
                .isEqualTo("[{\"provider\":\"ollama\",\"kind\":\"local\",\"models\":[\"qwen3:8b\",\"llama3:8b\"]},"
                        + "{\"provider\":\"openai\",\"kind\":\"cloud\",\"models\":[\"gpt-5\"]}]");
        assertThat(preview.path("steps").get(0).path("providerState").asText()).isEqualTo("failed");
        assertThat(preview.path("refusals")).isEmpty();
    }

    // ---- the start -------------------------------------------------------- //

    @Test
    void theRunUsesThePickedModelForThisRunOnlyAndLeavesThePlaybookFolderByteForByte() throws Exception {
        Path dir = registered();
        Files.writeString(workspace.resolve("plan.md"), "## Tasks\n- one\n");
        Map<String, String> before = bytesOf(dir);
        SessionConnection connection = session("ws-584-run");
        connection.onSetPermissionMode("auto");
        connection.onConfirmPlaybook(dir.toString(), TASK);

        connection.onStartPlaybook(dir.toString(), hash(dir), TASK,
                picks("{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"llama3:8b\"}}"));

        String id = connection.sessionId();
        Path sidecar = PlaybookRecorder.fileFor(id);
        awaitEnd(sidecar);
        assertThat(errors()).isEmpty();
        String lines = Files.readString(sidecar);
        assertThat(lines).contains("\"stopReason\":\"done\"");
        List<JsonNode> starts = new ArrayList<>();
        for (String line : Files.readAllLines(sidecar)) {
            JsonNode n = JSON.readTree(line);
            if ("step_start".equals(n.path("type").asText())) {
                starts.add(n);
            }
        }
        assertThat(starts).hasSize(2);
        assertThat(starts.get(0).path("node").asText()).isEqualTo("write_plan");
        assertThat(starts.get(0).path("provider").asText()).isEqualTo("ollama");
        assertThat(starts.get(0).path("model").asText()).isEqualTo("llama3:8b");
        assertThat(starts.get(0).path("picked").asBoolean()).isTrue();
        assertThat(starts.get(1).path("model").asText()).as("an unpicked step keeps the playbook's model")
                .isEqualTo("qwen3:8b");
        assertThat(lines).contains("\"picks\":{\"write_plan\":{\"provider\":\"ollama\",\"model\":\"llama3:8b\"}}");

        List<JsonNode> stepLines = new ArrayList<>();
        for (String line : Files.readAllLines(SessionStore.sessionFile(id))) {
            JsonNode n = JSON.readTree(line);
            if ("playbook_progress".equals(n.path("type").asText()) && "step".equals(n.path("phase").asText())) {
                stepLines.add(n);
            }
        }
        assertThat(stepLines).as("the chat's step line names the picked provider and model").hasSize(2);
        assertThat(stepLines.get(0).path("node").asText()).isEqualTo("write_plan");
        assertThat(stepLines.get(0).path("provider").asText()).isEqualTo("ollama");
        assertThat(stepLines.get(0).path("model").asText()).isEqualTo("llama3:8b");
        assertThat(built).contains("ollama/llama3:8b");
        assertThat(built).noneMatch(b -> b.startsWith("anthropic/"));

        assertThat(bytesOf(dir)).as("the playbook folder is not written, byte for byte").isEqualTo(before);
        assertThat(Files.readString(dir.resolve("playbook.json"))).isEqualTo(TWO_STEPS);
    }

    @Test
    void aPickIsCheckedAgainOnAFreshModelListAtTheStart() throws Exception {
        Path dir = registered();
        SessionConnection connection = session("ws-584-recheck");
        checked.clear();

        connection.onStartPlaybook(dir.toString(), hash(dir), TASK,
                picks("{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"nope\"}}"));

        assertThat(awaitErrors(1)).containsExactly("The model pick for write_plan does not serve: ollama answers at"
                + " http://localhost:11434 but does not list nope.");
        assertThat(checked).as("the server asked the picked provider again").containsExactly("ollama");
        connection.onUserMessage("x", null);
        assertThat(errors()).as("a refused start frees the run slot again").doesNotContain(SessionConnection.RUN_ACTIVE);
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).as("nothing ran").doesNotExist();
    }

    @Test
    void untrustedPicksAreRefusedAndNothingRuns() throws Exception {
        Path dir = registered();
        SessionConnection connection = session("ws-584-untrusted");
        String hash = hash(dir);

        connection.onStartPlaybook(dir.toString(), hash, TASK,
                picks("{\"write_plan\": {\"provider\": \"evil\", \"model\": \"m\"}}"));
        connection.onStartPlaybook(dir.toString(), hash, TASK,
                picks("{\"tidy\": {\"provider\": \"openai\", \"model\": \"gpt-5\"}}"));
        awaitErrors(2);
        connection.onStartPlaybook(dir.toString(), hash, TASK,
                picks("{\"plan_ok\": {\"provider\": \"ollama\", \"model\": \"llama3:8b\"}}"));
        connection.onStartPlaybook(dir.toString(), hash, TASK, picks("[\"ollama\"]"));

        assertThat(awaitErrors(4)).containsExactly(
                "The model pick for write_plan names evil, which is not a provider this app knows.",
                "The model pick for tidy does not serve: openai gpt-5 is a cloud provider and this is a private step.",
                "The model pick names plan_ok, which is not a step of this playbook that runs on a model.",
                ModelPicks.UNREADABLE);
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).as("nothing ran").doesNotExist();
    }

    @Test
    void aStaleHashStillRefusesWithValidPicks() throws IOException {
        Path dir = registered();
        SessionConnection connection = session("ws-584-stale");

        connection.onStartPlaybook(dir.toString(), "sha256:0000", TASK,
                picks("{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"llama3:8b\"}}"));

        assertThat(errors()).containsExactly(SessionConnection.PLAYBOOK_CHANGED);
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).doesNotExist();
    }

    /** Second fix round: a pick refused on the run's own thread answers the start's id. */
    @Test
    void aPickRefusedAfterTheRecheckAnswersTheStartsId() throws Exception {
        Path dir = registered();
        SessionConnection connection = session("ws-584-ask-pick");

        connection.onStartPlaybook(dir.toString(), hash(dir), TASK,
                picks("{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"nope\"}}"), "start-9");
        awaitErrors(1);
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (frames("playbook_start_refused").isEmpty() && System.nanoTime() < until) {
            Thread.sleep(20);
        }

        assertThat(frames("playbook_start_refused")).singleElement().satisfies(f -> {
            assertThat(f.path("ask").asText()).isEqualTo("start-9");
            assertThat(f.path("message").asText()).isEqualTo(errors().getFirst());
        });
    }

    /** Second fix round: an id that is too long or holds a control character is no id. */
    @Test
    void anUnreadableStartIdIsNoId() throws Exception {
        Path dir = registered();
        SessionConnection connection = session("ws-584-ask-bound");

        connection.onStartPlaybook(dir.toString(), "sha256:0000", TASK, null, "a".repeat(65));
        connection.onStartPlaybook(dir.toString(), "sha256:0000", TASK, null, "start\n1");
        connection.onStartPlaybook(dir.toString(), "sha256:0000", TASK, null, "a".repeat(64));

        assertThat(errors()).hasSize(3);
        assertThat(frames("playbook_start_refused")).as("only the readable id is answered").singleElement()
                .satisfies(f -> assertThat(f.path("ask").asText()).isEqualTo("a".repeat(64)));
    }

    /** Review D2: the picker never offers it, and the start refuses an Ollama cloud model on a private step. */
    @Test
    void anOllamaCloudModelIsRefusedOnAPrivateStepAtTheStart() throws Exception {
        Path dir = registered();
        SessionConnection connection = session("ws-584-ollama-cloud");

        connection.onStartPlaybook(dir.toString(), hash(dir), TASK,
                picks("{\"tidy\": {\"provider\": \"ollama\", \"model\": \"minimax-m3:cloud\"}}"));

        assertThat(awaitErrors(1)).containsExactly("The model pick for tidy does not serve: ollama minimax-m3:cloud"
                + " is a cloud model and this is a private step.");
        assertThat(PlaybookRecorder.fileFor(connection.sessionId())).as("nothing ran").doesNotExist();
    }

    /** Review N4: a hand-made pick equal to the step's own model is no pick on the server either. */
    @Test
    void aPickEqualToThePlaybooksModelIsNoPick() throws Exception {
        Path dir = registered();
        Files.writeString(workspace.resolve("plan.md"), "## Tasks\n- one\n");
        SessionConnection connection = session("ws-584-default-pick");
        connection.onSetPermissionMode("auto");

        connection.onStartPlaybook(dir.toString(), hash(dir), TASK, picks("""
                {"tidy": {"provider": "ollama", "model": "qwen3:8b"},
                 "write_plan": {"provider": "ollama", "model": "llama3:8b"}}"""));

        Path sidecar = PlaybookRecorder.fileFor(connection.sessionId());
        awaitEnd(sidecar);
        assertThat(errors()).isEmpty();
        String lines = Files.readString(sidecar);
        assertThat(lines).contains("\"picks\":{\"write_plan\":{\"provider\":\"ollama\",\"model\":\"llama3:8b\"}}");
        for (String line : Files.readAllLines(sidecar)) {
            JsonNode n = JSON.readTree(line);
            if ("step_start".equals(n.path("type").asText()) && "tidy".equals(n.path("node").asText())) {
                assertThat(n.path("picked").isMissingNode()).as("tidy ran on its own model, unpicked").isTrue();
            }
        }
    }

    /**
     * Review N10: a key value saved in the app reaches no frame and no
     * sidecar; the sheet only says where the key came from.
     */
    @Test
    void aSavedKeyValueNeverReachesTheSheetOrTheSidecar() throws Exception {
        String value = "test-value-584-" + System.nanoTime();
        Path env = SpectroConfig.dotEnvPath();
        Files.createDirectories(env.getParent());
        Files.writeString(env, "ANTHROPIC_API_KEY=" + value + "\n");
        try {
            Path dir = registered();
            Files.writeString(workspace.resolve("plan.md"), "## Tasks\n- one\n");
            socket = new FakeSocket("ws-584-key-value", "ws://localhost/ws");
            SessionConnection connection = new SessionConnection(socket, JSON,
                    SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                            workspace.toString())), null);
            connection.providerBuilderForTest(c -> says(c.model()));
            connection.providerCheckForTest(this::check);
            connection.start();
            connection.onSetWorkspace("set", workspace.toString());
            connection.adoptSessionConfig();
            sessions.add(connection.sessionId());
            connection.onSetPermissionMode("auto");

            connection.onConfirmPlaybook(dir.toString(), TASK);
            JsonNode plan = awaitConfirm().path("preview").path("models").get(0);
            connection.onStartPlaybook(dir.toString(), hash(dir), TASK,
                    picks("{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"llama3:8b\"}}"));
            Path sidecar = PlaybookRecorder.fileFor(connection.sessionId());
            awaitEnd(sidecar);

            assertThat(plan.path("reason").asText()).isEqualTo("rejected-key");
            assertThat(plan.path("keySource").asText()).as("the real key source, a word")
                    .isIn(SpectroConfig.KEY_SAVED, SpectroConfig.KEY_FROM_ENVIRONMENT);
            String inEnvironment = System.getenv("ANTHROPIC_API_KEY");
            List<String> secrets = inEnvironment == null || inEnvironment.isBlank() ? List.of(value)
                    : List.of(value, inEnvironment);
            String sent = socket.textJoined();
            String recorded = Files.readString(sidecar) + Files.readString(SessionStore.sessionFile(connection.sessionId()));
            for (String secret : secrets) {
                assertThat(sent.contains(secret)).as("a key value in a frame").isFalse();
                assertThat(recorded.contains(secret)).as("a key value in the sidecar or the session file").isFalse();
            }
            assertThat(sent).as("premise: the sheet was sent").contains("\"type\":\"playbook_confirm\"");
        } finally {
            Files.deleteIfExists(env);
        }
    }

    /** The socket handler hands the frame's picks to the connection; a shape that does not read refuses. */
    @Test
    void theSocketHandlerPassesThePicksOfTheFrame() throws IOException {
        Path dir = registered();
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket wire = new FakeSocket("ws-584-handler", "ws://localhost/ws");
        handler.afterConnectionEstablished(wire);

        handler.handleTextMessage(wire, new TextMessage(JSON.writeValueAsString(Map.of(
                "type", "start_playbook", "dir", dir.toString(), "hash", hash(dir), "prompt", TASK,
                "picks", List.of("not", "an", "object")))));

        List<String> said = new ArrayList<>();
        for (FakeSocket.Frame f : wire.frames()) {
            JsonNode n = JSON.readTree(f.payload());
            if ("error".equals(n.path("type").asText())) {
                said.add(n.path("message").asText());
            }
        }
        assertThat(said).contains(ModelPicks.UNREADABLE);
    }
}
