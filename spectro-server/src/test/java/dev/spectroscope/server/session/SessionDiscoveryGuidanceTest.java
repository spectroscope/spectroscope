package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.subagents.RoleCatalog;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 470 on the browser face: the discovery paragraph is in the system
 * prompt a real {@code buildAgentOnce} hands the agent, and in the prompt
 * {@code GET /api/context} shows the operator, because that panel promises
 * "what the panel shows is what the model gets".
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionDiscoveryGuidanceTest {

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
    void theBrowserSessionIsBuiltWithTheDiscoveryParagraph(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-470-prompt", workspace);
            connection.buildAgentOnce();
            assertThat(RoleCatalog.DISCOVERY_GUIDANCE)
                    .as("the premise: the paragraph is not empty, so 'contains' below is not vacuous")
                    .contains("explore child");
            assertThat(connection.agent().systemPrompt())
                    .as("the prompt the browser session's agent runs with")
                    .contains(RoleCatalog.DISCOVERY_GUIDANCE);
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theSystemContextPanelShowsTheDiscoveryParagraph(@TempDir Path cwd) {
        ContextInfo context = ContextDescriber.describe(
                SpectroConfig.load(SpectroConfig.Overrides.none(), cwd), cwd);
        assertThat(RoleCatalog.DISCOVERY_GUIDANCE).contains("explore child");
        assertThat(context.systemPrompt())
                .as("GET /api/context shows the operator what the model gets")
                .contains(RoleCatalog.DISCOVERY_GUIDANCE);
    }

    @Test
    void theBrowserSessionStartsFromTheSharedBasePrompt(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-470-base", workspace);
            connection.buildAgentOnce();
            assertThat(RoleCatalog.BASE_SYSTEM_PROMPT)
                    .as("the premise: the shared base prompt carries the paragraph")
                    .contains(RoleCatalog.DISCOVERY_GUIDANCE);
            assertThat(connection.agent().systemPrompt())
                    .as("the browser session opens with the base prompt core holds, not a copy")
                    .startsWith(RoleCatalog.BASE_SYSTEM_PROMPT);
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theSystemContextPanelStartsFromTheSharedBasePrompt(@TempDir Path cwd) {
        ContextInfo context = ContextDescriber.describe(
                SpectroConfig.load(SpectroConfig.Overrides.none(), cwd), cwd);
        assertThat(RoleCatalog.BASE_SYSTEM_PROMPT).contains(RoleCatalog.DISCOVERY_GUIDANCE);
        assertThat(context.systemPrompt())
                .as("GET /api/context shows the base prompt core holds")
                .startsWith(RoleCatalog.BASE_SYSTEM_PROMPT);
    }
}
