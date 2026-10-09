package dev.spectroscope.cli;

import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.goal.GoalStore;
import dev.spectroscope.core.subagents.RoleCatalog;
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

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 470 on the terminal face: the discovery paragraph is in the system
 * prompt the REPL's agent runs with, read off {@link SpectroCli#openInteractiveSession},
 * the real assembly {@code run()} performs, and again after {@code /clear}
 * recomposes the prompt for a new session.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpectroCliDiscoveryGuidanceTest {

    private static final String SETTINGS = "{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}";

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

    @Test
    void theReplIsBuiltWithTheDiscoveryParagraph(@TempDir Path workspace) throws IOException {
        String previous = saveForUser(SETTINGS);
        SpectroCli cli = null;
        try {
            cli = interactive(workspace);
            assertTrue(RoleCatalog.DISCOVERY_GUIDANCE.contains("explore child"),
                    "the premise: the paragraph is not empty, so 'contains' below is not vacuous");
            assertTrue(cli.agent().systemPrompt().contains(RoleCatalog.DISCOVERY_GUIDANCE),
                    "the prompt the REPL's agent runs with: " + cli.agent().systemPrompt());

            cli.handleSlashCommand("/clear");
            assertTrue(cli.agent().systemPrompt().contains(RoleCatalog.DISCOVERY_GUIDANCE),
                    "the prompt /clear recomposes: " + cli.agent().systemPrompt());
        } finally {
            if (cli != null && cli.sessionId() != null) {
                Files.deleteIfExists(GoalStore.fileFor(cli.sessionId()));
            }
            restoreUserSettings(previous);
        }
    }

    @Test
    void theReplStartsFromTheSharedBasePrompt(@TempDir Path workspace) throws IOException {
        String previous = saveForUser(SETTINGS);
        SpectroCli cli = null;
        try {
            cli = interactive(workspace);
            assertTrue(RoleCatalog.BASE_SYSTEM_PROMPT.contains(RoleCatalog.DISCOVERY_GUIDANCE),
                    "the premise: the shared base prompt carries the paragraph");
            assertTrue(cli.agent().systemPrompt().startsWith(RoleCatalog.BASE_SYSTEM_PROMPT),
                    "the REPL opens with the base prompt core holds, not a copy: " + cli.agent().systemPrompt());

            cli.handleSlashCommand("/clear");
            assertTrue(cli.agent().systemPrompt().startsWith(RoleCatalog.BASE_SYSTEM_PROMPT),
                    "the prompt /clear recomposes opens the same way: " + cli.agent().systemPrompt());
        } finally {
            if (cli != null && cli.sessionId() != null) {
                Files.deleteIfExists(GoalStore.fileFor(cli.sessionId()));
            }
            restoreUserSettings(previous);
        }
    }
}
