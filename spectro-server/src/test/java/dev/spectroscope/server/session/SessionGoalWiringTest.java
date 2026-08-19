package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.goal.CommandGoalCheck;
import dev.spectroscope.core.goal.GoalStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 267 on the face a person watches: the browser session.
 *
 * <p>Read off the agent a real {@code buildAgentOnce} built, never off one a
 * test assembled. Card 222's finding F4 is the precedent — a whole tool family
 * was deleted from the live registration and the full gate stayed green, because
 * every test built its own registry.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionGoalWiringTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static FakeSocket socket;

    private static SessionConnection sessionIn(String socketId, Path workspace) {
        socket = new FakeSocket(socketId, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(
                socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(null, null, null, null, null,
                        workspace.toString())),
                null);
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

    private static void restore(String previous) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previous == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previous);
        }
    }

    @Test
    void aRealSessionCarriesAGoalWithTheShippedTeeth(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-267-wiring", workspace);
            connection.buildAgentOnce();

            assertThat(connection.agent().goal())
                    .as("the face where the run is watched carries no goal at all")
                    .isNotNull();
            assertThat(connection.agent().goal().check())
                    .as("the SHIPPED teeth are the command's exit code; the evaluator is"
                            + " opt-in with a named model and is wired nowhere")
                    .isInstanceOf(CommandGoalCheck.class);
            assertThat(connection.agent().goal().stated())
                    .as("nothing stated yet, and no face refuses to start without one")
                    .isNull();
        } finally {
            restore(previous);
        }
    }

    @Test
    void theOperatorsGoalReachesTheLoopAndTheDiskInOneAct(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-267-state", workspace);
            connection.buildAgentOnce();
            connection.onSetGoal("The auth tests pass.", "node --test");

            assertThat(connection.agent().goal().stated().outcome())
                    .isEqualTo("The auth tests pass.");
            assertThat(connection.agent().goal().stated().check()).isEqualTo("node --test");

            Path file = GoalStore.fileFor(connection.sessionId());
            assertThat(GoalStore.read(file))
                    .as("criterion 1: readable and editable ON DISK, or it is not durable")
                    .isNotNull();
            assertThat(GoalStore.read(file).check()).isEqualTo("node --test");

            connection.onSetGoal("", "");
            assertThat(connection.agent().goal().stated()).isNull();
            assertThat(Files.exists(file))
                    .as("a withdrawn goal that a later session re-reads is the harness"
                            + " overruling the operator with a stale file")
                    .isFalse();
        } finally {
            restore(previous);
        }
    }

    @Test
    void aGoalIsStatedByTheOperatorAndByNoTool(@TempDir Path workspace) throws IOException {
        // Criterion 5, where it can actually be measured. A model-written goal
        // is a run defining its own success, which PROMPT-ORCHESTRATION.md §3
        // rule 2 already refuses — so the belt this face advertises must contain
        // nothing that could state one.
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-267-nogrant", workspace);
            connection.buildAgentOnce();
            assertThat(connection.belt().specs().stream()
                    .map(dev.spectroscope.core.provider.LlmProvider.ToolSpec::name))
                    .noneMatch(name -> name.contains("goal"));
        } finally {
            restore(previous);
        }
    }

    @Test
    void aGoalStatedBeforeTheFirstPromptIsReportedAsStated(@TempDir Path workspace)
            throws IOException {
        // The review's finding, and it is the NATURAL operator flow: open a
        // session, say what it is for, then prompt. `goal` was assigned only in
        // buildAgentOnce, so onSetGoal wrote the file, skipped the in-memory
        // object and then sent a goal_info frame that read the still-null field
        // — the surface criterion 1 calls "shown where the run is watched"
        // answering "nothing stated" to the operator who had just stated it.
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionIn("ws-267-early", workspace);
            connection.onSetGoal("The auth tests pass.", "node --test");

            assertThat(socket.textJoined())
                    .as("the page was told nothing was stated: " + socket.textJoined())
                    .contains("\"stated\":true")
                    .contains("The auth tests pass.");

            // And the object the loop reads carries it too, without a rebuild.
            assertThat(connection.goal()).isNotNull();
            assertThat(connection.goal().stated().outcome())
                    .isEqualTo("The auth tests pass.");

            // The first prompt then builds its agent AROUND the goal already in
            // force, rather than replacing it with a re-read of the file.
            connection.buildAgentOnce();
            assertThat(connection.agent().goal().stated().outcome())
                    .isEqualTo("The auth tests pass.");
        } finally {
            restore(previous);
        }
    }
}
