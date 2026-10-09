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
 * Card 467, criterion 6, on the browser session: the agent a real
 * {@code buildAgentOnce} built follows the operator's {@code toolResultElision},
 * read off that agent and never off one a test assembled. The loop's behaviour
 * under each value is pinned in spectro-core ({@code AgentToolResultElisionTest});
 * this pins that the session hands the value over at all.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionToolResultElisionReachTest {

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
    void aSessionOpensWithTheElisionOnWhenNothingIsSet(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest" }
                """);
        try {
            SessionConnection connection = sessionIn("ws-467-on", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().toolResultElision())
                    .as("the shipped value is on")
                    .isTrue();
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void aSessionOpenedAfterTheOperatorSavedOffSendsEveryResultWhole(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest", "toolResultElision": "off" }
                """);
        try {
            SessionConnection connection = sessionIn("ws-467-off", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().toolResultElision())
                    .as("the operator's off did not reach the session's agent")
                    .isFalse();
        } finally {
            restoreUserSettings(previous);
        }
    }
}
