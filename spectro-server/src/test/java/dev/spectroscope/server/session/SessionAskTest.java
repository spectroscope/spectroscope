package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 265 on the face that has a person: the server session.
 *
 * <p>Two things are proven here and nowhere else. <b>The registration</b> — the
 * fence is registration, so "the tool is on this face" has to be read off the
 * belt a real {@code buildAgentOnce} builds, not off a belt a test assembled by
 * hand. That was card 222's review finding F4 in this very file's neighbour:
 * deleting a whole family from the live registration left the full gate green,
 * because every test built its own belt. <b>And the answer frame</b> — a
 * {@code question_response} has to reach the parked question through the
 * session's own asker, with its own map, never through
 * {@code onPermissionResponse} (which unconditionally does allowlist-rule work
 * a question has no business triggering).</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionAskTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ASK = "ask_user_question";

    private static SpectroConfig configuredAt(Path dir) {
        return SpectroConfig.load(
                new SpectroConfig.Overrides(null, null, null, null, null, dir.toString()));
    }

    /** A session whose workspace is settled, as buildAgentOnce settles it. */
    private static SessionConnection sessionIn(String socketId, Path workspace) {
        SessionConnection connection = new SessionConnection(
                new FakeSocket(socketId, "ws://localhost/ws"), JSON, configuredAt(workspace), null);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        return connection;
    }

    /** Points the provider at a local backend so buildAgentOnce needs no API key. */
    private static String saveForUser(String json) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        String previous = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
        return previous;
    }

    private static void restoreUserSettings(String previous) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previous == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previous);
        }
    }

    private static RunEvent.QuestionAsked question(String callId) {
        return new RunEvent.QuestionAsked("main", callId, List.of(
                new RunEvent.AskedQuestion("Which store?", null, false,
                        List.of(new RunEvent.QuestionOption("Postgres", null)))), 1L);
    }

    @Test
    void aRealSessionCarriesTheAskOnTheBeltItBuilds(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-265-belt", workspace);
            connection.buildAgentOnce();

            assertThat(connection.belt().specs().stream().map(spec -> spec.name()))
                    .as("the browser face has a person attached, so the model sees the verb")
                    .contains(ASK);
            assertThat(connection.belt().get(ASK).orElseThrow().needsPermission())
                    .as("a question has no side effect; gating it would be two prompts for one"
                            + " interaction")
                    .isFalse();
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theAnswerFrameUnparksTheQuestionAndCarriesTheWords(@TempDir Path workspace)
            throws Exception {
        SessionConnection connection = sessionIn("ws-265-answer", workspace);
        ParkingAsker asker = connection.asker();
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Asker.Answer> answer = new AtomicReference<>();
        Thread.ofVirtual().start(() -> {
            answer.set(asker.ask(question("c1")));
            done.countDown();
        });
        awaitPark(asker);

        connection.onQuestionResponse("c1", List.of("Postgres"), false);

        assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(answer.get()).isNotNull();
        assertThat(answer.get().answers()).containsExactly("Postgres");
    }

    @Test
    void aSkippedQuestionIsReleasedWithoutAnAnswer(@TempDir Path workspace) throws Exception {
        // The bar's skip button. It must NOT arrive as an empty answer: "" is a
        // person saying nothing, and that is a different fact from nobody saying
        // anything.
        SessionConnection connection = sessionIn("ws-265-skip", workspace);
        ParkingAsker asker = connection.asker();
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Asker.Answer> answer = new AtomicReference<>(new Asker.Answer(List.of("x")));
        Thread.ofVirtual().start(() -> {
            answer.set(asker.ask(question("c1")));
            done.countDown();
        });
        awaitPark(asker);

        connection.onQuestionResponse("c1", List.of(), true);

        assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(answer.get()).isNull();
    }

    @Test
    void aClosedSocketReleasesTheParkedQuestion(@TempDir Path workspace) throws Exception {
        SessionConnection connection = sessionIn("ws-265-close", workspace);
        ParkingAsker asker = connection.asker();
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Asker.Answer> answer = new AtomicReference<>(new Asker.Answer(List.of("x")));
        Thread.ofVirtual().start(() -> {
            answer.set(asker.ask(question("c1")));
            done.countDown();
        });
        awaitPark(asker);

        connection.onClose();

        assertThat(done.await(5, TimeUnit.SECONDS))
                .as("no agent thread may stay parked behind a socket that will never answer")
                .isTrue();
        assertThat(answer.get()).isNull();
    }

    @Test
    void theSocketDispatchesTheAnswerFrameAndStillRefusesAnUnknownOne() {
        // events.ts grew one ClientMessage; the switch grew one case. The default
        // arm keeps an old client honest and must not be the arm this frame hits.
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-265-dispatch", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                "{\"type\":\"question_response\",\"callId\":\"c1\","
                        + "\"answers\":[\"Postgres\"],\"cancelled\":false}"));
        assertThat(socket.textJoined())
                .as("a known frame is never answered with the unknown-type error")
                .doesNotContain("Unknown message type");

        handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                "{\"type\":\"question_reponse\"}"));   // a typo an old client might send
        assertThat(socket.textJoined()).contains("Unknown message type");
    }

    private static void awaitPark(ParkingAsker asker) {
        long deadline = System.currentTimeMillis() + 5_000;
        while (asker.pending() == 0 && System.currentTimeMillis() < deadline) {
            Thread.onSpinWait();
        }
        assertThat(asker.pending()).as("the question really is parked").isEqualTo(1);
    }
}
