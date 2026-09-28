package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 453, criterion 1 for scheduled jobs and the headless runner: a job may
 * name {@code extended}, and a runner built with the outside reach lets its
 * write tools leave the working directory. Without it the fence holds.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class ExtendedHeadlessTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            java.util.List.of(), "gemini", true, java.util.List.of(), 2, true,
            java.util.List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
            null, false, false);

    @TempDir
    Path outer;

    private Path cwd;

    @BeforeEach
    void layout() throws IOException {
        cwd = Files.createDirectories(outer.resolve("inner"));
    }

    /** Writes one file above the working folder, then ends. */
    private static LlmProvider writesAbove() {
        Queue<List<LlmProvider.ProviderEvent>> turns = new ArrayDeque<>(List.of(
                List.of(new LlmProvider.PToolCall("c1", "write_file",
                                JSON.createObjectNode().put("path", "../above.txt").put("content", "x")),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN))));
        return request -> turns.poll();
    }

    @Test
    void aJobMayNameExtended() {
        assertEquals("extended", new Job("j", "* * * * *", "p", "/tmp", "extended").permissions());
    }

    @Test
    void aJobStillMayNotNameAsk() {
        assertThrows(IllegalArgumentException.class,
                () -> new Job("j", "* * * * *", "p", "/tmp", "ask"));
    }

    @Test
    void theJobListIsTheKnownModesWithoutAsk() {
        List<String> expected = SpectroConfig.knownPermissionModes().stream()
                .filter(mode -> !"ask".equals(mode)).sorted().toList();
        assertEquals(expected, Job.PERMISSIONS.stream().sorted().toList(),
                "a scheduled job has nobody to ask; every other known mode must be accepted");
    }

    @Test
    void aRunnerWithTheOutsideReachWritesAboveTheWorkingFolder() {
        HeadlessRunner.Outcome outcome = new HeadlessRunner(JSON, CONFIG, writesAbove())
                .withOutsideReach(true)
                .runOnce("write it", cwd, true, null, event -> { }, line -> { });
        assertTrue(outcome.exitOk());
        assertTrue(Files.exists(outer.resolve("above.txt")), "extended lifts the fence");
    }

    @Test
    void anAutoRunnerStaysFenced() {
        new HeadlessRunner(JSON, CONFIG, writesAbove())
                .runOnce("write it", cwd, true, null, event -> { }, line -> { });
        assertFalse(Files.exists(outer.resolve("above.txt")), "auto keeps the fence");
    }

    @Test
    void anExtendedJobWritesAboveItsWorkingFolder() {
        new HeadlessRunner(JSON, CONFIG, writesAbove())
                .runJob(new Job("j453", "* * * * *", "write it", cwd.toString(), "extended"), line -> { });
        assertTrue(Files.exists(outer.resolve("above.txt")));
    }

    @Test
    void anAutoJobStaysFenced() {
        new HeadlessRunner(JSON, CONFIG, writesAbove())
                .runJob(new Job("j453a", "* * * * *", "write it", cwd.toString(), "auto"), line -> { });
        assertFalse(Files.exists(outer.resolve("above.txt")));
    }

    // ---------------------------------------------------------------- review: reach needs approval

    /** Reads one file above the working folder, then ends. */
    private static LlmProvider readsAbove() {
        Queue<List<LlmProvider.ProviderEvent>> turns = new ArrayDeque<>(List.of(
                List.of(new LlmProvider.PToolCall("r1", "read_file",
                                JSON.createObjectNode().put("path", "../secret.txt")),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN))));
        return request -> turns.poll();
    }

    private List<String> readOutputs(HeadlessRunner runner, boolean autoApprove) throws IOException {
        Files.writeString(outer.resolve("secret.txt"), "secret\n");
        List<dev.spectroscope.core.events.RunEvent> events = new java.util.ArrayList<>();
        runner.runOnce("read it", cwd, autoApprove, null, events::add, line -> { });
        return events.stream()
                .filter(dev.spectroscope.core.events.RunEvent.ToolResult.class::isInstance)
                .map(e -> ((dev.spectroscope.core.events.RunEvent.ToolResult) e).output())
                .toList();
    }

    @Test
    void theReachAloneDoesNotOpenAReadonlyRun() throws IOException {
        assertEquals(List.of("ERROR: path is outside the working directory: ../secret.txt"),
                readOutputs(new HeadlessRunner(JSON, CONFIG, readsAbove()).withOutsideReach(true), false),
                "extended implies auto: a readonly run keeps the fence even with the reach set");
    }

    @Test
    void theReachDoesNotOpenARunDecidedByAnExternalBroker() throws IOException {
        HeadlessRunner runner = new HeadlessRunner(JSON, CONFIG, readsAbove())
                .withBroker(request -> true)
                .withOutsideReach(true);
        assertEquals(List.of("ERROR: path is outside the working directory: ../secret.txt"),
                readOutputs(runner, true));
    }

    @Test
    void theReachWithApprovalReadsAbove() throws IOException {
        assertEquals(List.of("secret\n"),
                readOutputs(new HeadlessRunner(JSON, CONFIG, readsAbove()).withOutsideReach(true), true));
    }
}
