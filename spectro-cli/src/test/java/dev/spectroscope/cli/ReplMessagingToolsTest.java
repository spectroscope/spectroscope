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
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 503 on the REPL: the interactive face registers send_message and
 * list_agents beside the spawn tools, and with agentMessaging off the agent
 * leaves both out of its next request.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ReplMessagingToolsTest {

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

    private static List<String> advertised(SpectroCli cli) {
        return cli.agent().toolSpecsForNextRun().stream().map(spec -> spec.name()).toList();
    }

    @Test
    void theReplOffersBothMessagingTools(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SpectroCli cli = new SpectroCli();
            new CommandLine(cli).parseArgs("--workspace", workspace.toString());
            cli.anchorAt(workspace);
            cli.openInteractiveSession(new BufferedReader(new StringReader("")));
            List<String> names = cli.belt().specs().stream().map(spec -> spec.name()).toList();
            assertTrue(names.contains("send_message"), names.toString());
            assertTrue(names.contains("list_agents"), names.toString());
            assertTrue(names.contains("wait_agents"), "card 505: " + names);
            assertTrue(advertised(cli).contains("send_message"));
            assertTrue(advertised(cli).contains("wait_agents"));
        } finally {
            restore(previous);
        }
    }

    @Test
    void theKeyOffLeavesBothOutOfTheRequest(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\","
                + " \"agentMessaging\": false}");
        try {
            SpectroCli cli = new SpectroCli();
            new CommandLine(cli).parseArgs("--workspace", workspace.toString());
            cli.anchorAt(workspace);
            cli.openInteractiveSession(new BufferedReader(new StringReader("")));
            List<String> names = advertised(cli);
            assertFalse(names.contains("send_message"), names.toString());
            assertFalse(names.contains("list_agents"), names.toString());
            assertFalse(names.contains("wait_agents"), "card 505: " + names);
            assertTrue(names.contains("read_file"), names.toString());
        } finally {
            restore(previous);
        }
    }
}
