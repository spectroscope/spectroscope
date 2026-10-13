package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.codegraph.CodeGraphAsk;
import dev.spectroscope.core.codegraph.CodeGraphBackend;
import dev.spectroscope.core.codegraph.CodeGraphSkill;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.CodeGraphTool;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 587 on the browser session: {@code /graph ask} leaves as
 * {@code graph_ask}, is refused with the way on where the folder cannot be
 * asked, and otherwise runs the question with the line that names the graph
 * tool; and the app's {@code code-graph} skill is offered while the folder has
 * a graph. The provider is a scripted Ollama on loopback.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionGraphAskTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer mock;
    private final List<JsonNode> requests = new CopyOnWriteArrayList<>();
    private String previousSettings;
    /** Fix round: when set, the backend holds its answer until this opens. */
    private volatile CountDownLatch hold;

    @BeforeEach
    void startBackend() throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (TitleRequests.isTitleRequest(body)) {
                TitleRequests.answer(exchange);
                return;
            }
            requests.add(JSON.readTree(body));
            CountDownLatch held = hold;
            if (held != null) {
                try {
                    held.await(30, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            byte[] answer = """
                    {"message":{"content":"Two callers."},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        mock.start();
        Path file = SettingsWriter.userSettingsFile();
        previousSettings = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{\"provider\":\"ollama\",\"model\":\"qwen2.5:7b\",\"baseUrl\":\"http://127.0.0.1:"
                + mock.getAddress().getPort() + "\",\"permissionMode\":\"auto\"}");
    }

    @AfterEach
    void stopBackend() throws IOException {
        mock.stop(0);
        Path file = SettingsWriter.userSettingsFile();
        if (previousSettings == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previousSettings);
        }
    }

    /** A code graph tool that finds its program, whatever this machine has installed. */
    private static CodeGraphTool installed() {
        return new CodeGraphTool(CodeGraphBackend.GRAPHIFY, () -> Optional.of("/opt/tools/graphify"),
                (argv, workdir, signal) -> new CodeGraphTool.Outcome("PlaybookRunner.step <- Engine.run", 0, false,
                        false, false));
    }

    private static CodeGraphTool missing() {
        return new CodeGraphTool(CodeGraphBackend.GRAPHIFY, Optional::empty,
                (argv, workdir, signal) -> new CodeGraphTool.Outcome("", 0, false, false, false));
    }

    /** What a build leaves: the graph and its page (fix round, M9: both make a graph). */
    private static Path withGraph(Path folder) throws IOException {
        Files.createDirectories(folder.resolve("graphify-out"));
        Files.writeString(folder.resolve("graphify-out/graph.json"), "{\"nodes\":[],\"links\":[]}");
        Files.writeString(folder.resolve("graphify-out/graph.html"), "<html></html>");
        return folder;
    }

    private static void deleteGraph(Path folder) throws IOException {
        Files.deleteIfExists(folder.resolve("graphify-out/graph.json"));
        Files.deleteIfExists(folder.resolve("graphify-out/graph.html"));
        Files.deleteIfExists(folder.resolve("graphify-out"));
    }

    /** The names in the n-th session_items frame. */
    private static String itemsOf(FakeSocket socket, int n) {
        return frames(socket, "session_items").get(n).path("items").toString();
    }

    private SessionConnection session(FakeSocket socket, Path workspace, CodeGraphTool tool) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(null, null, null, null, null, workspace.toString())),
                null);
        connection.useCodeGraphTool(tool);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        return connection;
    }

    private static void await(String what, BooleanSupplier condition) {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > until) {
                throw new AssertionError("timed out waiting for " + what);
            }
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError(e);
            }
        }
    }

    private static List<JsonNode> frames(FakeSocket socket, String type) {
        List<JsonNode> out = new ArrayList<>();
        for (FakeSocket.Frame frame : socket.frames()) {
            try {
                JsonNode node = JSON.readTree(frame.payload());
                if (type.equals(node.path("type").asText())) {
                    out.add(node);
                }
            } catch (IOException ignored) {
                // not a frame of interest
            }
        }
        return out;
    }

    private static String errors(FakeSocket socket) {
        return frames(socket, "error").toString();
    }

    @Test
    void aFolderWithoutAGraphIsRefusedWithTheWayToBuildOne(@TempDir Path workspace) throws Exception {
        FakeSocket socket = new FakeSocket("ws-587-a", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, installed());
        try {
            connection.onGraphAsk("who calls PlaybookRunner.step");

            assertThat(errors(socket)).contains("/graph build");
            Thread.sleep(200);
            assertThat(requests).as("nothing reached the model").isEmpty();
            assertThat(frames(socket, "run_start")).isEmpty();
        } finally {
            connection.onClose();
        }
    }

    @Test
    void aMachineWithoutTheProgramIsRefusedWithItsInstallLine(@TempDir Path workspace) throws Exception {
        FakeSocket socket = new FakeSocket("ws-587-b", "ws://localhost/ws");
        SessionConnection connection = session(socket, withGraph(workspace), missing());
        try {
            connection.onGraphAsk("who calls PlaybookRunner.step");

            assertThat(errors(socket)).contains(CodeGraphBackend.GRAPHIFY.install()).contains("/graph build");
            assertThat(frames(socket, "run_start")).isEmpty();
        } finally {
            connection.onClose();
        }
    }

    @Test
    void anEmptyQuestionIsAnsweredWithTheUsage(@TempDir Path workspace) throws Exception {
        FakeSocket socket = new FakeSocket("ws-587-c", "ws://localhost/ws");
        SessionConnection connection = session(socket, withGraph(workspace), installed());
        try {
            connection.onGraphAsk("   ");

            assertThat(errors(socket)).contains("/graph ask <question>");
            assertThat(frames(socket, "run_start")).isEmpty();
        } finally {
            connection.onClose();
        }
    }

    @Test
    void aFolderWithAGraphRunsTheQuestionWithTheLineThatNamesTheTool(@TempDir Path workspace) throws Exception {
        FakeSocket socket = new FakeSocket("ws-587-d", "ws://localhost/ws");
        SessionConnection connection = session(socket, withGraph(workspace), installed());
        try {
            connection.onGraphAsk("who calls PlaybookRunner.step");
            await("the run's end", () -> !frames(socket, "run_end").isEmpty());

            assertThat(errors(socket)).isEqualTo("[]");
            assertThat(frames(socket, "run_start").get(0).path("prompt").asText())
                    .as("the record keeps the command as typed")
                    .isEqualTo("/graph ask who calls PlaybookRunner.step");
            JsonNode messages = requests.get(0).path("messages");
            String asked = messages.get(messages.size() - 1).path("content").asText();
            // Read against the line itself, not against modelText: a test that
            // asks the code under test for its expectation agrees with any bug.
            assertThat(asked).as("the model reads the question and the line")
                    .startsWith("who calls PlaybookRunner.step").contains(CodeGraphAsk.LINE);
            assertThat(requests.get(0).toString()).as("the tool is on the request").contains("\"code_graph\"");
        } finally {
            connection.onClose();
        }
    }

    @Test
    void theAppsCodeGraphSkillIsOfferedWhileTheFolderHasAGraph(@TempDir Path base) throws Exception {
        Path graphed = withGraph(Files.createDirectories(base.resolve("graphed")));
        Path bare = Files.createDirectories(base.resolve("bare"));

        FakeSocket withGraph = new FakeSocket("ws-587-e", "ws://localhost/ws");
        SessionConnection offered = session(withGraph, graphed, installed());
        FakeSocket withoutGraph = new FakeSocket("ws-587-f", "ws://localhost/ws");
        SessionConnection notOffered = session(withoutGraph, bare, installed());
        try {
            offered.onGetSessionItems();
            notOffered.onGetSessionItems();
            JsonNode items = frames(withGraph, "session_items").get(0).path("items");
            List<String> app = new ArrayList<>();
            for (JsonNode item : items) {
                if ("app".equals(item.path("source").asText())) {
                    app.add(item.path("name").asText() + ":" + item.path("kind").asText());
                }
            }
            assertThat(app).containsExactly(CodeGraphSkill.NAME + ":skill");
            assertThat(frames(withoutGraph, "session_items").get(0).path("items").toString())
                    .as("a folder without a graph has no code-graph skill")
                    .doesNotContain("\"" + CodeGraphSkill.NAME + "\"");

            offered.onUserMessage("hello", null);
            await("the run's end", () -> !frames(withGraph, "run_end").isEmpty());
            String system = requests.get(0).path("messages").get(0).path("content").asText();
            assertThat(system).as("the skill is listed for the model").contains(CodeGraphSkill.NAME);
        } finally {
            offered.onClose();
            notOffered.onClose();
        }
    }

    /**
     * Fix round, I3: {@code /graph ask} while a run is active is refused with
     * the run gate's sentence, and no second run starts.
     */
    @Test
    void aGraphAskWhileARunIsActiveIsRefusedAndStartsNoSecondRun(@TempDir Path workspace) throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        hold = held;
        FakeSocket socket = new FakeSocket("ws-587-g", "ws://localhost/ws");
        SessionConnection connection = session(socket, withGraph(workspace), installed());
        try {
            connection.onUserMessage("first question", null);
            await("the first turn at the backend", () -> !requests.isEmpty());

            connection.onGraphAsk("who calls PlaybookRunner.step");
            assertThat(errors(socket)).contains(SessionConnection.RUN_ACTIVE);

            held.countDown();
            await("the first run's end", () -> !frames(socket, "run_end").isEmpty());
            Thread.sleep(200);
            assertThat(frames(socket, "run_start")).as("one run, the first").hasSize(1);
            assertThat(requests).as("the question never reached the model").hasSize(1);
        } finally {
            held.countDown();
            hold = null;
            connection.onClose();
        }
    }

    /**
     * Fix round, I3: the page's {@code graph_ask} frame reaches the session
     * through the socket by its name and its field {@code question}. A frame
     * whose question sits under another field is answered with the usage.
     */
    @Test
    void theSocketRoutesTheGraphAskFrameByItsNameAndItsField() {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-587-route", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                "{\"type\":\"graph_ask\",\"question\":\"who calls PlaybookRunner.step\"}"));
        assertThat(socket.textJoined()).doesNotContain("Unknown message type")
                .as("the question arrived: the answer is about the folder, not the usage")
                .doesNotContain(CodeGraphAsk.USAGE).contains("/graph build");

        handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                "{\"type\":\"graph_ask\",\"text\":\"who calls PlaybookRunner.step\"}"));
        assertThat(socket.textJoined()).contains(CodeGraphAsk.USAGE);
    }

    /**
     * Fix round, I3 and M12: in one session the code-graph skill comes with the
     * graph and goes with it, in the list the page asks for and, unasked, in
     * the list the session sends again when the live sessions look (a build
     * that ends, and a timer for a graph built or deleted elsewhere).
     */
    @Test
    void theSkillComesWithTheGraphAndGoesWithItInOneSession(@TempDir Path workspace) throws Exception {
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-587-h", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(null, null, null, null, null, workspace.toString())),
                null, null, live);
        connection.useCodeGraphTool(installed());
        // The look runs on the calling thread here, so each step reads its frame
        // at once; aSlowClientHoldsUpNeitherTheLookNorTheOtherSessions pins the
        // hand-off to the session's own thread.
        connection.useCodeGraphLook(Runnable::run);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        try {
            connection.onGetSessionItems();
            assertThat(itemsOf(socket, 0)).doesNotContain("\"" + CodeGraphSkill.NAME + "\"");
            live.checkCodeGraphs();
            assertThat(frames(socket, "session_items")).as("nothing changed, nothing is sent").hasSize(1);

            withGraph(workspace);
            live.checkCodeGraphs();
            assertThat(frames(socket, "session_items")).as("the build's graph is announced").hasSize(2);
            assertThat(itemsOf(socket, 1)).contains("\"" + CodeGraphSkill.NAME + "\"");
            connection.onGetSessionItems();
            assertThat(itemsOf(socket, 2)).as("and the page's own ask sees it").contains("\"" + CodeGraphSkill.NAME + "\"");

            deleteGraph(workspace);
            live.checkCodeGraphs();
            assertThat(frames(socket, "session_items")).as("the deletion is announced").hasSize(4);
            assertThat(itemsOf(socket, 3)).doesNotContain("\"" + CodeGraphSkill.NAME + "\"");
            connection.onGetSessionItems();
            assertThat(itemsOf(socket, 4)).doesNotContain("\"" + CodeGraphSkill.NAME + "\"");
        } finally {
            connection.onClose();
        }
        withGraph(workspace);
        live.checkCodeGraphs();
        assertThat(frames(socket, "session_items")).as("a closed session is asked no more, even when its "
                + "folder's graph comes back").hasSize(5);
    }

    private static final CodeGraphBackend DEMO = new CodeGraphBackend("demograph", "demo-graph",
            "brew install demo-graph", Path.of("demo-out", "g.json"), Path.of("demo-out", "g.html"));

    private static boolean same(Path a, Path b) {
        try {
            return a != null && b != null && Files.isSameFile(a, b);
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Fix round, I4: the session asks which backend its own folder uses, also
     * before its session moment; the skill offer and {@code /graph ask} follow
     * that backend's files.
     */
    @Test
    void theSessionAsksTheBackendOfItsOwnFolderAlsoBeforeItsSessionMoment(@TempDir Path workspace)
            throws Exception {
        Files.createDirectories(workspace.resolve("demo-out"));
        Files.writeString(workspace.resolve("demo-out/g.json"), "{}");
        Files.writeString(workspace.resolve("demo-out/g.html"), "<html></html>");
        List<Path> asked = new CopyOnWriteArrayList<>();
        CodeGraphTool perFolder = new CodeGraphTool(folder -> {
            asked.add(folder == null ? Path.of("<none>") : folder);
            return same(folder, workspace) ? DEMO : CodeGraphBackend.GRAPHIFY;
        }, backend -> Optional.of("/opt/tools/" + backend.binary()),
                (argv, workdir, signal) -> new CodeGraphTool.Outcome("Engine.run", 0, false, false, false));
        FakeSocket socket = new FakeSocket("ws-587-i", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(null, null, null, null, null, workspace.toString())),
                null);
        connection.useCodeGraphTool(perFolder);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        try {
            connection.onGetSessionItems();
            assertThat(itemsOf(socket, 0)).as("offered before the session moment, on the folder's backend")
                    .contains("\"" + CodeGraphSkill.NAME + "\"");
            assertThat(asked).anyMatch(folder -> same(folder, workspace));

            connection.adoptSessionConfig();
            connection.onGraphAsk("who calls PlaybookRunner.step");
            await("the run's end", () -> !frames(socket, "run_end").isEmpty());
            assertThat(errors(socket)).isEqualTo("[]");
        } finally {
            connection.onClose();
        }
    }

    private SessionConnection liveSession(FakeSocket socket, Path workspace, LiveSessions live) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(null, null, null, null, null, workspace.toString())),
                null, null, live);
        connection.useCodeGraphTool(installed());
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        return connection;
    }

    /**
     * Round 2 (N1): the shared look never writes to a socket itself. It hands
     * each session's look to that session's own thread, so a client that
     * takes seconds per frame holds up neither the look nor the other
     * sessions, which hear of their graph at once.
     */
    @Test
    void aSlowClientHoldsUpNeitherTheLookNorTheOtherSessions(@TempDir Path base) throws Exception {
        LiveSessions live = new LiveSessions();
        Path slowFolder = Files.createDirectories(base.resolve("slow"));
        Path quickFolder = Files.createDirectories(base.resolve("quick"));
        FakeSocket slowSocket = new FakeSocket("ws-587-slow", "ws://localhost/ws");
        FakeSocket quickSocket = new FakeSocket("ws-587-quick", "ws://localhost/ws");
        SessionConnection slow = liveSession(slowSocket, slowFolder, live);
        SessionConnection quick = liveSession(quickSocket, quickFolder, live);
        try {
            slow.onGetSessionItems();
            quick.onGetSessionItems();
            withGraph(slowFolder);
            withGraph(quickFolder);
            slowSocket.costPerFrame(java.time.Duration.ofSeconds(3));

            long start = System.nanoTime();
            live.checkCodeGraphs();
            long lookMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
            await("the quick session's new list", () -> frames(quickSocket, "session_items").size() == 2);
            long quickMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

            assertThat(lookMillis).as("the shared look hands the work on").isLessThan(1_000);
            assertThat(quickMillis).as("the quick session does not wait for the slow one").isLessThan(2_000);
            assertThat(itemsOf(quickSocket, 1)).contains("\"" + CodeGraphSkill.NAME + "\"");
        } finally {
            slowSocket.costPerFrame(java.time.Duration.ZERO);
            slow.onClose();
            quick.onClose();
        }
        await("the slow session's list once its client caught up",
                () -> frames(slowSocket, "session_items").size() == 2);
    }

    /** Counts the looks a connection hands on, and how many of them ended. */
    private static final class CountingLook implements java.util.concurrent.Executor {
        final java.util.concurrent.atomic.AtomicInteger started = new java.util.concurrent.atomic.AtomicInteger();
        final java.util.concurrent.atomic.AtomicInteger ended = new java.util.concurrent.atomic.AtomicInteger();

        @Override
        public void execute(Runnable look) {
            started.incrementAndGet();
            Thread.ofVirtual().name("test-codegraph-look").start(() -> {
                try {
                    look.run();
                } finally {
                    ended.incrementAndGet();
                }
            });
        }
    }

    /**
     * Round 3 (N5): one look per connection is on its way at a time. While a
     * slow client keeps a session's look waiting on its write, the next tick
     * starts no second look for that session, which on JDK 21 would hold a
     * carrier thread for as long as it waits; a healthy session still gets
     * its look on every tick.
     */
    @Test
    void aLookStuckOnASlowClientIsNotJoinedByAnotherWhileAHealthySessionGetsEveryLook(@TempDir Path base)
            throws Exception {
        LiveSessions live = new LiveSessions();
        Path slowFolder = Files.createDirectories(base.resolve("slow"));
        Path healthyFolder = Files.createDirectories(base.resolve("healthy"));
        FakeSocket slowSocket = new FakeSocket("ws-587-stuck", "ws://localhost/ws");
        FakeSocket healthySocket = new FakeSocket("ws-587-healthy", "ws://localhost/ws");
        CountingLook slowLooks = new CountingLook();
        CountingLook healthyLooks = new CountingLook();
        SessionConnection slow = liveSession(slowSocket, slowFolder, live);
        SessionConnection healthy = liveSession(healthySocket, healthyFolder, live);
        slow.useCodeGraphLook(slowLooks);
        healthy.useCodeGraphLook(healthyLooks);
        try {
            slow.onGetSessionItems();
            healthy.onGetSessionItems();
            withGraph(slowFolder);
            withGraph(healthyFolder);
            slowSocket.costPerFrame(java.time.Duration.ofSeconds(5));

            live.checkCodeGraphs();
            await("the healthy session's first look", () -> healthyLooks.ended.get() == 1);
            assertThat(frames(healthySocket, "session_items")).hasSize(2);

            live.checkCodeGraphs();
            live.checkCodeGraphs();
            await("the healthy session's further looks", () -> healthyLooks.ended.get() >= 2);
            assertThat(slowLooks.ended.get()).as("premise: the slow look is still waiting on its client").isZero();
            assertThat(slowLooks.started.get()).as("one look for the slow session, however often it ticks")
                    .isEqualTo(1);
            assertThat(healthyLooks.started.get()).as("the healthy session got a look on the ticks after")
                    .isGreaterThanOrEqualTo(2);
        } finally {
            slowSocket.costPerFrame(java.time.Duration.ZERO);
            slow.onClose();
            healthy.onClose();
        }
    }
}
