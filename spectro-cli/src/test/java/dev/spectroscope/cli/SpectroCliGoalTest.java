package dev.spectroscope.cli;

import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.goal.CommandGoalCheck;
import dev.spectroscope.core.goal.GoalStore;
import dev.spectroscope.core.goal.RunGoal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 267 on the OTHER attended face: the interactive REPL (review pass).
 *
 * <p>Read off {@link SpectroCli#openInteractiveSession}, the real assembly
 * {@code run()} performs — never off a hand-built {@code AgentOptions}. The
 * review found {@code .goal(goal)} in {@code buildAgent} pinned by nothing here:
 * the server face had a wiring test and this one had none, so deleting the
 * clause would have left the whole gate green while the REPL — the only face
 * with an operator surface for a goal at all — quietly stopped carrying one.
 * That is card 222's finding F4, in the same shape, for the third time.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpectroCliGoalTest {

    private static SpectroCli interactive(Path workspace) {
        SpectroCli cli = new SpectroCli();
        new CommandLine(cli).parseArgs("--workspace", workspace.toString());
        cli.anchorAt(workspace);
        cli.openInteractiveSession(new BufferedReader(new StringReader("")));
        return cli;
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

    private static final String SETTINGS = "{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}";

    @Test
    void theInteractiveReplRunsWithAGoalCarryingTheShippedTeeth(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser(SETTINGS);
        SpectroCli cli = null;
        try {
            cli = interactive(workspace);

            assertNotNull(cli.agent().goal(),
                    "the REPL is the one face with an operator surface for a goal, and it"
                            + " reached the loop carrying none");
            assertInstanceOf(CommandGoalCheck.class, cli.agent().goal().check(),
                    "the SHIPPED teeth are a command's exit code; the evaluator is opt-in"
                            + " with a named model and is wired nowhere");
            assertNull(cli.agent().goal().stated(),
                    "no face refuses to start without a goal — owner call 3");
        } finally {
            cleanUp(cli);
            restoreUserSettings(previous);
        }
    }

    @Test
    void slashGoalStatesChecksAndClearsAndTheFileFollowsEveryStep(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser(SETTINGS);
        SpectroCli cli = null;
        try {
            cli = interactive(workspace);
            Path file = GoalStore.fileFor(cli.sessionId());

            // "state the outcome first" — a check with nothing to check refuses
            // and writes nothing.
            cli.handleSlashCommand("/goal check node --test");
            assertNull(cli.agent().goal().stated());
            assertFalse(Files.exists(file), "a refused form still wrote the file");

            cli.handleSlashCommand("/goal set The auth tests pass.");
            assertEquals("The auth tests pass.", cli.agent().goal().stated().outcome());
            assertNull(cli.agent().goal().stated().check());

            cli.handleSlashCommand("/goal check node --test test/auth.test.js");
            RunGoal stated = cli.agent().goal().stated();
            assertEquals("The auth tests pass.", stated.outcome(),
                    "adding a check must not lose the outcome it belongs to");
            assertEquals("node --test test/auth.test.js", stated.check());

            RunGoal onDisk = GoalStore.read(file);
            assertNotNull(onDisk, "criterion 1: durable, or it is not an artifact");
            assertEquals("The auth tests pass.", onDisk.outcome());
            assertEquals("node --test test/auth.test.js", onDisk.check());

            cli.handleSlashCommand("/goal clear");
            assertNull(cli.agent().goal().stated());
            assertFalse(Files.exists(file),
                    "a withdrawn goal that the next session re-reads is the harness"
                            + " overruling the operator with a stale file");
        } finally {
            cleanUp(cli);
            restoreUserSettings(previous);
        }
    }

    @Test
    void aGoalTypedWithNoVerbIsTakenAsTheOutcome(@TempDir Path workspace) throws IOException {
        // `/goal ship the refresh fix` is what a person types. It is the same
        // form as `/goal set …` and it has to reach the same place.
        String previous = saveForUser(SETTINGS);
        SpectroCli cli = null;
        try {
            cli = interactive(workspace);
            cli.handleSlashCommand("/goal ship the refresh fix");
            assertEquals("ship the refresh fix", cli.agent().goal().stated().outcome());
            assertTrue(Files.exists(GoalStore.fileFor(cli.sessionId())));
        } finally {
            cleanUp(cli);
            restoreUserSettings(previous);
        }
    }

    /** Removes the goal file this test's real session wrote under the user's
     *  home — the store mints a real id, so the sidecar is a real file.
     *  @param cli the session, or null when it never opened */
    private static void cleanUp(SpectroCli cli) throws IOException {
        if (cli != null && cli.sessionId() != null) {
            Files.deleteIfExists(GoalStore.fileFor(cli.sessionId()));
        }
    }
}
