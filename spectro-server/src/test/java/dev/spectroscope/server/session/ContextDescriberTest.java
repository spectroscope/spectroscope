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
 * Card 370, criterion 3: what {@code GET /api/context} advertises is built with
 * the same shell budget the session's own belt gets.
 *
 * <p>{@code DescribeContextTest} beside this file pins the LIST and the WORDS,
 * that the endpoint reads name, description and gate flag off the real tool
 * objects instead of hand-written literals. This one pins the NUMBER inside
 * those words. The brief card 370 was cut from called this site a capability
 * name list that needs nothing; it is not, because
 * {@code ContextDescriber.asToolInfo} reads {@code tool.description()}, and
 * {@code run_command}'s description carries the budget the tool was built with.
 * Wire the four belts and leave this one, and the endpoint that tells an
 * operator what their agent can do announces ten over a belt running
 * forty-five.</p>
 *
 * <p>The assertion sets a non-default and reads the described sentence, rather
 * than comparing two expressions that both know the number. The test this card
 * replaces did the latter and could not fail.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ContextDescriberTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A config whose shell budget is the operator's, written where a project
     *  save writes it.
     *  @param dir     the launch directory
     *  @param seconds the budget to save
     *  @return the resolved config
     *  @throws IOException when the settings file cannot be written */
    private static SpectroConfig configuredWith(Path dir, int seconds) throws IOException {
        Path file = dir.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{ \"commandTimeoutSeconds\": " + seconds + " }");
        return SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
    }

    /** What the endpoint says {@code run_command} does.
     *  @param context the described context
     *  @return the shell tool's advertised description */
    private static String shellDescription(ContextInfo context) {
        return context.tools().stream()
                .filter(tool -> "run_command".equals(tool.name()))
                .findFirst()
                .orElseThrow(() -> new AssertionError(
                        "the described context lists no run_command at all"))
                .description();
    }

    @Test
    void theDescribedShellToolCarriesTheConfiguredBudget(@TempDir Path cwd) throws IOException {
        SpectroConfig config = configuredWith(cwd, 45);

        assertThat(shellDescription(ContextDescriber.describe(config, cwd)))
                .as("the System-Context panel advertises a budget the operator never typed,"
                        + " while their session runs on the one they did")
                .contains("45 s timeout")
                .doesNotContain("900 s timeout");
    }

    @Test
    void theDescriptionMovesWhenTheSettingMoves(@TempDir Path cwd) throws IOException {
        // The half that cannot pass on a literal: two budgets, two sentences.
        String atFive = shellDescription(ContextDescriber.describe(configuredWith(cwd, 5), cwd));
        String atFifty = shellDescription(ContextDescriber.describe(configuredWith(cwd, 50), cwd));

        assertThat(atFive)
                .as("the endpoint hands out the same sentence whichever budget was"
                        + " configured, so the number in it comes from somewhere else")
                .isNotEqualTo(atFifty);
        assertThat(atFive).contains("5 s timeout");
        assertThat(atFifty).contains("50 s timeout");
    }

    /** Writes the user settings file, the scope that may carry a workspace
     *  pointer. The Gradle test task points {@code user.home} into the build
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

    @Test
    void theEndpointAndTheSessionsBeltSpeakOneNumber(@TempDir Path workspace) throws IOException {
        // Card 370, criterion 3, as it is actually written: the two are
        // COMPARED, not asserted separately against a number each of them
        // knows. Two assertions that both say 45 are green while the two faces
        // read different files, and they did: the belt resolves
        // loadForWorkspace(projectDir, workspace) at the session moment, and
        // the endpoint resolved load(Overrides.none()) with no workspace scope
        // at all. So a budget in the WORKSPACE settings file, which is card
        // 370's own scenario, reached the belt and never the description.
        //
        // The key is therefore written into the workspace scope, and nothing
        // in this test names 45 twice.
        Path workspaceSettings = workspace.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(workspaceSettings.getParent());
        Files.writeString(workspaceSettings, "{ \"commandTimeoutSeconds\": 45 }");
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "workspace": "%s" }
                """.formatted(workspace));
        try {
            // The session, as the websocket handler builds one.
            SessionConnection connection = new SessionConnection(
                    new FakeSocket("ws-370-compare", "ws://localhost/ws"), JSON,
                    SpectroConfig.load(SpectroConfig.Overrides.none()), null);
            connection.start();
            connection.onSetWorkspace("set", workspace.toString());
            connection.adoptSessionConfig();
            connection.buildAgentOnce();
            String belt = connection.belt().get("run_command").orElseThrow(
                    () -> new AssertionError("the session's belt carries no run_command"))
                    .description();

            // The endpoint, with the inputs SessionsController.context() uses.
            String described = shellDescription(ContextDescriber.describe(
                    SpectroConfig.load(SpectroConfig.Overrides.none()),
                    Path.of(System.getProperty("user.dir"))));

            assertThat(described)
                    .as("the System-Context tab tells the operator what their agent can do,"
                            + " and it described a shell the session is not running. One"
                            + " number, read twice, has to come back the same")
                    .isEqualTo(belt);
        } finally {
            restoreUserSettings(previous);
        }
    }
}
