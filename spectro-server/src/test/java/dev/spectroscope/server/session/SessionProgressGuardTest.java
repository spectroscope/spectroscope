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
 * Card 262 on the face that has a person: the server session.
 *
 * <p>The fence for the guard is the WIRING, the same way the fence for card
 * 265's ask is the registration — a face where nobody could answer carries no
 * guard, because the owner ruled out a guard that can only narrate while the
 * hour keeps burning. So "this face watches" has to be read off the agent a
 * real {@code buildAgentOnce} built. Card 222's review finding F4 is the
 * precedent: a whole family was deleted from the live registration and the full
 * gate stayed green, because every test built its own.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionProgressGuardTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static SpectroConfig configuredAt(Path dir) {
        return SpectroConfig.load(
                new SpectroConfig.Overrides(null, null, null, null, null, dir.toString()));
    }

    private static SessionConnection sessionIn(String socketId, Path workspace) {
        SessionConnection connection = new SessionConnection(
                new FakeSocket(socketId, "ws://localhost/ws"), JSON, configuredAt(workspace), null);
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

    private static void restoreUserSettings(String previous) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previous == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previous);
        }
    }

    @Test
    void aRealSessionWiresTheGuardWithTheShippedNumbers(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-262-wiring", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().progressGuard())
                    .as("a browser holds this socket, so a person can answer the guard's"
                            + " question — this is the face the owner's decision was made for")
                    .isNotNull();
            assertThat(connection.agent().progressGuard().settings().identicalWrites())
                    .as("the shipped default, read through the settings chain")
                    .isEqualTo(3);
            assertThat(connection.agent().progressGuard().settings().repeatedFailures())
                    .isEqualTo(3);
            assertThat(connection.agent().progressGuard().settings().stalledPlanTurns())
                    .as("the plan net ships off; it needs a plan the weak models never write")
                    .isZero();
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theOperatorsOwnNumbersReachTheGuard(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "progressGuardWrites": 5,
                  "progressGuardFailures": 0,
                  "progressGuardPlanTurns": 6 }
                """);
        try {
            SessionConnection connection = sessionIn("ws-262-numbers", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().progressGuard().settings().identicalWrites())
                    .isEqualTo(5);
            assertThat(connection.agent().progressGuard().settings().repeatedFailures())
                    .as("zero is the off switch and it has to survive the whole chain —"
                            + " a knob that silently reverts to 3 is worse than no knob")
                    .isZero();
            assertThat(connection.agent().progressGuard().settings().stalledPlanTurns())
                    .isEqualTo(6);
        } finally {
            restoreUserSettings(previous);
        }
    }
}
