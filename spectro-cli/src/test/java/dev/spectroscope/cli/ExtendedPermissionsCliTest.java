package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 453, criteria 1, 9 and 10 on the command line: {@code spectro run} and
 * {@code spectro node} accept {@code --permissions extended}, the help names
 * it, the flag lists agree with the core list, and a node run with it writes
 * above its working folder.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class ExtendedPermissionsCliTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            java.util.List.of(), "gemini", true, java.util.List.of(), 2, true,
            java.util.List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
            null, false, false);

    @Test
    void runAcceptsExtended() {
        assertNull(RunCommand.permissionsError("extended"));
        assertNull(RunCommand.permissionsError("auto"));
        assertNull(RunCommand.permissionsError("readonly"));
    }

    @Test
    void runStillRefusesAskAndNamesExtendedInTheRefusal() {
        String refusal = RunCommand.permissionsError("ask");
        assertTrue(refusal != null && refusal.contains("\"extended\""), String.valueOf(refusal));
    }

    @Test
    void nodeAcceptsExtended() {
        assertNull(NodeCommand.permissionsError("extended"));
        for (String mode : List.of("readonly", "auto", "ask")) {
            assertNull(NodeCommand.permissionsError(mode), mode);
        }
        String refusal = NodeCommand.permissionsError("everything");
        assertTrue(refusal != null && refusal.contains("\"extended\""), String.valueOf(refusal));
    }

    @Test
    void extendedApprovesAndReachesAutoOnlyApproves() {
        assertTrue(HeadlessPermissions.approves("extended"));
        assertTrue(HeadlessPermissions.reachesOutside("extended"));
        assertTrue(HeadlessPermissions.approves("auto"));
        assertFalse(HeadlessPermissions.reachesOutside("auto"));
        assertFalse(HeadlessPermissions.approves("readonly"));
        assertFalse(HeadlessPermissions.reachesOutside("readonly"));
        assertFalse(HeadlessPermissions.approves("ask"));
        assertFalse(HeadlessPermissions.reachesOutside("ask"));
    }

    @Test
    void theHelpOfBothCommandsNamesExtended() {
        assertTrue(new CommandLine(new RunCommand()).getUsageMessage().contains("extended"));
        assertTrue(new CommandLine(new NodeCommand()).getUsageMessage().contains("extended"));
    }

    // ---------------------------------------------------------------- criterion 10

    @Test
    void theFlagListsAgreeWithTheCoreList() {
        Set<String> known = new TreeSet<>(SpectroConfig.knownPermissionModes());
        assertEquals(known, new TreeSet<>(NodeCommand.PERMISSIONS),
                "spectro node accepts every known mode");
        Set<String> run = new TreeSet<>(RunCommand.PERMISSIONS);
        run.add("ask"); // a headless run has nobody to ask
        assertEquals(known, run, "spectro run accepts every known mode except ask");
    }

    // ---------------------------------------------------------------- node honours it

    private static LlmProvider writesAbove() {
        Queue<List<LlmProvider.ProviderEvent>> turns = new ArrayDeque<>(List.of(
                List.of(new LlmProvider.PToolCall("c1", "write_file",
                                JSON.createObjectNode().put("path", "../above.txt").put("content", "x")),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN))));
        return request -> turns.poll();
    }

    private static void runNode(Path cwd, boolean reach) {
        // Port 1: nothing listens, so the bus is dead and the run is local.
        NodeCommand.execute(JSON, CONFIG, writesAbove(),
                new NodeCommand.NodeSpec("127.0.0.1", 1, "node-453", 1L, "fleet-453", "worker",
                        "write it", cwd, true, null, reach),
                new SessionStore(), line -> { });
    }

    @Test
    void anExtendedNodeWritesAboveItsWorkingFolder(@TempDir Path outer) throws IOException {
        Path cwd = Files.createDirectories(outer.resolve("inner"));
        runNode(cwd, true);
        assertTrue(Files.exists(outer.resolve("above.txt")));
    }

    @Test
    void anAutoNodeStaysFenced(@TempDir Path outer) throws IOException {
        Path cwd = Files.createDirectories(outer.resolve("inner"));
        runNode(cwd, false);
        assertFalse(Files.exists(outer.resolve("above.txt")));
    }
}
