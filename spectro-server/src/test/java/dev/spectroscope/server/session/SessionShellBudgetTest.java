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
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 370, criterion 1, for the two faces a browser window owns: the session's
 * own belt and the belt its children inherit.
 *
 * <p>Both are assembled in {@code buildAgentOnce}, in two separate calls four
 * dozen lines apart, and until this card both of them read
 * {@code StandardTools.all()} with no argument. So an operator who raised the
 * shell budget to 45 seconds, watched the save land and opened a fresh session
 * because the settings page told them to, was met by the same command dying at
 * ten, with an error that said ten. Two calls means two chances to wire one and
 * forget the other, which is why the parent and the child are read separately
 * here rather than once through whichever one is convenient.</p>
 *
 * <p>The assertions are on the belt the face BUILT, never on what the config
 * returns. Asking the config would have passed on every day this was broken:
 * the key resolved perfectly through six layers and nothing that runs a command
 * ever read it, which is the whole defect.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionShellBudgetTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A session built the way the websocket handler builds one.
     *  @param socketId  a name for the fake socket
     *  @param workspace the folder this session works in
     *  @return the connection, with its workspace and session config settled */
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

    /** The operator's own path to the number: the user settings file the page
     *  writes. The Gradle test task points {@code user.home} into the build
     *  directory, so this never touches the real home.
     *  @param json the whole settings file to write
     *  @return what was there before, or null when there was no file
     *  @throws IOException when the file cannot be written */
    private static String saveForUser(String json) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        String previous = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
        return previous;
    }

    /** Puts the user settings file back the way it was found.
     *  @param previous what {@link #saveForUser} handed back
     *  @throws IOException when the file cannot be restored */
    private static void restoreUserSettings(String previous) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previous == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previous);
        }
    }

    /** The shell tool off the belt this session's agent carries.
     *  @param connection the session
     *  @return its run_command */
    private static Tool parentShell(SessionConnection connection) {
        return connection.belt().get("run_command").orElseThrow(
                () -> new AssertionError("the session's belt carries no run_command at all"));
    }

    /** The shell tool off the belt this session hands its children.
     *  @param connection the session
     *  @return the child belt's run_command */
    private static Tool childShell(SessionConnection connection) {
        List<Tool> belt = connection.childBelt();
        return belt.stream().filter(tool -> "run_command".equals(tool.name())).findFirst()
                .orElseThrow(() -> new AssertionError(
                        "the child belt carries no run_command at all"));
    }

    @Test
    void theOperatorsShellBudgetReachesTheSessionsOwnBelt(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "commandTimeoutSeconds": 45 }
                """);
        try {
            SessionConnection connection = sessionIn("ws-370-parent", workspace);
            connection.buildAgentOnce();

            assertThat(parentShell(connection).description())
                    .as("the browser session tells the model the budget the operator typed")
                    .contains("45 s timeout")
                    .doesNotContain("900 s timeout");
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theOperatorsShellBudgetReachesTheBeltAChildInherits(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "commandTimeoutSeconds": 45 }
                """);
        try {
            SessionConnection connection = sessionIn("ws-370-child", workspace);
            connection.buildAgentOnce();

            assertThat(childShell(connection).description())
                    .as("a child agent runs on its parent's shell budget, not on a second"
                            + " number nobody typed")
                    .contains("45 s timeout")
                    .doesNotContain("900 s timeout");
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void aCommandThisSessionRunsIsKilledAtTheBudgetTheOperatorTyped(@TempDir Path workspace)
            throws IOException {
        // Announcing and enforcing are two claims. The description above is what
        // the model reads; this is what the process gets, driven through the same
        // tool instance the live session registered.
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "commandTimeoutSeconds": 1 }
                """);
        try {
            SessionConnection connection = sessionIn("ws-370-kill", workspace);
            connection.buildAgentOnce();

            String answer = parentShell(connection).execute(
                    JSON.createObjectNode().put("command", "sleep 5"),
                    new Tool.ToolContext(workspace, new CancelSignal()));

            assertThat(answer)
                    .as("the shell call died on a budget the operator never typed")
                    .contains("timed out after 1 s");
        } finally {
            restoreUserSettings(previous);
        }
    }
}
