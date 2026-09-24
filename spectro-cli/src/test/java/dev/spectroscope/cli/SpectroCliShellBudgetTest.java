package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 370, criterion 1, for the REPL: the face a person types into.
 *
 * <p>{@code SpectroCli.registerTools} builds ONE list and hands it to two
 * consumers, the main agent's registry and the belt every child inherits, so a
 * budget that misses this assembly misses both. It built that list with
 * {@code StandardTools.all()} and no argument, which made the CLI the third
 * live belt running on a number nobody could move.</p>
 *
 * <p>Read off {@link SpectroCli#belt()}, the belt the product really assembles,
 * for the reason {@code SpectroCliAskerTest} records beside it: a belt a test
 * builds by hand pins nothing about the belt a face builds.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpectroCliShellBudgetTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A CLI parsed as picocli parses it, so every flag holds its declared
     *  default.
     *  @param workspace the folder this face works in
     *  @return the parsed command */
    private static SpectroCli parsed(Path workspace) {
        SpectroCli cli = new SpectroCli();
        new CommandLine(cli).parseArgs("--workspace", workspace.toString());
        return cli;
    }

    /** Writes the user settings file the settings page writes.
     *  @param json the whole file
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

    /** The shell tool off the belt this face assembled.
     *  @param workspace the folder the face works in
     *  @return its run_command */
    private static Tool shellOf(Path workspace) {
        SpectroCli cli = parsed(workspace);
        cli.anchorAt(workspace);
        cli.registerTools();
        return cli.belt().get("run_command").orElseThrow(
                () -> new AssertionError("the CLI belt carries no run_command at all"));
    }

    @Test
    void theOperatorsShellBudgetReachesTheReplBelt(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "commandTimeoutSeconds": 45 }
                """);
        try {
            String description = shellOf(workspace).description();
            assertTrue(description.contains("45 s timeout"),
                    "the REPL tells the model a budget the operator never typed: "
                            + description);
            assertFalse(description.contains("900 s timeout"),
                    "the REPL still announces the shipped default over a configured"
                            + " budget: " + description);
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void aCommandThisFaceRunsIsKilledAtThatBudget(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "commandTimeoutSeconds": 1 }
                """);
        try {
            String answer = shellOf(workspace).execute(
                    JSON.createObjectNode().put("command", "sleep 5"),
                    new Tool.ToolContext(workspace, new CancelSignal()));

            assertTrue(answer.contains("timed out after 1 s"),
                    "announcing a budget and enforcing it are two claims, and this face"
                            + " kills its commands on a number nobody typed: " + answer);
        } finally {
            restoreUserSettings(previous);
        }
    }
}
