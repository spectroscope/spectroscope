package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
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
 * Card 282: the browser session finally passes the turn ceiling it was given.
 *
 * <p>Same shape as {@code SessionProgressGuardTest} and for the same reason: the
 * fence is the WIRING. Card 266 made {@code maxTurns} an option and the only two
 * callers of the builder method were {@code TriggeredNode} and
 * {@code NodeCommand}, so a browser session passed nothing and every run stopped
 * at {@link Agent#DEFAULT_MAX_TURNS} with no way to say otherwise. The config
 * chain alone cannot show that: a key can resolve perfectly and never be
 * read.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionMaxTurnsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static SessionConnection sessionIn(String socketId, Path workspace) {
        SessionConnection connection = new SessionConnection(
                new FakeSocket(socketId, "ws://localhost/ws"), JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(
                        null, null, null, null, null, workspace.toString())), null);
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
    void aSessionThatConfiguresNothingStillRunsOnTheShippedCeiling(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-282-default", workspace);
            connection.buildAgentOnce();
            assertThat(connection.agent().maxTurns())
                    .as("the shipped ceiling, read off the agent rather than off the config")
                    .isEqualTo(Agent.DEFAULT_MAX_TURNS);
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theOperatorsOwnCeilingReachesTheRun(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest", "maxTurns": 40 }
                """);
        try {
            SessionConnection connection = sessionIn("ws-282-own", workspace);
            connection.buildAgentOnce();
            assertThat(connection.agent().maxTurns())
                    .as("this is the whole card: the saved number has to arrive at the loop,"
                            + " not merely resolve in the config")
                    .isEqualTo(40);
        } finally {
            restoreUserSettings(previous);
        }
    }
}
