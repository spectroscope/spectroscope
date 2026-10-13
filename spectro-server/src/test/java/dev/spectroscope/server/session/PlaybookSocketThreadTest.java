package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.playbook.run.PlaybookRecorder;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import dev.spectroscope.server.providers.ProviderRow;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.socket.TextMessage;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 584, fix round (review D1, N1, N3, N6): the model list checks of the
 * start sheet never hold the session's socket thread. JSR-356 hands one
 * session's frames over one at a time, so a frame that waits for a provider
 * holds every frame behind it, {@code ping} and {@code abort} included. The
 * delivery is emulated with one thread that hands the frames to the real
 * {@link SpectroSocketHandler} in order, the reviewer's probe as a test.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class PlaybookSocketThreadTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TASK = "build a frogger clone";
    /** How long a frame queued behind a playbook frame may wait for the socket thread. */
    private static final long ANSWERED_WITHIN_MS = 200;

    /** A cheap step on anthropic, a private step on lmstudio, a command check. */
    private static final String TWO_STEPS = """
        { "schema_version": 1, "id": "k", "name": "K", "description": "d",
          "models": { "strong": { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" } },
                      "local":  { "primary": { "provider": "lmstudio", "model": "qwen3-8b" } } },
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

    private Path registered() throws Exception {
        Files.writeString(playbookDir.resolve("playbook.json"), TWO_STEPS);
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    private static String hash(Path dir) throws Exception {
        return PinnedPlaybook.pin(dir, PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).playbook())
                .hash();
    }

    /** Sleeps as a provider that never answers does, until the check is cancelled. */
    private static void hang(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt();
        }
    }

    private static ProviderRow listing(String p, String kind, String... models) {
        return new ProviderRow(p, kind, "reachable", false, null, "http://localhost:1", List.of(models), true, null,
                1L, null);
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

    private record Wired(SpectroSocketHandler handler, FakeSocket socket, SessionConnection connection) {
    }

    @SuppressWarnings("unchecked")
    private Wired wired(String id, Function<String, ProviderRow> check) throws Exception {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket(id, "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);
        Field f = SpectroSocketHandler.class.getDeclaredField("connections");
        f.setAccessible(true);
        SessionConnection connection = ((Map<String, SessionConnection>) f.get(handler)).get(socket.getId());
        connection.providerCheckForTest(check);
        connection.providerBuilderForTest(c -> says(c.model()));
        connection.keySourceForTest(p -> null);
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        return new Wired(handler, socket, connection);
    }

    private static List<JsonNode> frames(FakeSocket socket, String type) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        for (FakeSocket.Frame f : socket.frames()) {
            JsonNode n = JSON.readTree(f.payload());
            if (type.equals(n.path("type").asText())) {
                out.add(n);
            }
        }
        return out;
    }

    /** The milliseconds from each frame's hand-over to the end of its handling, for a ping and an abort. */
    private record Queued(long pingMs, long abortMs) {
    }

    /**
     * Hands {@code first} to the handler on the emulated socket thread, then a
     * ping and an abort right behind it, and measures how long each waited.
     */
    private static Queued queueBehind(Wired w, String first) throws Exception {
        ExecutorService socketThread = Executors.newSingleThreadExecutor();
        try {
            socketThread.submit(() -> w.handler().handleTextMessage(w.socket(), new TextMessage(first)));
            long pingAt = System.nanoTime();
            Future<Long> ping = socketThread.submit(() -> {
                w.handler().handleTextMessage(w.socket(), new TextMessage("{\"type\":\"ping\"}"));
                return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - pingAt);
            });
            long abortAt = System.nanoTime();
            Future<Long> abort = socketThread.submit(() -> {
                w.handler().handleTextMessage(w.socket(), new TextMessage("{\"type\":\"abort\"}"));
                return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - abortAt);
            });
            return new Queued(ping.get(60, TimeUnit.SECONDS), abort.get(60, TimeUnit.SECONDS));
        } finally {
            socketThread.shutdown();
        }
    }

    @Test
    void aPingAndAnAbortBehindConfirmPlaybookAreAnsweredWhileAProviderNeverAnswers() throws Exception {
        Path dir = registered();
        Wired w = wired("ws-584-d1-confirm", p -> {
            if ("llamacpp".equals(p)) {
                hang(600_000);
            }
            return listing(p, "local", "m");
        });
        long t0 = System.nanoTime();

        Queued queued = queueBehind(w, JSON.writeValueAsString(Map.of("type", "confirm_playbook",
                "dir", dir.toString(), "prompt", TASK)));

        System.out.println("CARD584 D1 confirm_playbook: ping answered after ms=" + queued.pingMs()
                + " ; abort handled after ms=" + queued.abortMs());
        assertThat(queued.pingMs()).as("ping behind confirm_playbook").isLessThan(ANSWERED_WITHIN_MS);
        assertThat(queued.abortMs()).as("abort behind confirm_playbook").isLessThan(ANSWERED_WITHIN_MS);
        assertThat(frames(w.socket(), "pong")).hasSize(1);
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (frames(w.socket(), "playbook_confirm").isEmpty() && System.nanoTime() < until) {
            Thread.sleep(20);
        }
        System.out.println("CARD584 D1 confirm_playbook: sheet frame after ms="
                + TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0));
        assertThat(frames(w.socket(), "playbook_confirm")).as("the sheet still opens").hasSize(1);
    }

    @Test
    void aPingAndAnAbortBehindStartPlaybookAreAnsweredWhileThePicksAreCheckedAgain() throws Exception {
        // Second fix round: the abort in the queue now stops the pending start
        // (the integrator's decision); before, the run went on after the check.
        Path dir = registered();
        Files.writeString(workspace.resolve("plan.md"), "## Tasks\n- one\n");
        Wired w = wired("ws-584-d1-start", p -> {
            if ("ollama".equals(p) || "lmstudio".equals(p)) {
                hang(1_000);
            }
            return listing(p, "local", "m1", "m2", "qwen3-8b");
        });
        w.connection().onSetPermissionMode("auto");
        String start = JSON.writeValueAsString(Map.of("type", "start_playbook", "dir", dir.toString(),
                "hash", hash(dir), "prompt", TASK,
                "picks", Map.of("write_plan", Map.of("provider", "ollama", "model", "m1"),
                        "tidy", Map.of("provider", "lmstudio", "model", "m2"))));

        Queued queued = queueBehind(w, start);

        System.out.println("CARD584 D1 start_playbook: ping answered after ms=" + queued.pingMs()
                + " ; abort handled after ms=" + queued.abortMs());
        assertThat(queued.pingMs()).as("ping behind start_playbook").isLessThan(ANSWERED_WITHIN_MS);
        assertThat(queued.abortMs()).as("abort behind start_playbook").isLessThan(ANSWERED_WITHIN_MS);
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (frames(w.socket(), "error").isEmpty() && System.nanoTime() < until) {
            Thread.sleep(20);
        }
        assertThat(frames(w.socket(), "error").stream().map(f -> f.path("message").asText()).toList())
                .as("the abort behind the start stopped it").containsExactly(SessionConnection.PLAYBOOK_START_STOPPED);
        assertThat(PlaybookRecorder.fileFor(w.connection().sessionId())).doesNotExist();
    }

    /**
     * Second fix round: a Stop while the picks are checked again cancels the
     * pending start. The abort is answered at once, the run never begins, the
     * slot is free again, and the chat and the sheet hear that the start was
     * stopped.
     */
    @Test
    void anAbortWhileThePicksAreCheckedAgainStopsTheStartBeforeAnyRun() throws Exception {
        Path dir = registered();
        Files.writeString(workspace.resolve("plan.md"), "## Tasks\n- one\n");
        Wired w = wired("ws-584-stop", p -> {
            if ("ollama".equals(p)) {
                hang(2_000);
            }
            return listing(p, "local", "m1", "qwen3-8b");
        });
        w.connection().onSetPermissionMode("auto");
        String start = JSON.writeValueAsString(Map.of("type", "start_playbook", "dir", dir.toString(),
                "hash", hash(dir), "prompt", TASK, "ask", "start-7",
                "picks", Map.of("write_plan", Map.of("provider", "ollama", "model", "m1"))));
        ExecutorService socketThread = Executors.newSingleThreadExecutor();
        long t0 = System.nanoTime();
        long abortMs;
        try {
            socketThread.submit(() -> w.handler().handleTextMessage(w.socket(), new TextMessage(start)));
            Thread.sleep(100);
            long abortAt = System.nanoTime();
            abortMs = socketThread.submit(() -> {
                w.handler().handleTextMessage(w.socket(), new TextMessage("{\"type\":\"abort\"}"));
                return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - abortAt);
            }).get(30, TimeUnit.SECONDS);
        } finally {
            socketThread.shutdown();
        }
        long stopWait = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (frames(w.socket(), "playbook_start_refused").isEmpty() && System.nanoTime() < stopWait) {
            Thread.sleep(10);
        }
        long stoppedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
        long left = TimeUnit.SECONDS.toMillis(3) - TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
        if (left > 0) {
            Thread.sleep(left);
        }

        System.out.println("CARD584 stop: abort handled after ms=" + abortMs + " ; start stopped after ms="
                + stoppedMs + " (the check of the pick takes 2,000)");
        assertThat(abortMs).as("the abort is answered at once").isLessThan(ANSWERED_WITHIN_MS);
        assertThat(stoppedMs).as("the Stop cuts the check short instead of waiting for it").isLessThan(1_000);
        assertThat(frames(w.socket(), "run_start")).as("no turn of a run began").isEmpty();
        assertThat(frames(w.socket(), "playbook_progress")).as("no playbook run began").isEmpty();
        assertThat(PlaybookRecorder.fileFor(w.connection().sessionId())).as("no sidecar").doesNotExist();
        assertThat(frames(w.socket(), "error").stream().map(f -> f.path("message").asText()).toList())
                .contains(SessionConnection.PLAYBOOK_START_STOPPED);
        assertThat(frames(w.socket(), "playbook_start_refused")).singleElement().satisfies(f -> {
            assertThat(f.path("ask").asText()).isEqualTo("start-7");
            assertThat(f.path("message").asText()).isEqualTo(SessionConnection.PLAYBOOK_START_STOPPED);
        });
        w.connection().onUserMessage("x", null);
        assertThat(frames(w.socket(), "error").stream().map(f -> f.path("message").asText()).toList())
                .as("the run slot is free again").doesNotContain(SessionConnection.RUN_ACTIVE);
        w.connection().onStopFrame();
    }

    /** Second fix round: the refusal of a start carries the id the frame asked with, through the handler. */
    @Test
    void theRefusalOfAStartCarriesTheIdItWasAskedWith() throws Exception {
        Path dir = registered();
        Wired w = wired("ws-584-ask", p -> listing(p, "local", "m"));

        w.handler().handleTextMessage(w.socket(), new TextMessage(JSON.writeValueAsString(Map.of(
                "type", "start_playbook", "dir", dir.toString(), "hash", "sha256:0000", "prompt", TASK,
                "ask", "start-3"))));
        w.handler().handleTextMessage(w.socket(), new TextMessage(JSON.writeValueAsString(Map.of(
                "type", "start_playbook", "dir", dir.toString(), "hash", "sha256:0000", "prompt", TASK))));

        assertThat(frames(w.socket(), "error").stream().map(f -> f.path("message").asText()).toList())
                .containsExactly(SessionConnection.PLAYBOOK_CHANGED, SessionConnection.PLAYBOOK_CHANGED);
        assertThat(frames(w.socket(), "playbook_start_refused")).as("only the start that asked with an id")
                .singleElement().satisfies(f -> {
                    assertThat(f.path("ask").asText()).isEqualTo("start-3");
                    assertThat(f.path("message").asText()).isEqualTo(SessionConnection.PLAYBOOK_CHANGED);
                });
    }

    /**
     * Review N1 and N3: the checks run side by side under one deadline. Three
     * checks that never answer end at the deadline together, not one after
     * the other.
     */
    @Test
    void theChecksRunSideBySideUnderOneDeadline() throws Exception {
        Path dir = registered();
        Wired w = wired("ws-584-n3", p -> {
            if (List.of("lmstudio", "llamacpp", "openrouter").contains(p)) {
                hang(600_000);
            }
            return listing(p, "local", "m");
        });
        w.connection().checkBudgetForTest(600);
        long t0 = System.nanoTime();

        w.handler().handleTextMessage(w.socket(), new TextMessage(JSON.writeValueAsString(Map.of(
                "type", "confirm_playbook", "dir", dir.toString(), "prompt", TASK))));
        long handled = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (frames(w.socket(), "playbook_confirm").isEmpty() && System.nanoTime() < until) {
            Thread.sleep(10);
        }
        long sheet = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);

        System.out.println("CARD584 N3 handler returned after ms=" + handled + " ; sheet after ms=" + sheet);
        assertThat(handled).as("the handler returns at once").isLessThan(ANSWERED_WITHIN_MS);
        assertThat(frames(w.socket(), "playbook_confirm")).hasSize(1);
        assertThat(sheet).as("one deadline of 600 ms for all three, not 1,800 ms").isLessThan(600 + 1_000);
    }

    /**
     * Review N6: a check that does not come back, or that throws, reads as the
     * provider it is (its kind from the registry, no request) and not checked,
     * with its own reason; never as a provider the app does not know.
     */
    @Test
    void aLostCheckReadsAsTheProviderItIsWithItsOwnReason() throws Exception {
        Path dir = registered();
        Wired w = wired("ws-584-n6", p -> {
            if ("lmstudio".equals(p)) {
                hang(600_000);
            }
            if ("anthropic".equals(p)) {
                throw new IllegalStateException("the check broke");
            }
            return listing(p, "local", "m");
        });
        w.connection().checkBudgetForTest(400);

        w.connection().onConfirmPlaybook(dir.toString(), TASK);

        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (frames(w.socket(), "playbook_confirm").isEmpty() && System.nanoTime() < until) {
            Thread.sleep(10);
        }
        JsonNode models = frames(w.socket(), "playbook_confirm").getFirst().path("preview").path("models");
        assertThat(models.get(0).path("node").asText()).isEqualTo("write_plan");
        assertThat(models.get(0).path("reason").asText()).isEqualTo("check-error");
        assertThat(models.get(1).path("node").asText()).isEqualTo("tidy");
        assertThat(models.get(1).path("reason").asText())
                .as("a private step on a local provider whose check did not come back is not private-on-cloud")
                .isEqualTo("check-timeout");
        JsonNode steps = frames(w.socket(), "playbook_confirm").getFirst().path("preview").path("steps");
        assertThat(steps.get(1).path("providerKind").asText()).isEqualTo("local");
        assertThat(steps.get(1).path("providerState").asText()).isEqualTo("configured");
        assertThat(SpectroConfig.knownProviders()).contains("lmstudio", "anthropic");
    }
}
