package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.SafeWalk;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import dev.spectroscope.server.providers.ProviderRow;
import org.assertj.core.api.SoftAssertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.handler.WebSocketSessionDecorator;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 578: the session's status line follows the run flag at both edges.
 *
 * <p>What these tests assert: the rows {@link LiveSessions} hands its listeners
 * and returns from {@code snapshot()}. The row that says a run started says
 * working, the row that says it stopped says idle, on a normal end, a Stop and
 * an error, and the peer port's turn is null after the end. The
 * {@code live_sessions} frame and {@code GET /api/sessions/live} are built
 * from the same snapshot; no test here reads their JSON.</p>
 *
 * <p>Before the card a playbook run published {@code running: false} with the
 * last step's {@code "working"}, and only a reload, a new connection, said
 * idle; a playbook or workflow run started as idle until the main agent's
 * first turn.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class RunStatusLineTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** PlaybookStartFrameTest.ONE_STEP: one chat step and a command check that passes. */
    private static final String ONE_STEP = """
        { "schema_version": 1, "id": "t578", "name": "T", "description": "d",
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

    /** The shipped playbook's first node: a classify question before any model turn. */
    private static final String CLASSIFY_FIRST = """
        { "schema_version": 1, "id": "t578q", "name": "Q", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": {},
          "checks": { "classify_check": { "kind": "human", "ask": "Which path does this request take?",
                                          "labels": ["bounded", "stop"] } },
          "start": "classify",
          "nodes": [
            { "kind": "decision", "id": "classify", "name": "Classify", "check": "classify_check" },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "stopped", "result": "stopped" }
          ],
          "arrows": [
            { "from": "classify", "to": "done", "on": "bounded" },
            { "from": "classify", "to": "stopped", "on": "stop" }
          ] }
        """;

    /** WorkflowStartFrameTest's playbook with one workflow: a prompt step and an end. */
    private static final String WF_PLAYBOOK = """
        { "schema_version": 1, "id": "t578w", "name": "W", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": {}, "checks": {},
          "contents": { "workflows": ["workflows/ask.json"] },
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

    @TempDir Path workspace;
    @TempDir Path playbookDir;

    /**
     * A rail on the registry: every row it was handed, the first row that said
     * a run started, and the first row that said the run stopped after one said
     * it ran, with the socket's frames and the peer port's turn at that moment.
     * The peer record is rewritten on each publish, so the turn at the end
     * publish is the turn the record carries after the run.
     */
    private static final class Rail implements LiveSessions.Listener {
        final List<LiveSessions.LiveSession> rows = new CopyOnWriteArrayList<>();
        final AtomicReference<LiveSessions.LiveSession> startRow = new AtomicReference<>();
        final AtomicReference<LiveSessions.LiveSession> endRow = new AtomicReference<>();
        final AtomicReference<List<FakeSocket.Frame>> framesAtEnd = new AtomicReference<>();
        /** The peer port's turn at the end publish, as text. */
        final AtomicReference<String> turnAtEnd = new AtomicReference<>();
        final CountDownLatch ended = new CountDownLatch(1);
        private final AtomicBoolean ran = new AtomicBoolean();
        private final FakeSocket socket;
        private final LiveSessions registry;

        Rail(FakeSocket socket, LiveSessions registry) {
            this.socket = socket;
            this.registry = registry;
        }

        @Override
        public void onLiveSessions(List<LiveSessions.LiveSession> live) {
            for (LiveSessions.LiveSession row : live) {
                rows.add(row);
                if (row.running()) {
                    startRow.compareAndSet(null, row);
                    ran.set(true);
                } else if (ran.get() && endRow.compareAndSet(null, row)) {
                    framesAtEnd.set(socket.frames());
                    turnAtEnd.set(turn());
                    ended.countDown();
                }
            }
        }

        /** Called under the registry's monitor, which is reentrant. */
        private String turn() {
            List<dev.spectroscope.core.peer.PeerSession> ports = registry.ports();
            return ports.isEmpty() ? "no port" : String.valueOf(ports.getFirst().turn());
        }

        /** @return the frames of one type the socket had when the run stopped */
        List<JsonNode> framesAtEnd(String type) throws IOException {
            List<JsonNode> out = new ArrayList<>();
            for (FakeSocket.Frame f : framesAtEnd.get()) {
                JsonNode node = JSON.readTree(f.payload());
                if (type.equals(node.path("type").asText())) {
                    out.add(node);
                }
            }
            return out;
        }
    }

    /** The socket as the connection sees it: records, and opens a latch on the first question frame. */
    private static final class QuestionSocket extends WebSocketSessionDecorator {
        final CountDownLatch asked = new CountDownLatch(1);
        final AtomicReference<String> callId = new AtomicReference<>();

        QuestionSocket(FakeSocket recorder) {
            super(recorder);
        }

        @Override
        public void sendMessage(WebSocketMessage<?> message) throws IOException {
            super.sendMessage(message);
            if (message instanceof TextMessage text) {
                JsonNode frame = JSON.readTree(text.getPayload());
                if ("question_asked".equals(frame.path("type").asText())
                        && callId.compareAndSet(null, frame.path("callId").asText())) {
                    asked.countDown();
                }
            }
        }
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

    /** A connection wired to a registry, as SpectroSocketHandler wires it. */
    private SessionConnection session(org.springframework.web.socket.WebSocketSession socket, LiveSessions live) {
        return session(socket, live, c -> says(c.model()));
    }

    /** The same, with the provider the run builds. */
    private SessionConnection session(org.springframework.web.socket.WebSocketSession socket, LiveSessions live,
                                      java.util.function.Function<SpectroConfig, LlmProvider> builder) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())),
                null, null, live);
        connection.providerBuilderForTest(builder);
        connection.providerCheckForTest(p -> new ProviderRow(p, "local", "reachable", false, null,
                "http://localhost:11434", List.of("qwen3:8b"), false, null, 1L));
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        connection.onSetPermissionMode("auto");
        return connection;
    }

    /** Registers the folder with one playbook file and answers the hash the sheet shows. */
    private String registerPlaybook(String json) throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), json);
        PlaybookFolders.inHome().register(playbookDir);
        return PinnedPlaybook.pin(playbookDir.toRealPath(), PlaybookReader.read(json).playbook()).hash();
    }

    private static List<String> errors(FakeSocket socket) throws IOException {
        List<String> out = new ArrayList<>();
        for (FakeSocket.Frame f : socket.frames()) {
            JsonNode n = JSON.readTree(f.payload());
            if ("error".equals(n.path("type").asText())) {
                out.add(n.path("message").asText());
            }
        }
        return out;
    }

    @Test
    void thePublishThatEndsAPlaybookRunSaysIdle() throws Exception {
        Files.writeString(workspace.resolve("plan.md"), "## Tasks\n- one\n");
        String hash = registerPlaybook(ONE_STEP);
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-578-playbook", "ws://localhost/ws");
        Rail rail = new Rail(socket, live);
        live.addListener(rail);
        SessionConnection connection = session(socket, live);

        connection.onStartPlaybook(playbookDir.toRealPath().toString(), hash, "add a CSV export");

        assertThat(rail.ended.await(20, TimeUnit.SECONDS)).as("the run stopped").isTrue();
        assertThat(rail.rows).as("premise: a step moved the row to working while the run ran")
                .anySatisfy(row -> {
                    assertThat(row.running()).isTrue();
                    assertThat(row.statusLine()).isEqualTo("working");
                });
        assertThat(rail.framesAtEnd("playbook_progress")).as("the end line was out before the run stopped")
                .anySatisfy(f -> assertThat(f.path("phase").asText()).isEqualTo("end"));
        assertThat(rail.endRow.get().statusLine()).as("the row after the playbook's end").isEqualTo("idle");
        assertThat(live.snapshot()).as("what the poll reads").singleElement()
                .satisfies(row -> {
                    assertThat(row.running()).isFalse();
                    assertThat(row.statusLine()).isEqualTo("idle");
                });
        assertThat(rail.framesAtEnd("turn_start")).as("premise: the step ran a main turn, which sets the turn")
                .anySatisfy(f -> assertThat(f.path("agentId").asText()).isEqualTo("main"));
        assertThat(rail.turnAtEnd.get()).as("the peer port's turn after the playbook's end").isEqualTo("null");
    }

    @Test
    void thePublishThatEndsAPromptRunSaysIdle() throws Exception {
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-578-prompt", "ws://localhost/ws");
        Rail rail = new Rail(socket, live);
        live.addListener(rail);
        SessionConnection connection = session(socket, live);

        connection.onUserMessage("hi", null);

        assertThat(rail.ended.await(20, TimeUnit.SECONDS)).as("the run stopped").isTrue();
        assertThat(rail.rows).as("premise: the turn moved the row to working while the run ran")
                .anySatisfy(row -> {
                    assertThat(row.running()).isTrue();
                    assertThat(row.statusLine()).isEqualTo("working");
                });
        assertThat(rail.framesAtEnd("run_end")).as("the run's end was out before the run stopped").isNotEmpty();
        assertThat(rail.endRow.get().statusLine()).as("the row after the prompt's end").isEqualTo("idle");
        assertThat(live.snapshot()).singleElement()
                .satisfies(row -> assertThat(row.statusLine()).isEqualTo("idle"));
        assertThat(rail.framesAtEnd("turn_start")).as("premise: the prompt ran a main turn, which sets the turn")
                .anySatisfy(f -> assertThat(f.path("agentId").asText()).isEqualTo("main"));
        assertThat(rail.turnAtEnd.get()).as("the peer port's turn after the prompt's end").isEqualTo("null");
    }

    @Test
    void aPlaybookRunSaysWorkingFromItsStartAndWhileTheClassifyQuestionWaits() throws Exception {
        String hash = registerPlaybook(CLASSIFY_FIRST);
        LiveSessions live = new LiveSessions();
        FakeSocket recorder = new FakeSocket("ws-578-classify", "ws://localhost/ws");
        QuestionSocket socket = new QuestionSocket(recorder);
        Rail rail = new Rail(recorder, live);
        live.addListener(rail);
        SessionConnection connection = session(socket, live);

        connection.onStartPlaybook(playbookDir.toRealPath().toString(), hash, "add a CSV export");

        assertThat(errors(recorder)).as("the start is accepted").isEmpty();
        assertThat(socket.asked.await(20, TimeUnit.SECONDS)).as("the classify question went out").isTrue();
        boolean answered = false;
        try {
            assertThat(rail.startRow.get()).as("the run's first publish").isNotNull();
            SoftAssertions.assertSoftly(soft -> {
                soft.assertThat(rail.startRow.get().statusLine()).as("the row from the start frame on")
                        .isEqualTo("working");
                LiveSessions.LiveSession waiting = live.snapshot().getFirst();
                soft.assertThat(waiting.running()).as("premise: the run waits on the question").isTrue();
                soft.assertThat(waiting.statusLine()).as("what the poll reads while the question waits")
                        .isEqualTo("working");
                soft.assertThat(rail.rows).as("no row of the run said idle before the end")
                        .noneMatch(row -> row.running() && "idle".equals(row.statusLine()));
            });

            connection.onQuestionResponse(socket.callId.get(), List.of("bounded"), false);
            answered = true;
        } finally {
            if (!answered) {
                connection.onQuestionResponse(socket.callId.get(), List.of(), true); // release the parked run
            }
        }

        assertThat(rail.ended.await(20, TimeUnit.SECONDS)).as("the run stopped").isTrue();
        assertThat(rail.endRow.get().statusLine()).isEqualTo("idle");
    }

    @Test
    void aWorkflowRunSaysWorkingFromItsStart() throws Exception {
        Files.writeString(playbookDir.resolve("playbook.json"), WF_PLAYBOOK);
        Files.createDirectories(playbookDir.resolve("workflows"));
        Files.writeString(playbookDir.resolve("workflows/ask.json"), ASK);
        PlaybookFolders.inHome().register(playbookDir);
        Path dir = playbookDir.toRealPath();
        String hash = ContentHash.tree(SafeWalk.walk(dir, dir.resolve("workflows/ask.json")));
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-578-workflow", "ws://localhost/ws");
        Rail rail = new Rail(socket, live);
        live.addListener(rail);
        SessionConnection connection = session(socket, live);

        connection.onStartWorkflow(dir.toString(), "workflows/ask.json", hash, "Ada", "en");

        assertThat(rail.ended.await(20, TimeUnit.SECONDS)).as("the run stopped").isTrue();
        assertThat(errors(socket)).as("the start is accepted").isEmpty();
        assertThat(rail.startRow.get().statusLine()).as("the row from the start frame on").isEqualTo("working");
        assertThat(rail.endRow.get().statusLine()).isEqualTo("idle");
        assertThat(rail.framesAtEnd("turn_start")).as("premise: the prompt step ran a main turn, which sets the turn")
                .anySatisfy(f -> assertThat(f.path("agentId").asText()).isEqualTo("main"));
        assertThat(rail.turnAtEnd.get()).as("the peer port's turn after the workflow's end").isEqualTo("null");
    }

    @Test
    void aPlaybookRunStoppedAtTheClassifyQuestionEndsIdle() throws Exception {
        String hash = registerPlaybook(CLASSIFY_FIRST);
        LiveSessions live = new LiveSessions();
        FakeSocket recorder = new FakeSocket("ws-578-stop", "ws://localhost/ws");
        QuestionSocket socket = new QuestionSocket(recorder);
        Rail rail = new Rail(recorder, live);
        live.addListener(rail);
        SessionConnection connection = session(socket, live);

        connection.onStartPlaybook(playbookDir.toRealPath().toString(), hash, "add a CSV export");
        assertThat(socket.asked.await(20, TimeUnit.SECONDS)).as("the classify question went out").isTrue();
        connection.onAbort();

        assertThat(rail.ended.await(20, TimeUnit.SECONDS)).as("the run stopped").isTrue();
        assertThat(rail.framesAtEnd("playbook_progress")).as("premise: the Stop ended the run")
                .anySatisfy(f -> {
                    assertThat(f.path("phase").asText()).isEqualTo("end");
                    assertThat(f.path("stopReason").asText()).isEqualTo("aborted");
                });
        assertThat(rail.endRow.get().statusLine()).as("the row after a Stop").isEqualTo("idle");
        assertThat(live.snapshot()).as("what the poll reads").singleElement()
                .satisfies(row -> {
                    assertThat(row.running()).isFalse();
                    assertThat(row.statusLine()).isEqualTo("idle");
                });
    }

    /** A provider that cannot be built, the way a missing key fails. */
    private static LlmProvider noProvider(SpectroConfig config) {
        throw new IllegalStateException("no key for " + config.provider());
    }

    @Test
    void aPlaybookRunThatEndsWithAnErrorEndsIdle() throws Exception {
        String hash = registerPlaybook(CLASSIFY_FIRST);
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-578-pb-error", "ws://localhost/ws");
        Rail rail = new Rail(socket, live);
        live.addListener(rail);
        SessionConnection connection = session(socket, live, RunStatusLineTest::noProvider);

        connection.onStartPlaybook(playbookDir.toRealPath().toString(), hash, "add a CSV export");

        assertThat(rail.ended.await(20, TimeUnit.SECONDS)).as("the run stopped").isTrue();
        assertThat(rail.framesAtEnd("error")).as("premise: the run ended with an error")
                .anySatisfy(f -> assertThat(f.path("message").asText())
                        .startsWith("Playbook run ended with an error"));
        assertThat(rail.endRow.get().statusLine()).as("the row after the error").isEqualTo("idle");
        assertThat(live.snapshot()).singleElement().satisfies(row -> assertThat(row.running()).isFalse());
    }

    @Test
    void aWorkflowRunThatEndsWithAnErrorEndsIdle() throws Exception {
        Files.writeString(playbookDir.resolve("playbook.json"), WF_PLAYBOOK);
        Files.createDirectories(playbookDir.resolve("workflows"));
        Files.writeString(playbookDir.resolve("workflows/ask.json"), ASK);
        PlaybookFolders.inHome().register(playbookDir);
        Path dir = playbookDir.toRealPath();
        String hash = ContentHash.tree(SafeWalk.walk(dir, dir.resolve("workflows/ask.json")));
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-578-wf-error", "ws://localhost/ws");
        Rail rail = new Rail(socket, live);
        live.addListener(rail);
        SessionConnection connection = session(socket, live, RunStatusLineTest::noProvider);

        connection.onStartWorkflow(dir.toString(), "workflows/ask.json", hash, "Ada", "en");

        assertThat(rail.ended.await(20, TimeUnit.SECONDS)).as("the run stopped").isTrue();
        assertThat(rail.framesAtEnd("error")).as("premise: the run ended with an error")
                .anySatisfy(f -> assertThat(f.path("message").asText())
                        .startsWith("Workflow run ended with an error"));
        assertThat(rail.endRow.get().statusLine()).as("the row after the error").isEqualTo("idle");
        assertThat(live.snapshot()).singleElement().satisfies(row -> assertThat(row.running()).isFalse());
    }
}
