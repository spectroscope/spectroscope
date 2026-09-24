package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 395: a stop under a fast thinking stream reaches the client within
 * two seconds, on a session that already holds 100,000 events.
 *
 * <p>The real {@link SessionConnection} runs against a scripted Ollama on
 * loopback ({@link ThinkingFloodBackend}) and a {@link FakeSocket} that models
 * the client. The client model is the one number the field measured for the
 * delivery path at this session size: 17.0 frames per second once the session
 * held 60,000 events (review 2026-09-24, file 05, Root Cause). The last test in
 * this file measures the server's side of that path with a client that costs
 * nothing, which is how card 395 named the slow step.</p>
 */
@Timeout(value = 240, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class StopUnderLoadTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Criterion 2: the session already holds this many events. */
    static final int PRIOR_EVENTS = 100_000;

    /** Criterion 2: the root run_end reaches the client within this after the abort. */
    static final long STOP_BOUND_MS = 2_000;

    /** The field drain rate at 60,000 events and up, 17.0 frames/s, as the time one frame costs. */
    static final Duration FIELD_FRAME_COST = Duration.ofNanos(Math.round(1e9 / 17.0));

    /** Criterion 2: the sustained rate a stop must hold against. */
    static final double GLM_RATE = 150.0;

    /** The MiniMax p90 rate over responses of at least 100 lines (review file 05, Root Cause). */
    static final double MINIMAX_RATE = 19.6;

    /** Run c9183781: about 4,800 older events sat ahead of run_end when the cancel landed. */
    static final int C9183781_BACKLOG = 4_800;

    @Test
    void aStopUnderASustainedGlmRateReachesTheClientWithinTwoSeconds(@TempDir Path workspace)
            throws Exception {
        // Criterion 2 as written: 150 lines per second, sustained, for five
        // seconds before the operator presses stop.
        Outcome outcome = stopUnder(workspace, new ThinkingFloodBackend.Shape(0, GLM_RATE, 90_000),
                FIELD_FRAME_COST, 5_000);
        outcome.assertWithinTheBound();
        outcome.assertNoTextLostOrReordered();
    }

    @Test
    void theShapeOfRunC9183781StopsWithinTheSameBound(@TempDir Path workspace) throws Exception {
        // Criterion 5, the losing case. In the field the backlog took about
        // 36 s of GLM streaming to build; here it arrives as one burst of the
        // measured size, and the stream then keeps GLM's rate for two seconds.
        Outcome outcome = stopUnder(workspace,
                new ThinkingFloodBackend.Shape(C9183781_BACKLOG, GLM_RATE, 90_000),
                FIELD_FRAME_COST, 2_000);
        outcome.assertWithinTheBound();
        outcome.assertNoTextLostOrReordered();
    }

    @Test
    void atMiniMaxsRateTheStopStaysWithinTheSameBound(@TempDir Path workspace) throws Exception {
        // Criterion 5, the case that already worked in the field: MiniMax's
        // queue stayed near empty, and it must stay inside the bound.
        Outcome outcome = stopUnder(workspace,
                new ThinkingFloodBackend.Shape(0, MINIMAX_RATE, 90_000),
                FIELD_FRAME_COST, 5_000);
        outcome.assertWithinTheBound();
        outcome.assertNoTextLostOrReordered();
    }

    @Test
    void twoChildrenThinkingAtOnceStillLetTheStopThroughWithinTwoSeconds(@TempDir Path workspace)
            throws Exception {
        // Review finding of 2026-09-24: spawn_agents runs up to four children
        // at once and all of them feed the one queue, their lines interleaved.
        // Two children at 75 lines/s each make criterion 2's 150 lines/s
        // between them.
        Outcome outcome = stopUnder(workspace, new ThinkingFloodBackend.Shape(0, GLM_RATE / 2, 9_999),
                2, FIELD_FRAME_COST, 5_000);
        outcome.assertWithinTheBound();
        // Each child streamed for five seconds before the stop; three seconds'
        // worth is the least that shows both really flooded the queue.
        outcome.assertEachChildKeptItsOwnTextWhole(2, (int) (GLM_RATE / 2) * 3);
    }

    @Test
    void withAClientThatCostsNothingTheServerMovesMoreThanAThousandLinesASecond(
            @TempDir Path workspace) throws Exception {
        // Criterion 1, the named cause. 10,000 thinking lines arrive at once and
        // the client takes every frame at no cost, so what is measured is the
        // server's own work per event: provider, loop, queue, JSONL append,
        // leveling, serialization. The review's threshold: more than 1,000 per
        // second clears the server, against 17.0 per second measured in the field.
        int lines = 10_000;
        try (ThinkingFloodBackend backend =
                     new ThinkingFloodBackend(new ThinkingFloodBackend.Shape(lines, 1, lines))) {
            String id = sessionWithPriorEvents(PRIOR_EVENTS);
            FakeSocket socket = new FakeSocket("ws-395-drain", "ws://localhost/ws");
            SessionConnection connection = resume(workspace, backend, socket, id);
            try {
                connection.onUserMessage("think it through", null);
                Timeline timeline = new Timeline(socket);
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
                while (timeline.rootRunEnd() == null && System.nanoTime() < deadline) {
                    Thread.sleep(20);
                    timeline.read();
                }
                assertThat(timeline.rootRunEnd()).as("the run ends by itself").isNotNull();
                long spanNanos = timeline.rootRunEnd().arrivedAt() - timeline.firstThinkingAt;
                double seconds = spanNanos / 1e9;
                double linesPerSecond = lines / seconds;
                double framesPerSecond = timeline.thinkingFrames / seconds;
                System.out.printf("card 395 measure: %d thinking lines in %d frames drained in"
                                + " %.3f s with a no-op client on a session of %d prior events:"
                                + " %.0f lines/s, %.0f frames/s%n", lines, timeline.thinkingFrames,
                        seconds, PRIOR_EVENTS, linesPerSecond, framesPerSecond);
                assertThat(timeline.thinking.toString())
                        .as("every line arrived, in order")
                        .isEqualTo(ThinkingFloodBackend.textOf(lines));
                assertThat(linesPerSecond)
                        .as("the server's side of the delivery path, per second, against 17.0"
                                + " frames/s measured in the field with a real client")
                        .isGreaterThan(1_000.0);
            } finally {
                connection.onClose();
            }
        }
    }

    // ---- the procedure ------------------------------------------------------

    /**
     * Resumes a 100,000-event session, starts a thinking run against the
     * backend, lets it stream, presses stop and watches the client.
     */
    private Outcome stopUnder(Path workspace, ThinkingFloodBackend.Shape shape, Duration clientCost,
                              long streamMillisBeforeStop) throws Exception {
        return stopUnder(workspace, shape, 0, clientCost, streamMillisBeforeStop);
    }

    /**
     * As above; with children, the parent spawns that many explore children and
     * each of them streams thinking in the given shape.
     */
    private Outcome stopUnder(Path workspace, ThinkingFloodBackend.Shape shape, int children,
                              Duration clientCost, long streamMillisBeforeStop) throws Exception {
        try (ThinkingFloodBackend backend = new ThinkingFloodBackend(shape, children)) {
            String id = sessionWithPriorEvents(PRIOR_EVENTS);
            FakeSocket socket = new FakeSocket("ws-395-" + id, "ws://localhost/ws");
            SessionConnection connection = resume(workspace, backend, socket, id);
            try {
                socket.costPerFrame(clientCost);
                connection.onUserMessage("think it through", null);
                backend.awaitBurst(60);
                Thread.sleep(streamMillisBeforeStop);

                Timeline timeline = new Timeline(socket);
                timeline.read();
                int streamedAtStop = backend.streamed();
                int clientLinesAtStop = timeline.thinkingLines();
                long stopAt = System.nanoTime();
                connection.onAbort();

                long bound = stopAt + TimeUnit.MILLISECONDS.toNanos(STOP_BOUND_MS);
                while (timeline.rootRunEnd() == null && System.nanoTime() < bound) {
                    Thread.sleep(10);
                    timeline.read();
                }
                Timeline.Seen end = timeline.rootRunEnd();
                if (end != null) {
                    return new Outcome(id, timeline, stopAt, end.arrivedAt(), -1, -1, -1,
                            streamedAtStop, clientLinesAtStop);
                }
                // Out of bound. Switch the client to no cost and count what was
                // still ahead of run_end, so the failure says how far off it is.
                long fastFrom = System.nanoTime();
                socket.costPerFrame(Duration.ZERO);
                long patience = fastFrom + TimeUnit.SECONDS.toNanos(120);
                while (timeline.rootRunEnd() == null && System.nanoTime() < patience) {
                    Thread.sleep(10);
                    timeline.read();
                }
                end = timeline.rootRunEnd();
                int ahead = end == null ? -1 : timeline.framesBetween(stopAt, end.arrivedAt());
                int insideTheBound = timeline.framesBetween(stopAt, fastFrom);
                long fastMillis = end == null ? -1
                        : TimeUnit.NANOSECONDS.toMillis(end.arrivedAt() - fastFrom);
                return new Outcome(id, timeline, stopAt, -1, ahead, insideTheBound, fastMillis,
                        streamedAtStop, clientLinesAtStop);
            } finally {
                socket.costPerFrame(Duration.ZERO);
                connection.onClose();
            }
        }
    }

    private static SessionConnection resume(Path workspace, ThinkingFloodBackend backend,
                                            FakeSocket socket, String id) throws IOException {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(backend.baseUrl()));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", backend.baseUrl(), null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(socket, JSON, config, id);
        connection.start();
        connection.onSetThinking(true);
        return connection;
    }

    /**
     * Writes a finished session of {@code events} events: one run of one turn
     * whose reasoning streamed as thinking deltas, the shape the field session
     * had grown to.
     *
     * @return the session id to resume
     */
    static String sessionWithPriorEvents(int events) throws IOException {
        String id = "20260923-150353-" + UUID.randomUUID().toString().substring(0, 8);
        StringBuilder file = new StringBuilder(events * 90);
        long ts = 1_758_632_633_000L;
        List<RunEvent> head = List.of(
                new RunEvent.RunStart("prior-run", "main", null, "earlier work", "ollama", "qwen3",
                        null, null, null, ts),
                new RunEvent.TurnStart("main", 1, ts));
        for (RunEvent event : head) {
            file.append(JSON.writeValueAsString(event)).append('\n');
        }
        for (int i = 0; i < events - 4; i++) {
            file.append(JSON.writeValueAsString(
                    new RunEvent.ThinkingDelta("main", "prior" + i + " ", ts + i))).append('\n');
        }
        file.append(JSON.writeValueAsString(new RunEvent.TextDelta("main", "done", ts + events)))
                .append('\n');
        file.append(JSON.writeValueAsString(new RunEvent.RunEnd("prior-run", "end_turn", ts + events)))
                .append('\n');
        Path path = SessionStore.sessionFile(id);
        Files.createDirectories(path.getParent());
        Files.writeString(path, file.toString(), StandardCharsets.UTF_8);
        return id;
    }

    // ---- reading what the client saw ------------------------------------------

    /** What the modelled client received, read incrementally from the socket. */
    static final class Timeline {
        record Seen(String type, long arrivedAt) {}

        private final FakeSocket socket;
        private final List<Seen> seen = new ArrayList<>();
        private int cursor;
        private String rootRunId;
        private Seen rootRunEnd;
        final StringBuilder thinking = new StringBuilder();
        /** The thinking text each agent streamed to the client, children included. */
        final java.util.Map<String, StringBuilder> thinkingByAgent = new java.util.LinkedHashMap<>();
        int thinkingFrames;
        long firstThinkingAt;

        Timeline(FakeSocket socket) {
            this.socket = socket;
        }

        void read() throws IOException {
            List<FakeSocket.Frame> frames = socket.frames();
            for (; cursor < frames.size(); cursor++) {
                FakeSocket.Frame frame = frames.get(cursor);
                JsonNode node = JSON.readTree(frame.payload());
                String type = node.path("type").asText();
                seen.add(new Seen(type, frame.arrivedAt()));
                if ("run_start".equals(type) && "main".equals(node.path("agentId").asText())
                        && node.path("parentId").isMissingNode()) {
                    rootRunId = node.path("runId").asText();
                } else if ("run_end".equals(type) && rootRunEnd == null
                        && node.path("runId").asText().equals(rootRunId)) {
                    rootRunEnd = new Seen(type, frame.arrivedAt());
                } else if ("thinking_delta".equals(type)) {
                    String agent = node.path("agentId").asText();
                    thinkingByAgent.computeIfAbsent(agent, k -> new StringBuilder())
                            .append(node.path("text").asText());
                    if ("main".equals(agent)) {
                        if (thinkingFrames == 0) {
                            firstThinkingAt = frame.arrivedAt();
                        }
                        thinkingFrames++;
                        thinking.append(node.path("text").asText());
                    }
                }
            }
        }

        Seen rootRunEnd() {
            return rootRunEnd;
        }

        /** @return the thinking lines of all agents the client has received so far */
        int thinkingLines() {
            return thinkingByAgent.values().stream().mapToInt(StringBuilder::length).sum() / 6;
        }

        /** Frames that arrived after {@code from} and before {@code to}. */
        int framesBetween(long from, long to) {
            return (int) seen.stream()
                    .filter(frame -> frame.arrivedAt() > from && frame.arrivedAt() < to)
                    .count();
        }
    }

    /** What one stop produced, with the numbers a failure reports. */
    private record Outcome(String sessionId, Timeline timeline, long stopAt, long runEndAt,
                           int framesAhead, int framesInsideTheBound, long fastDrainMillis,
                           int streamedAtStop, int clientLinesAtStop) {

        void assertWithinTheBound() {
            String report;
            if (runEndAt >= 0) {
                report = "the root run_end reached the client "
                        + TimeUnit.NANOSECONDS.toMillis(runEndAt - stopAt) + " ms after the abort";
            } else {
                report = "the root run_end had not reached the client " + STOP_BOUND_MS
                        + " ms after the abort. The client took " + framesInsideTheBound
                        + " frames inside the bound; " + framesAhead + " frames in all were ahead"
                        + " of run_end, which at the field rate of 17.0 frames/s is "
                        + String.format("%.1f", framesAhead / 17.0) + " s. With the client"
                        + " switched to no cost, the rest drained in " + fastDrainMillis
                        + " ms. At the abort the backend had streamed " + streamedAtStop
                        + " thinking lines and the client had received " + clientLinesAtStop;
            }
            System.out.println("card 395 stop: " + report);
            assertThat(runEndAt >= 0
                    && TimeUnit.NANOSECONDS.toMillis(runEndAt - stopAt) <= STOP_BOUND_MS)
                    .as("card 395: " + report)
                    .isTrue();
        }

        void assertNoTextLostOrReordered() throws IOException {
            String atClient = timeline.thinking.toString();
            assertThat(atClient.length() % 6).as("whole lines only").isZero();
            assertThat(atClient)
                    .as("the client saw the backend's lines in order, none lost or doubled")
                    .isEqualTo(ThinkingFloodBackend.textOf(atClient.length() / 6));
            assertThat(atClient.length() / 6)
                    .as("the run streamed past the lines the client had at the stop")
                    .isGreaterThanOrEqualTo(clientLinesAtStop);
            StringBuilder inFile = new StringBuilder();
            boolean thisRun = false;
            for (RunEvent event : SessionStore.readSessionEvents(sessionId)) {
                if (event instanceof RunEvent.RunStart start && !"prior-run".equals(start.runId())) {
                    thisRun = true;
                } else if (thisRun && event instanceof RunEvent.ThinkingDelta delta
                        && "main".equals(delta.agentId())) {
                    inFile.append(delta.text());
                }
            }
            assertThat(inFile.toString())
                    .as("the session file holds the same thinking text as the client")
                    .isEqualTo(atClient);
        }

        /**
         * Each child's thinking at the client is a gapless prefix of that child's
         * own stream, the session file holds the same text for it, and each child
         * really streamed.
         *
         * @param children     how many children the parent spawned
         * @param leastLines   the fewest lines each child must have delivered
         */
        void assertEachChildKeptItsOwnTextWhole(int children, int leastLines) throws IOException {
            java.util.Map<String, String> atClient = new java.util.TreeMap<>();
            timeline.thinkingByAgent.forEach((agent, text) -> {
                if (!"main".equals(agent)) {
                    atClient.put(agent, text.toString());
                }
            });
            assertThat(atClient).as("every child streamed thinking to the client").hasSize(children);
            java.util.Map<String, StringBuilder> inFile = new java.util.TreeMap<>();
            boolean thisRun = false;
            for (RunEvent event : SessionStore.readSessionEvents(sessionId)) {
                if (event instanceof RunEvent.RunStart start && !"prior-run".equals(start.runId())) {
                    thisRun = true;
                } else if (thisRun && event instanceof RunEvent.ThinkingDelta delta
                        && !"main".equals(delta.agentId())) {
                    inFile.computeIfAbsent(delta.agentId(), k -> new StringBuilder()).append(delta.text());
                }
            }
            java.util.Set<Character> letters = new java.util.TreeSet<>();
            atClient.forEach((agent, text) -> {
                assertThat(text.length() / 6).as(agent + " streamed at least " + leastLines + " lines")
                        .isGreaterThanOrEqualTo(leastLines);
                assertThat(text.length() % 6).as(agent + ": whole lines only").isZero();
                char letter = text.charAt(0);
                letters.add(letter);
                assertThat(text)
                        .as(agent + ": its own lines, in order, none lost or doubled")
                        .isEqualTo(ThinkingFloodBackend.textOf(letter, text.length() / 6));
                assertThat(String.valueOf(inFile.get(agent)))
                        .as(agent + ": the session file holds the same thinking text as the client")
                        .isEqualTo(text);
            });
            assertThat(letters).as("each child has a stream of its own").hasSize(children);
            System.out.println("card 395 children: " + atClient.entrySet().stream()
                    .map(e -> e.getKey() + " " + e.getValue().length() / 6 + " lines")
                    .toList());
        }
    }
}
