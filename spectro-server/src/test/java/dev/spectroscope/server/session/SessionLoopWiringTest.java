package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.goal.GoalStore;
import dev.spectroscope.core.loop.LoopDriver;
import dev.spectroscope.core.loop.LoopPrompts;
import dev.spectroscope.core.loop.LoopSidecar;
import dev.spectroscope.core.loop.WakeupTimer;
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
import java.util.Comparator;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 504 on the browser session: {@code /loop} through {@code set_loop},
 * the server process holding the wakeup, {@code loop_info} for the page,
 * {@code schedule_wakeup} on the belt, Stop, a closed socket that holds the
 * wakeup until a client reattaches, and the goal's two listeners.
 *
 * <p>The provider is a scripted Ollama on loopback; the wakeups run on a
 * hand-moved timer, so the test says when time passes.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionLoopWiringTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long T0 = 1_800_000_000_000L;

    private HttpServer mock;
    private final List<JsonNode> requests = new CopyOnWriteArrayList<>();
    private final Queue<String> script = new ConcurrentLinkedQueue<>();
    private volatile int status = 200;
    private String previousSettings;
    private final HandTimer timer = new HandTimer(T0);
    private SessionLoops loops;

    /** A wakeup timer moved by hand. */
    static final class HandTimer implements WakeupTimer, java.util.function.LongSupplier {
        private long now;
        private final List<Object[]> tasks = new ArrayList<>();

        HandTimer(long start) {
            now = start;
        }

        @Override
        public synchronized long getAsLong() {
            return now;
        }

        @Override
        public synchronized Cancellable schedule(Runnable task, long delayMs) {
            Object[] entry = {now + Math.max(0, delayMs), task, Boolean.FALSE};
            tasks.add(entry);
            return () -> {
                synchronized (HandTimer.this) {
                    entry[2] = Boolean.TRUE;
                }
            };
        }

        void advanceTo(long to) {
            while (true) {
                Object[] next;
                synchronized (this) {
                    next = tasks.stream().filter(t -> !(Boolean) t[2] && (Long) t[0] <= to)
                            .min(Comparator.comparingLong(t -> (Long) t[0])).orElse(null);
                    if (next == null) {
                        now = Math.max(now, to);
                        return;
                    }
                    now = Math.max(now, (Long) next[0]);
                    next[2] = Boolean.TRUE;
                }
                ((Runnable) next[1]).run();
            }
        }
    }

    @BeforeEach
    void startBackend(@TempDir Path loopsDir) throws IOException {
        loops = new SessionLoops(timer, timer, new LoopSidecar(loopsDir));
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (TitleRequests.isTitleRequest(body)) {
                TitleRequests.answer(exchange);
                return;
            }
            requests.add(JSON.readTree(body));
            if (status != 200) {
                byte[] error = "{\"error\":\"model 'qwen9:404b' not found\"}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, error.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(error);
                }
                return;
            }
            String next = script.poll();
            String ndjson = next != null ? next : """
                    {"message":{"content":"Done."},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                    """;
            byte[] answer = ndjson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        mock.start();
        Path file = SettingsWriter.userSettingsFile();
        previousSettings = Files.exists(file) ? Files.readString(file) : null;
        writeSettings("");
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

    private void writeSettings(String extra) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{\"provider\":\"ollama\",\"model\":\"qwen2.5:7b\",\"baseUrl\":\"http://127.0.0.1:"
                + mock.getAddress().getPort() + "\",\"permissionMode\":\"auto\"" + extra + "}");
    }

    private static String toolCall(String name, String argumentsJson) {
        return """
                {"message":{"content":"","tool_calls":[{"function":{"name":"%s","arguments":%s}}]},"done":false}
                {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                """.formatted(name, argumentsJson);
    }

    private SessionConnection session(FakeSocket socket, Path workspace, String resumeId) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(null, null, null, null, null, workspace.toString())),
                resumeId);
        connection.useLoops(loops);
        connection.start();
        if (resumeId == null) {
            connection.onSetWorkspace("set", workspace.toString());
        }
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

    private static JsonNode lastLoopInfo(FakeSocket socket) {
        List<JsonNode> infos = frames(socket, "loop_info");
        return infos.isEmpty() ? null : infos.get(infos.size() - 1);
    }

    private static long runEnds(FakeSocket socket) {
        return frames(socket, "run_end").size();
    }

    private static JsonNode loopStart(String prompt, Integer interval) {
        var frame = JSON.createObjectNode().put("type", "set_loop").put("action", "start").put("prompt", prompt);
        if (interval != null) {
            frame.put("intervalSeconds", interval);
        }
        return frame;
    }

    private static List<String> toolNames(JsonNode request) {
        List<String> names = new ArrayList<>();
        request.path("tools").forEach(tool -> names.add(tool.path("function").path("name").asText()));
        return names;
    }

    private static String lastUserText(JsonNode request) {
        String text = "";
        for (JsonNode message : request.path("messages")) {
            if ("user".equals(message.path("role").asText())) {
                text = message.path("content").asText();
            }
        }
        return text;
    }

    // ── criterion 6 on the server ───────────────────────────────────────

    @Test
    void aLoopWithAnIntervalRunsNowAndTheServersTimerFiresItAgain(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-504-fixed", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onSetLoop(loopStart("check the build", 120));
        await("the first run", () -> runEnds(socket) == 1);
        assertThat(lastUserText(requests.get(0))).startsWith("check the build");
        JsonNode info = lastLoopInfo(socket);
        assertThat(info).isNotNull();
        assertThat(info.path("active").asBoolean()).isTrue();
        assertThat(info.path("pacing").asText()).isEqualTo("fixed");
        assertThat(info.path("maxTurns").asInt()).isPositive();
        assertThat(info.path("sessionId").asText()).isEqualTo(connection.sessionId());
        long next = info.path("nextAt").asLong();
        assertThat(next).isGreaterThanOrEqualTo(T0 + 120_000).isLessThan(T0 + 180_000);

        timer.advanceTo(next);
        await("the fired run", () -> runEnds(socket) == 2);
        assertThat(lastUserText(requests.get(1))).startsWith("check the build");
        assertThat(lastLoopInfo(socket).path("fires").asInt()).isEqualTo(1);
    }

    @Test
    void anIntervalAboveTheIntRangeIsClampedDownToAnHourNotWrappedUpToAMinute(@TempDir Path workspace) {
        // Fix round 1: /loop 1000000h is 3,600,000,000 s; an int cast wrapped it
        // to -694,967,296, which the clamp then raised to 60.
        FakeSocket socket = new FakeSocket("ws-504-huge", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onSetLoop(JSON.createObjectNode().put("type", "set_loop").put("action", "start")
                .put("prompt", "check").put("intervalSeconds", 3_600_000_000L));
        await("the first run", () -> runEnds(socket) == 1);
        assertThat(lastLoopInfo(socket).path("intervalSeconds").asInt()).isEqualTo(3600);
        connection.onSetLoop(JSON.createObjectNode().put("type", "set_loop").put("action", "stop"));
        connection.onSetLoop(JSON.createObjectNode().put("type", "set_loop").put("action", "start")
                .put("prompt", "check").put("intervalSeconds", -3_600_000_000L));
        await("the second run", () -> runEnds(socket) == 2);
        assertThat(lastLoopInfo(socket).path("intervalSeconds").asInt()).as("below the range: the minimum")
                .isEqualTo(60);
    }

    @Test
    void scheduleWakeupIsOnTheBeltAndOfferedOnlyWhileALoopRuns(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-504-offer", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onUserMessage("hello", null);
        await("the plain run", () -> runEnds(socket) == 1);
        assertThat(connection.belt().get("schedule_wakeup")).as("registered on the session's belt").isPresent();
        assertThat(toolNames(requests.get(0))).as("not offered without a loop").doesNotContain("schedule_wakeup");
        connection.onSetLoop(loopStart("watch the build", null));
        await("the loop's run", () -> runEnds(socket) == 2);
        assertThat(toolNames(requests.get(1))).contains("schedule_wakeup");
        assertThat(lastUserText(requests.get(1))).contains("schedule_wakeup").contains(LoopPrompts.SENTINEL);
    }

    @Test
    void theModelPacesTheLoopWithScheduleWakeupAndTheSentinelExpands(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-504-self", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        script.add(toolCall("schedule_wakeup",
                "{\"delaySeconds\":120,\"reason\":\"the build takes two minutes\",\"prompt\":\"<<loop>>\"}"));
        connection.onSetLoop(loopStart("watch the build", null));
        await("the first run", () -> runEnds(socket) == 1);
        JsonNode info = lastLoopInfo(socket);
        assertThat(info.path("reason").asText()).isEqualTo("the build takes two minutes");
        assertThat(info.path("keepalive").asBoolean()).isFalse();

        timer.advanceTo(info.path("nextAt").asLong());
        await("the fired run", () -> runEnds(socket) == 2);
        // Fix round 1: the round that armed the wakeup ends the first run, so
        // the fired run's request is the second, not the third.
        assertThat(requests).hasSize(2);
        assertThat(lastUserText(requests.get(1))).startsWith(LoopPrompts.FULL_HEADING).contains("watch the build");
        List<JsonNode> runStarts = frames(socket, "run_start");
        assertThat(runStarts.get(runStarts.size() - 1).path("prompt").asText())
                .as("the record shows the loop's task, not the sentinel").isEqualTo("watch the build");
        assertThat(loops.sidecar().read(connection.sessionId()).stream().map(l -> l.path("type").asText()))
                .contains("loop_start", "wakeup_armed", "loop_fire");
    }

    /**
     * Fix round 2: a self paced loop whose first fire delivered the full
     * instructions and armed the next wakeup; the caller then does what the
     * test is about, and the next fire is returned.
     */
    private long nextFireAfter(SessionConnection connection, FakeSocket socket, Runnable between) {
        String wakeup = "{\"delaySeconds\":120,\"reason\":\"two minutes\",\"prompt\":\"<<loop>>\"}";
        script.add(toolCall("schedule_wakeup", wakeup));
        script.add(toolCall("schedule_wakeup", wakeup));
        connection.onSetLoop(loopStart("watch the build", null));
        await("the first run", () -> runEnds(socket) == 1);
        timer.advanceTo(lastLoopInfo(socket).path("nextAt").asLong());
        await("the first fire", () -> runEnds(socket) == 2);
        assertThat(lastUserText(requests.get(1))).as("premise: the first fire was the full text")
                .startsWith(LoopPrompts.FULL_HEADING);
        long next = lastLoopInfo(socket).path("nextAt").asLong();
        between.run();
        return next;
    }

    @Test
    void afterAClearInTheChatTheNextFireCarriesTheFullInstructions(@TempDir Path workspace) {
        // The agent's history is gone after /clear, so a reminder that points
        // at "the loop instructions given earlier" points at nothing.
        FakeSocket socket = new FakeSocket("ws-504-clear", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        long next = nextFireAfter(connection, socket, () -> await("the clear", () -> {
            // run_end reaches the socket before the run's finally frees the
            // session, so a /clear right after it may still meet the run.
            if (frames(socket, "context_cleared").isEmpty()) {
                connection.onClearContext();
            }
            return !frames(socket, "context_cleared").isEmpty();
        }));
        timer.advanceTo(next);
        await("the fire after /clear", () -> runEnds(socket) == 3);
        assertThat(lastUserText(requests.get(2))).startsWith(LoopPrompts.FULL_HEADING).contains("watch the build");
    }

    @Test
    void afterAReattachTheNextFireCarriesTheFullInstructions(@TempDir Path workspace) {
        // A reattached socket builds its agent from the session file, where
        // the record holds the loop's task and not the model's expansion.
        FakeSocket first = new FakeSocket("ws-504-reattach-a", "ws://localhost/ws");
        SessionConnection connection = session(first, workspace, null);
        long next = nextFireAfter(connection, first, () -> {
            first.close();
            connection.onClose();
        });
        FakeSocket second = new FakeSocket("ws-504-reattach-b", "ws://localhost/ws");
        session(second, workspace, connection.sessionId());
        timer.advanceTo(next);
        await("the fire after the reattach", () -> runEnds(second) == 1);
        assertThat(lastUserText(requests.get(2))).startsWith(LoopPrompts.FULL_HEADING).contains("watch the build");
    }

    @Test
    void withoutAClearOrAReattachTheNextFireIsTheReminder(@TempDir Path workspace) {
        // The positive beside the two above: the reset is not unconditional.
        FakeSocket socket = new FakeSocket("ws-504-reminder", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        long next = nextFireAfter(connection, socket, () -> { });
        timer.advanceTo(next);
        await("the second fire", () -> runEnds(socket) == 3);
        assertThat(lastUserText(requests.get(2))).startsWith(LoopPrompts.REMINDER_HEADING);
    }

    @Test
    void aWakeupPromptTheModelWroteIsAttributedInTheRecordAndToTheModel(@TempDir Path workspace) {
        // Fix round 1: run_start.prompt is what the chat shows as the operator's bubble.
        FakeSocket socket = new FakeSocket("ws-504-verbatim", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        script.add(toolCall("schedule_wakeup",
                "{\"delaySeconds\":60,\"reason\":\"r\",\"prompt\":\"push the release tag\"}"));
        connection.onSetLoop(loopStart("watch the build", null));
        await("the first run", () -> runEnds(socket) == 1);
        timer.advanceTo(lastLoopInfo(socket).path("nextAt").asLong());
        await("the fired run", () -> runEnds(socket) == 2);
        List<JsonNode> runStarts = frames(socket, "run_start");
        String record = runStarts.get(runStarts.size() - 1).path("prompt").asText();
        assertThat(record).startsWith(LoopPrompts.MODEL_WRITTEN_HEADING)
                .contains("the operator did not type it").endsWith("push the release tag");
        assertThat(lastUserText(requests.get(requests.size() - 1))).startsWith(record);
    }

    // ── criterion 9: Stop, the chip, the setting ────────────────────────

    @Test
    void stopInTheChatEndsTheLoopAsUserAbort(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-504-stop", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onSetLoop(loopStart("check", 120));
        await("the first run", () -> runEnds(socket) == 1);
        connection.onStopFrame();
        assertThat(lastLoopInfo(socket).path("active").asBoolean()).isFalse();
        assertThat(lastLoopInfo(socket).path("endedReason").asText()).isEqualTo(LoopDriver.USER_ABORT);
        timer.advanceTo(T0 + 3_600_000);
        assertThat(requests).hasSize(1);
    }

    @Test
    void theChipsStopEndsTheLoopAsUserAbort(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-504-chip", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onSetLoop(loopStart("check", 120));
        await("the first run", () -> runEnds(socket) == 1);
        connection.onSetLoop(JSON.createObjectNode().put("type", "set_loop").put("action", "stop"));
        assertThat(lastLoopInfo(socket).path("endedReason").asText()).isEqualTo(LoopDriver.USER_ABORT);
    }

    @Test
    void messagingOffLeavesTheLoopRunning(@TempDir Path workspace) throws IOException {
        writeSettings(",\"agentMessaging\":false");
        FakeSocket socket = new FakeSocket("ws-504-messaging", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onSetLoop(loopStart("check", 120));
        await("the first run", () -> runEnds(socket) == 1);
        assertThat(toolNames(requests.get(0))).as("premise: messaging is off").doesNotContain("send_message");
        timer.advanceTo(lastLoopInfo(socket).path("nextAt").asLong());
        await("the fired run", () -> runEnds(socket) == 2);
        assertThat(lastLoopInfo(socket).path("active").asBoolean()).isTrue();
    }

    @Test
    void aLoopWithoutAPromptAnswersWithTheUsage(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-504-busy", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onSetLoop(JSON.createObjectNode().put("type", "set_loop").put("action", "start").put("prompt", " "));
        assertThat(frames(socket, "error").get(0).path("message").asText()).startsWith("Usage: /loop");
    }

    // ── criterion 11: a session without a client is not live ────────────

    @Test
    void aWakeupDueWhileTheSocketIsClosedIsHeldAndFiresWhenAClientReattaches(@TempDir Path workspace) {
        FakeSocket first = new FakeSocket("ws-504-held-a", "ws://localhost/ws");
        SessionConnection connection = session(first, workspace, null);
        connection.onSetLoop(loopStart("check", 120));
        await("the first run", () -> runEnds(first) == 1);
        String id = connection.sessionId();
        long next = lastLoopInfo(first).path("nextAt").asLong();
        first.close();
        connection.onClose();

        timer.advanceTo(next + 600_000);
        assertThat(requests).as("no run while nobody is attached").hasSize(1);
        assertThat(loops.sidecar().read(id).stream().map(l -> l.path("type").asText())).contains("loop_held");

        FakeSocket second = new FakeSocket("ws-504-held-b", "ws://localhost/ws");
        session(second, workspace, id);
        await("the held run on reattach", () -> runEnds(second) == 1);
        assertThat(requests).hasSize(2);
    }

    @Test
    void aLoopThatEndedWhileTheSocketWasClosedIsToldToTheNextClientOnce(@TempDir Path workspace) {
        // Fix round 1: the end line of the chat came only from an active to
        // ended change the page saw; a loop that ended detached said nothing.
        FakeSocket first = new FakeSocket("ws-504-unseen-a", "ws://localhost/ws");
        SessionConnection connection = session(first, workspace, null);
        connection.onSetLoop(loopStart("check", 120));
        await("the first run", () -> runEnds(first) == 1);
        String id = connection.sessionId();
        first.close();
        connection.onClose();
        loops.existing(id).userAbort(); // any end while nobody is attached takes this path

        FakeSocket second = new FakeSocket("ws-504-unseen-b", "ws://localhost/ws");
        session(second, workspace, id);
        JsonNode told = lastLoopInfo(second);
        assertThat(told).isNotNull();
        assertThat(told.path("active").asBoolean()).isFalse();
        assertThat(told.path("endedReason").asText()).isEqualTo(LoopDriver.USER_ABORT);
        assertThat(told.path("endUnseen").asBoolean()).as("the page writes the end line it missed").isTrue();

        FakeSocket third = new FakeSocket("ws-504-unseen-c", "ws://localhost/ws");
        session(third, workspace, id);
        assertThat(lastLoopInfo(third).path("endUnseen").asBoolean()).as("told once").isFalse();
    }

    @Test
    void anEndNobodyHeardSurvivesAServerRestart(@TempDir Path workspace) {
        FakeSocket first = new FakeSocket("ws-504-restart-a", "ws://localhost/ws");
        SessionConnection connection = session(first, workspace, null);
        connection.onSetLoop(loopStart("check", 120));
        await("the first run", () -> runEnds(first) == 1);
        String id = connection.sessionId();
        first.close();
        connection.onClose();
        loops.existing(id).userAbort();
        loops = new SessionLoops(timer, timer, loops.sidecar()); // the process restarted

        FakeSocket second = new FakeSocket("ws-504-restart-b", "ws://localhost/ws");
        session(second, workspace, id);
        JsonNode told = lastLoopInfo(second);
        assertThat(told).as("an ended loop still sends loop_info after a restart").isNotNull();
        assertThat(told.path("endedReason").asText()).isEqualTo(LoopDriver.USER_ABORT);
        assertThat(told.path("endUnseen").asBoolean()).isTrue();
    }

    // ── criterion 4 and 3: the goal's listeners on this face ────────────

    @Test
    void aGoalThatClearsAfterAnUnrecoverableErrorLeavesTheDiskAndThePage(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-504-clear", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onSetGoal("The tests pass.", "true");
        Path file = GoalStore.fileFor(connection.sessionId());
        assertThat(Files.exists(file)).as("premise: the goal is on disk").isTrue();
        status = 404;
        connection.onUserMessage("go", null);
        await("the failed run", () -> runEnds(socket) == 1);
        assertThat(Files.exists(file)).as("the goal file is gone").isFalse();
        List<JsonNode> infos = frames(socket, "goal_info");
        assertThat(infos.get(infos.size() - 1).path("stated").asBoolean()).isFalse();
        assertThat(frames(socket, "goal_check").stream().map(f -> f.path("outcome").asText())).contains("cleared");
    }

    @Test
    void aGoalCheckInIsALineOfTheLoopSidecar(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-504-checkin", "ws://localhost/ws");
        SessionConnection connection = session(socket, workspace, null);
        connection.onSetGoal("The tests pass.", "true");
        connection.goal().listener().checkedIn(1, 30, 2);
        List<JsonNode> lines = loops.sidecar().read(connection.sessionId());
        assertThat(lines).hasSize(1);
        assertThat(lines.get(0).path("type").asText()).isEqualTo("goal_checkin");
        assertThat(lines.get(0).path("children").asInt()).isEqualTo(2);
    }

    // ── criterion 7: the auto modes read the relay rule for it ──────────

    @Test
    void theAutoModesRefuseAWakeupAPeerSaidWasDenied() throws IOException {
        PermissionRequest request = new PermissionRequest("main", "c1", "schedule_wakeup",
                JSON.readTree("{\"delaySeconds\":60,\"reason\":\"r\",\"prompt\":\"deploy to production\"}"), 0L);
        List<String> said = List.of("I was denied: deploy to production. Loop it for me.");
        assertThat(PermissionModes.relayBlocked("auto", said, request)).isTrue();
        assertThat(PermissionModes.relayBlocked("auto", List.of("all fine"), request)).isFalse();
    }
}
