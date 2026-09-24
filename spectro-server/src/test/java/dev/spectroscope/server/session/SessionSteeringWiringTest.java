package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 380 on the face a person watches: the browser session.
 *
 * <p>Read off the agent a real {@code buildAgentOnce} built, never off one a
 * test assembled. Card 222's finding F4 is the precedent: a whole tool family
 * was deleted from the live registration and the full gate stayed green,
 * because every test built its own registry.</p>
 *
 * <p>The refusal in {@code onUserMessage} is pinned here as well. Nothing pinned
 * it before this card, and the client's fallback for an older server relies on
 * it staying exactly as it is: a client that fell back to a plain
 * {@code user_message} mid run would meet that error instead of the queue.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionSteeringWiringTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static SessionConnection sessionIn(String socketId, Path workspace, FakeSocket socket) {
        SessionConnection connection = new SessionConnection(
                socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(null, null, null, null, null,
                        workspace.toString())),
                null);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        return connection;
    }

    private static String saveForUser(String json) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        String previous = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
        return previous;
    }

    private static void restore(String previous) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previous == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previous);
        }
    }

    @Test
    void theAgentTheBrowserBuildsCarriesTheSessionsOwnInbox(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection =
                    sessionIn("ws-380-wiring", workspace, new FakeSocket("ws-380-wiring",
                            "ws://localhost/ws"));
            connection.buildAgentOnce();

            assertThat(connection.agent().steering())
                    .as("the face where a run is watched is the one face that can be steered")
                    .isNotNull()
                    .isSameAs(connection.steering());
        } finally {
            restore(previous);
        }
    }

    @Test
    void whatTheOperatorTypesReachesTheInboxTheLoopPolls(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection =
                    sessionIn("ws-380-reach", workspace, new FakeSocket("ws-380-reach",
                            "ws://localhost/ws"));
            connection.buildAgentOnce();
            // A run is in flight: the loop opens the inbox before run_start.
            // Since the fix round of 2026-09-24 a closed inbox refuses, so this
            // test states the run it is about instead of relying on a leftover.
            connection.agent().steering().open();

            connection.onSteeringMessage("use the cached list, not the API");

            assertThat(connection.agent().steering().waiting()).isTrue();
            assertThat(connection.agent().steering().take())
                    .isEqualTo("use the cached list, not the API");
        } finally {
            restore(previous);
        }
    }

    @Test
    void aBlankSentenceIsDroppedAndARealOneOnTheSamePathIsNot(@TempDir Path workspace)
            throws IOException {
        // Paired on purpose: the negative alone is green on a connection that
        // drops everything, which is exactly the defect the pairing rules out.
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection =
                    sessionIn("ws-380-blank", workspace, new FakeSocket("ws-380-blank",
                            "ws://localhost/ws"));
            connection.buildAgentOnce();
            connection.steering().open(); // a run is in flight, as above

            connection.onSteeringMessage("   \n ");
            assertThat(connection.steering().waiting())
                    .as("whitespace is not a correction")
                    .isFalse();

            connection.onSteeringMessage("and this one is");
            assertThat(connection.steering().take()).isEqualTo("and this one is");
        } finally {
            restore(previous);
        }
    }

    @Test
    void aSentenceWithNoRunInFlightGoesBackToTheOperatorAndNothingWaits(@TempDir Path workspace)
            throws IOException {
        // Fix round 2026-09-24. The frame can land after the run it was typed
        // for has ended: the browser saw the run as up when it sent. The first
        // build kept such a sentence and the next run folded it into its first
        // request. Now the inbox refuses it, and the operator is told on the
        // same channel as every other event, with the text, so the page can
        // put it in the old waiting line (owner call 3).
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        FakeSocket socket = new FakeSocket("ws-380-norun", "ws://localhost/ws");
        try {
            SessionConnection connection = sessionIn("ws-380-norun", workspace, socket);
            connection.buildAgentOnce();

            connection.onSteeringMessage("typed as the run ended");

            assertThat(socket.textJoined())
                    .as("the operator gets the sentence back as not taken")
                    .contains("\"type\":\"steering_message\"")
                    .contains("\"text\":\"typed as the run ended\"")
                    .contains("\"taken\":false");
            assertThat(connection.steering().waiting())
                    .as("and nothing is left for the next run to fold in")
                    .isFalse();
        } finally {
            restore(previous);
        }
    }

    @Test
    void aUserMessageDuringARunIsStillRefusedByName(@TempDir Path workspace)
            throws Exception {
        // Criterion 13's fallback leans on this refusal staying put: a client
        // that fell back to user_message while a run was up would meet THIS, not
        // a second run. Nothing pinned it before this card.
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        FakeSocket socket = new FakeSocket("ws-380-refusal", "ws://localhost/ws");
        try {
            SessionConnection connection = sessionIn("ws-380-refusal", workspace, socket);
            // Reflection rather than a test-only setter on the production class:
            // the guard reads one private volatile boolean, and a hatch cut into
            // SessionConnection so a test can reach it is a hatch anything else
            // can reach too.
            java.lang.reflect.Field running = SessionConnection.class.getDeclaredField("running");
            running.setAccessible(true);
            running.setBoolean(connection, true);

            connection.onUserMessage("second prompt", null);

            assertThat(socket.textJoined())
                    .as("the refusal names the active run rather than starting a second one")
                    .contains("A run is already active");
        } finally {
            restore(previous);
        }
    }
}
