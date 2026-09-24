package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.RtkFilter;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 379, criterion 12: the rtk switch saved while a session is open decides
 * that session's next shell line.
 *
 * <p>Same shape as {@code SessionMaxTurnsTest} and {@code SessionSettingsReachTheBeltTest}:
 * the assertion is made on the filter a real {@code buildAgentOnce} hung on the
 * agent, never on one a test assembled. {@code AgentRtkSeamTest} carries the
 * other half, from that filter through the permission gate to
 * {@code ShellCommand}. The oracle is scripted so the claim holds on a machine
 * without rtk; the real binary is driven in {@code RtkFilterTest}.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionRtkFilterReachTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Answers every line with one fixed rewrite and records what it was asked. */
    private static final class ScriptedOracle implements RtkFilter.Oracle {
        final List<String> asked = new ArrayList<>();

        public String rewrite(String line) {
            asked.add(line);
            return "rtk " + line;
        }

        public String version() {
            return "rtk 0.0.0-scripted";
        }
    }

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

    private static JsonNode shellLine(String command) {
        ObjectNode node = JSON.createObjectNode();
        node.put(RtkFilter.COMMAND_FIELD, command);
        return node;
    }

    @Test
    void theSwitchSavedMidSessionDecidesTheNextShellLineOfThatSession(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest", "rtkFilter": "off" }
                """);
        try {
            SessionConnection connection = sessionIn("ws-379-reach", workspace);
            ScriptedOracle oracle = new ScriptedOracle();
            connection.useRtkOracle(oracle);
            connection.buildAgentOnce();

            RtkFilter filter = connection.agent().rtkFilter();
            assertThat(filter)
                    .as("the session build hangs an rtk filter on the agent")
                    .isNotNull();

            JsonNode before = filter.apply(RtkFilter.TOOL, shellLine("git status"));
            assertThat(before.path(RtkFilter.COMMAND_FIELD).asText())
                    .as("test premise: the session opened with the switch off")
                    .isEqualTo("git status");
            assertThat(oracle.asked).as("off starts no rtk process").isEmpty();

            // What the popover does: a PUT into the user settings file, with the
            // agent already built and the session still open.
            saveForUser("""
                    { "provider": "ollama", "model": "qwen3:latest", "rtkFilter": "on" }
                    """);

            JsonNode after = filter.apply(RtkFilter.TOOL, shellLine("git status"));
            assertThat(after.path(RtkFilter.COMMAND_FIELD).asText())
                    .as("the next shell line of the SAME session goes through rtk")
                    .isEqualTo("rtk git status");
            assertThat(after.path(RtkFilter.ORIGINAL_FIELD).asText()).isEqualTo("git status");
        } finally {
            restoreUserSettings(previous);
        }
    }
}
