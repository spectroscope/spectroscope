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
 * this pins that the session hands the value over at all. Card 600: the
 * switch ships off, and on or off it applies to every provider. Since its fix
 * round 1 only the user settings set it: a pinned folder's settings file that
 * carries the key loses it.
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
    void aSessionOpensWithTheElisionOffWhenNothingIsSet(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest" }
                """);
        try {
            SessionConnection connection = sessionIn("ws-600-unset", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().toolResultElision())
                    .as("card 600: the shipped value is off")
                    .isFalse();
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void aSessionOpenedAfterTheOperatorSavedOnCarriesTheSwitchOn(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest", "toolResultElision": "on" }
                """);
        try {
            SessionConnection connection = sessionIn("ws-600-on", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().toolResultElision())
                    .as("the operator's on did not reach the session's agent")
                    .isTrue();
        } finally {
            restoreUserSettings(previous);
        }
    }

    private static void saveForFolder(Path workspace, String json) throws IOException {
        Path file = workspace.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
    }

    @Test
    void aFolderFileSayingOnLeavesALlamaCppSessionWithoutElision(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "llamacpp", "model": "some-model" }
                """);
        try {
            saveForFolder(workspace, """
                    { "toolResultElision": "on" }
                    """);
            SessionConnection connection = sessionIn("ws-600-folder-on", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().toolResultElision())
                    .as("card 600: a folder file turned the elision on")
                    .isFalse();
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theUserOnWinsOverAFolderFileSayingOff(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "llamacpp", "model": "some-model", "toolResultElision": "on" }
                """);
        try {
            saveForFolder(workspace, """
                    { "toolResultElision": "off" }
                    """);
            SessionConnection connection = sessionIn("ws-600-user-on", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().toolResultElision())
                    .as("card 600: a folder file saying off overrode the user's on")
                    .isTrue();
        } finally {
            restoreUserSettings(previous);
        }
    }
}
