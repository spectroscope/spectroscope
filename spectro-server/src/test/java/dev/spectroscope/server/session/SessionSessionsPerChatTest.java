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
 * Card 490 on the browser session: the agent a real {@code buildAgentOnce}
 * built carries the chat's session count, a count saved while the session is
 * open reaches it at the next prompt, and the context view describes the
 * spawn tools with the count the config holds. The slot pool itself is
 * pinned in spectro-core ({@code SessionSlotPoolTest}); this pins that the
 * session hands the number over. The Gradle test task points
 * {@code user.home} into the build directory, so no real settings file is
 * touched.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionSessionsPerChatTest {

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
    void aSessionWithNothingSetHasNoCount(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest" }
                """);
        try {
            SessionConnection connection = sessionIn("ws-490-unset", workspace);
            connection.buildAgentOnce();
            assertThat(connection.agent().sessionsPerChat())
                    .as("a chat with nothing set must run as v0.14.4 did")
                    .isNull();
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void aSavedCountReachesTheSessionsAgent(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest", "sessionsPerChat": 3 }
                """);
        try {
            SessionConnection connection = sessionIn("ws-490-three", workspace);
            connection.buildAgentOnce();
            assertThat(connection.agent().sessionsPerChat())
                    .as("the operator's count did not reach the session's agent")
                    .isEqualTo(3);
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void aCountSavedWhileTheSessionIsOpenReachesTheNextPrompt(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest" }
                """);
        try {
            SessionConnection connection = sessionIn("ws-490-live", workspace);
            connection.buildAgentOnce();
            SettingsWriter.patch(workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS),
                    SettingsWriter.Scope.LOCAL, JSON.readTree("{\"sessionsPerChat\":4}"));

            connection.refreshSessionsPerChat();

            assertThat(connection.agent().sessionsPerChat())
                    .as("a count saved in the folder's local file did not reach the open session")
                    .isEqualTo(4);
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theContextViewDescribesTheSpawnToolsWithTheConfiguredCount(@TempDir Path cwd)
            throws IOException {
        Path file = cwd.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{ \"sessionsPerChat\": 3 }");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);

        ContextInfo described = ContextDescriber.describe(config, cwd);

        for (String name : java.util.List.of("spawn_agent", "spawn_agents")) {
            String description = described.tools().stream()
                    .filter(tool -> name.equals(tool.name()))
                    .findFirst().orElseThrow().description();
            assertThat(description)
                    .as(name + " is shown without the count the chat sends")
                    .endsWith("In this chat at most 2 subagents run at the same time;"
                            + " further ones wait for a free slot.");
        }
    }
}
