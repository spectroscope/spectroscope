package dev.spectroscope.cli;

import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.loop.LoopDriver;
import dev.spectroscope.core.loop.ScheduleWakeupTool;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criterion 6 on the REPL's real assembly: {@code /loop} starts a
 * loop and hands its first run to the input loop, {@code /loop stop} ends it,
 * and {@code schedule_wakeup} is on the belt and offered only in a loop.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpectroCliLoopTest {

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

    private static void restore(String previous) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previous == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previous);
        }
    }

    private static boolean offered(SpectroCli cli) {
        return cli.agent().toolSpecsForNextRun().stream().anyMatch(s -> s.name().equals(ScheduleWakeupTool.NAME));
    }

    @Test
    void slashLoopStartsALoopAndHandsItsFirstRunToTheInputLoop(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SpectroCli cli = interactive(workspace);
            assertTrue(cli.belt().get(ScheduleWakeupTool.NAME).isPresent(), "on the REPL's belt");
            assertFalse(offered(cli), "not offered without a loop");

            cli.handleSlashCommand("/loop 2m check the build");
            ReplLoop.Fire first = cli.pendingLoopRun();
            assertNotNull(first);
            assertEquals("check the build", first.record());
            assertTrue(first.model().startsWith("check the build"), first.model());
            LoopDriver loop = cli.loopForTests().driverIfAny();
            assertTrue(loop.active());
            assertEquals("fixed", loop.state().pacing());
            assertEquals(120, loop.state().intervalSeconds());
            assertTrue(offered(cli), "offered in a loop");

            cli.handleSlashCommand("/loop stop");
            assertEquals(LoopDriver.USER_ABORT, loop.state().endedReason());
        } finally {
            restore(previous);
        }
    }

    @Test
    void slashLoopWithoutAPromptRunsNothing(@TempDir Path workspace) throws IOException {
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SpectroCli cli = interactive(workspace);
            cli.handleSlashCommand("/loop");
            assertNull(cli.pendingLoopRun());
            assertNull(cli.loopForTests().driverIfAny());
        } finally {
            restore(previous);
        }
    }
}
