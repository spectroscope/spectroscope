package dev.spectroscope.cli;

import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.loop.ContinuationLeash;
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
 * Card 266 on the second attended face: the interactive REPL.
 *
 * <p>Read off {@link SpectroCli#openInteractiveSession}, the REAL assembly
 * {@code run()} performs between the config and the REPL — never off a
 * hand-built {@code AgentOptions}. Card 262 lost exactly this reader once: the
 * whole guard clause could be deleted from the CLI and the full gate stayed
 * green, because the server face had a wiring test and this one had nothing.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpectroCliContinuationLeashTest {

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
    void theInteractiveReplRunsWithTheLeashOnTheShippedBudget(@TempDir Path workspace)
            throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SpectroCli cli = interactive(workspace);

            assertNotNull(cli.agent().continuationLeash(),
                    "a person sits at this console and sees the bill grow — this is one of"
                            + " the two attended faces the owner's first call names");
            assertEquals(ContinuationLeash.DEFAULT_BUDGET,
                    cli.agent().continuationLeash().budget(),
                    "the shipped default, read through the settings chain");
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theOperatorsOwnBudgetReachesTheReplsLeash(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("""
                { "provider": "ollama", "model": "qwen3:latest",
                  "continuationBudget": 0 }
                """);
        try {
            SpectroCli cli = interactive(workspace);

            assertEquals(0, cli.agent().continuationLeash().budget(),
                    "zero is the off switch and it has to survive the whole chain — a knob"
                            + " that silently reverts to 3 is worse than no knob");
        } finally {
            restoreUserSettings(previous);
        }
    }
}
