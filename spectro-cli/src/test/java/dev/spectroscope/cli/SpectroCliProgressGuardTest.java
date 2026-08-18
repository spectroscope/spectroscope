package dev.spectroscope.cli;

import dev.spectroscope.core.config.SettingsWriter;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Card 262 on the second face that has a person: the interactive CLI.
 *
 * <p>The review found this hole and I confirmed it rather than taking it on
 * trust: deleting the whole {@code .progressGuard(...)} clause from
 * {@code SpectroCli.buildAgent} removed the guard from the REPL — one of the two
 * faces it ships on — and the full gate stayed green. The server face had
 * exactly this reader ({@code SessionProgressGuardTest}) and this face had
 * nothing, which is card 222's finding F4 for the third time: a thing every test
 * assembles by hand pins nothing about the thing the product assembles.</p>
 *
 * <p>Read off {@link SpectroCli#openInteractiveSession}, the REAL assembly
 * {@code run()} performs between the config and the REPL — never off a hand-built
 * {@code AgentOptions}.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpectroCliProgressGuardTest {

    /** A CLI parsed as picocli parses it, so every flag holds its declared default. */
    private static SpectroCli parsed(Path workspace) {
        SpectroCli cli = new SpectroCli();
        new CommandLine(cli).parseArgs("--workspace", workspace.toString());
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

    /** Opens the real interactive session against a console at end of stream. */
    private static SpectroCli interactive(Path workspace) {
        SpectroCli cli = parsed(workspace);
        cli.anchorAt(workspace);
        cli.openInteractiveSession(new BufferedReader(new StringReader("")));
        return cli;
    }

    @Test
    void theInteractiveReplRunsWithTheGuardOnTheShippedNumbers(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SpectroCli cli = interactive(workspace);

            assertNotNull(cli.agent().progressGuard(),
                    "a person sits at this console and can answer the guard's question —"
                            + " this is one of the two faces the owner's decision was made for");
            assertEquals(3, cli.agent().progressGuard().settings().identicalWrites(),
                    "the shipped default, read through the settings chain");
            assertEquals(3, cli.agent().progressGuard().settings().repeatedFailures());
            assertEquals(0, cli.agent().progressGuard().settings().stalledPlanTurns(),
                    "the plan net ships off; it needs a plan the weak models never write");
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theOperatorsOwnNumbersReachTheReplsGuard(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "progressGuardWrites": 7,
                  "progressGuardFailures": 0,
                  "progressGuardPlanTurns": 4 }
                """);
        try {
            SpectroCli cli = interactive(workspace);

            assertEquals(7, cli.agent().progressGuard().settings().identicalWrites());
            assertEquals(0, cli.agent().progressGuard().settings().repeatedFailures(),
                    "zero is the off switch and it has to survive the whole chain — a knob"
                            + " that silently reverts to 3 is worse than no knob");
            assertEquals(4, cli.agent().progressGuard().settings().stalledPlanTurns());
        } finally {
            restoreUserSettings(previous);
        }
    }
}
