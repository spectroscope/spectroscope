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
    void theRefreshMethodItselfPutsTheOperatorsNumberOnTheLiveLeash(@TempDir Path workspace)
            throws IOException {
        // The METHOD only — it is called by hand here, so this pins what
        // refreshContinuationBudget does and NOT that runPrompt calls it. The
        // test below is the one that pins the call site; the review found this
        // distinction the hard way, because the whole call site could be deleted
        // with the full gate staying green.
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

    @Test
    void aSecondPromptPicksUpTheOperatorsNewBudgetWithoutAReconnect(@TempDir Path workspace)
            throws IOException, InterruptedException {
        // Criterion 7, pinned where it lives: the CALL SITE in runPrompt, not the
        // method it calls. The agent is built ONCE per browser session
        // (buildAgentOnce), so a budget read only there would need a reconnect to
        // change — a rebuild by another name. Deleting the one line
        // `refreshContinuationBudget();` from runPrompt left the entire Java gate
        // green before this test existed, which is card 222's finding F4 exactly.
        //
        // The provider points at a closed port on purpose: this measures what the
        // prompt path DOES on its way into the run, and it must not need a
        // backend to do it.
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "baseUrl": "http://127.0.0.1:1" }
                """);
        try {
            SessionConnection connection = sessionIn("ws-266-callsite", workspace);
            connection.buildAgentOnce();
            assertThat(connection.agent().continuationLeash().budget())
                    .as("the premise: this session started on the shipped default")
                    .isEqualTo(ContinuationLeash.DEFAULT_BUDGET);

            saveForUser("""
                    { "provider": "ollama", "model": "qwen3:latest",
                      "baseUrl": "http://127.0.0.1:1", "continuationBudget": 1 }
                    """);
            connection.adoptSessionConfig();

            connection.onUserMessage("say something", null);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            while (System.nanoTime() < deadline
                    && connection.agent().continuationLeash().budget()
                            == ContinuationLeash.DEFAULT_BUDGET) {
                Thread.sleep(20);
            }

            assertThat(connection.agent().continuationLeash().budget())
                    .as("the operator changed the number between prompts and the very next"
                            + " prompt runs on it — read off a real onUserMessage, never"
                            + " off a hand-called refresh")
                    .isEqualTo(1);
        } finally {
            restoreUserSettings(previous);
        }
    }
}
