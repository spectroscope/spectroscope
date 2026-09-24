package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * Card 386's second scenario, on the face a browser window owns: a zero
 * written by hand into the user settings file, and a new session.
 *
 * <p>Before the card, {@code commandTimeoutSeconds: 0} reached
 * {@code process.waitFor(0, SECONDS)} and every command of the session timed
 * out at once, and {@code subagentBudgetSeconds: 0} made the agent build throw.
 * The loader now skips a value below its key's floor, so the session starts on
 * the value of the layer below, which here is the shipped one.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionBelowFloorTest {

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
    void aHandWrittenZeroLeavesTheSessionOnTheShippedShellBudget(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "commandTimeoutSeconds": 0, "subagentBudgetSeconds": 0 }
                """);
        try {
            SessionConnection connection = sessionIn("ws-386-zero", workspace);
            assertThatCode(connection::buildAgentOnce)
                    .as("a zero on disk took the agent build down")
                    .doesNotThrowAnyException();

            Tool shell = connection.belt().get("run_command").orElseThrow();
            assertThat(shell.description()).contains("900 s timeout");
            String answer = shell.execute(JSON.createObjectNode().put("command", "echo hi"),
                    new Tool.ToolContext(workspace, new CancelSignal()));
            assertThat(answer).as("the command ran under a budget of zero")
                    .doesNotContain("timed out")
                    .contains("hi");
        } finally {
            restoreUserSettings(previous);
        }
    }
}
