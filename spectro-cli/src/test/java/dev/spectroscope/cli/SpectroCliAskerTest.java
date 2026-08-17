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

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 265, criterion 3 on the OTHER face that has a person: the interactive CLI.
 *
 * <p>The name of this class was promised by {@code AskRegistrationFenceTest}'s
 * javadoc before the class existed, which is how the review found the hole: the
 * whole registration block could be deleted from {@code SpectroCli} and the
 * entire Java gate stayed green. That is card 222's finding F4 verbatim — a belt
 * every test assembles by hand pins nothing about the belt the product builds —
 * so this reads the belt off the REAL interactive assembly
 * {@link SpectroCli#openInteractiveSession} performs, the same method
 * {@code run()} calls between the config and the REPL.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpectroCliAskerTest {

    private static final String ASK = "ask_user_question";

    /** Whether the belt this CLI assembled advertises the ask. */
    private static boolean carriesTheAsk(SpectroCli cli) {
        return cli.belt().specs().stream().anyMatch(spec -> ASK.equals(spec.name()));
    }

    /** A CLI parsed as picocli parses it, so every flag holds its declared default. */
    private static SpectroCli parsed(Path workspace) {
        SpectroCli cli = new SpectroCli();
        new CommandLine(cli).parseArgs("--workspace", workspace.toString());
        return cli;
    }

    /** Points the provider at a local backend so no API key is needed. */
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
    void theInteractiveBeltCarriesTheAsk(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SpectroCli cli = parsed(workspace);
            cli.anchorAt(workspace);
            // A console at end of stream: the asker is CONSTRUCTED from it, and
            // nothing reads it until a question actually parks.
            cli.openInteractiveSession(new BufferedReader(new StringReader("")));

            assertTrue(carriesTheAsk(cli),
                    "the interactive REPL has a person on the other end, so the model sees"
                            + " the verb");
            assertFalse(cli.belt().get(ASK).orElseThrow().needsPermission(),
                    "a question has no side effect; gating it would be two prompts for one"
                            + " interaction");
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void aBeltBuiltWithNobodyOnTheConsoleCarriesNoAsk(@TempDir Path workspace) throws IOException {
        // The fence itself, from the other side. `registerTools` is the ONE
        // assembly this face has, and it is reached without an asker by anything
        // that is not the REPL — so the verb must be absent from specs() rather
        // than present and refusing. A model that knows the verb exists plans
        // around it: it announces that it will ask, and on a cron run at 3 a.m.
        // that is a whole turn spent on a capability the face does not have.
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SpectroCli cli = parsed(workspace);
            cli.anchorAt(workspace);
            cli.registerTools();

            assertFalse(carriesTheAsk(cli),
                    "no console attached, no question — the belt is the fence");
        } finally {
            restoreUserSettings(previous);
        }
    }
}
