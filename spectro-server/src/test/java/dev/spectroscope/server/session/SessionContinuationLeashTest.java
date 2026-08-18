package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.loop.ContinuationLeash;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 266 on the face the owner's first call names: an attended session.
 *
 * <p>The fence for the leash is the WIRING, the same as card 262's guard and
 * card 265's ask — an unattended face that continues by itself multiplies a bill
 * with nobody watching, and {@code konzept/ORCHESTRATION.md} refusal 5 keeps
 * executing verbs off unattended faces for exactly that reason. So "this face
 * holds its runs" has to be read off the agent a real {@code buildAgentOnce}
 * built. Card 222's finding F4 is the precedent: a whole family was deleted from
 * the live registration and the full gate stayed green, because every test built
 * its own.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionContinuationLeashTest {

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
    void aRealSessionWiresTheLeashWithTheShippedBudget(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-266-wiring", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().continuationLeash())
                    .as("a browser holds this socket, so somebody is watching the bill —"
                            + " this is the face the owner's first call names")
                    .isNotNull();
            assertThat(connection.agent().continuationLeash().budget())
                    .as("the shipped default, read through the settings chain")
                    .isEqualTo(ContinuationLeash.DEFAULT_BUDGET);
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theOperatorsOwnBudgetReachesTheLeashAndZeroTurnsItOff(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "continuationBudget": 0 }
                """);
        try {
            SessionConnection connection = sessionIn("ws-266-off", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().continuationLeash().budget())
                    .as("zero is the off switch and it has to survive the whole chain —"
                            + " a knob that silently reverts to 3 is worse than no knob")
                    .isZero();
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theBudgetIsReReadPerPromptSoAnOperatorCanChangeItMidSession(@TempDir Path workspace)
            throws IOException {
        // Criterion 7: switchable per session at runtime, without a rebuild. The
        // agent is built ONCE per browser session (buildAgentOnce), so a budget
        // read only there would need a reconnect to change — which is a rebuild
        // by another name.
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-266-live", workspace);
            connection.buildAgentOnce();
            assertThat(connection.agent().continuationLeash().budget())
                    .isEqualTo(ContinuationLeash.DEFAULT_BUDGET);

            saveForUser("""
                    { "provider": "ollama", "model": "qwen3:latest",
                      "continuationBudget": 1 }
                    """);
            connection.adoptSessionConfig();
            connection.refreshContinuationBudget();

            assertThat(connection.agent().continuationLeash().budget())
                    .as("the operator's new number governs the very next prompt")
                    .isEqualTo(1);
        } finally {
            restoreUserSettings(previous);
        }
    }
}
