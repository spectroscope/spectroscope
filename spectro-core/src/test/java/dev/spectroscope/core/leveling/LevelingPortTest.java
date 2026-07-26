package dev.spectroscope.core.leveling;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.trace.TracingPorts;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The bridge from the live stream to the ladder. Its one hard promise is
 * negative: leveling is a nicety bolted onto an observability tool, and a
 * nicety that can take a run down has no business being in the process. The
 * port therefore registers rather than requires, and swallows its own failures
 * on top of the registry's isolation.
 */
class LevelingPortTest {

    private static RunEvent end(String reason, long ts) {
        return new RunEvent.RunEnd("run-1", reason, ts);
    }

    @Test
    void marksTheLadderFromALiveRun(@TempDir Path dir) {
        LevelingRecorder recorder = new LevelingRecorder(
                Ladder.bundled(), new LevelingStore(dir.resolve("leveling.json")),
                LevelingState.Mode.LADDER);
        LevelingPort port = new LevelingPort("20260726-aaa", recorder);

        port.onEvent(new RunEvent.TextDelta("main", "hello", 1L));
        port.onEvent(end("end_turn", 2L));

        LevelingState.Mark mark = recorder.state().marks().get("first-run-complete");
        assertNotNull(mark);
        assertEquals("20260726-aaa", mark.sessionId());
        assertEquals(1, mark.eventIndex().intValue(), "the second event of the session");
    }

    @Test
    void persistsWhatItObserved(@TempDir Path dir) {
        Path file = dir.resolve("leveling.json");
        LevelingRecorder recorder = new LevelingRecorder(
                Ladder.bundled(), new LevelingStore(file), LevelingState.Mode.LADDER);
        new LevelingPort("s1", recorder).onEvent(end("end_turn", 5L));

        LevelingState reloaded = new LevelingStore(file).read().orElseThrow();
        assertNotNull(reloaded.marks().get("first-run-complete"), "the receipt survives a restart");
    }

    @Test
    void aBrokenStoreCostsTheRunNothingAndWarnsOnce(@TempDir Path dir) throws IOException {
        // An unwritable home, produced deterministically: the parent of the state file is
        // itself a regular file, so createDirectories fails on every platform and for every
        // user, including root. A permission-based fixture would silently pass as root.
        Path blocked = dir.resolve("not-a-directory");
        Files.writeString(blocked, "in the way", StandardCharsets.UTF_8);
        LevelingRecorder recorder = new LevelingRecorder(
                Ladder.bundled(), new LevelingStore(blocked.resolve("leveling.json")),
                LevelingState.Mode.LADDER);
        LevelingPort port = new LevelingPort("s1", recorder);

        PrintStream realErr = System.err;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        System.setErr(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            assertDoesNotThrow(() -> {
                port.onEvent(end("end_turn", 1L));
                port.onEvent(end("end_turn", 2L));
                port.onEvent(end("end_turn", 3L));
            });
        } finally {
            System.setErr(realErr);
        }
        String warnings = captured.toString(StandardCharsets.UTF_8);
        assertEquals(1, warnings.lines().filter(l -> l.contains("leveling")).count(),
                "one warning, then silence:\n" + warnings);
    }

    @Test
    void aPortThatThrowsNeverReachesTheRunThroughTheRegistry() {
        List<RunEvent> delivered = new ArrayList<>();
        TracingPorts ports = new TracingPorts()
                .require(delivered::add)
                .register(event -> {
                    throw new IllegalStateException("leveling is having a bad day");
                });
        assertDoesNotThrow(() -> ports.onEvent(end("end_turn", 1L)));
        assertEquals(1, delivered.size(), "durability first: the required port still got its event");
    }

    @Test
    void modeOffNeverTouchesTheDisk(@TempDir Path dir) {
        Path file = dir.resolve("leveling.json");
        LevelingRecorder recorder = new LevelingRecorder(
                Ladder.bundled(), new LevelingStore(file), LevelingState.Mode.OFF);
        new LevelingPort("s1", recorder).onEvent(end("end_turn", 1L));
        assertTrue(Files.notExists(file), "off means off, including the file");
        assertNull(recorder.state().marks().get("first-run-complete"));
    }

    @Test
    void eachSessionCountsItsOwnEvents(@TempDir Path dir) {
        LevelingRecorder recorder = new LevelingRecorder(
                Ladder.bundled(), new LevelingStore(dir.resolve("leveling.json")),
                LevelingState.Mode.LADDER);
        LevelingPort first = new LevelingPort("s1", recorder);
        LevelingPort second = new LevelingPort("s2", recorder);
        first.onEvent(new RunEvent.TextDelta("main", "a", 1L));
        first.onEvent(new RunEvent.TextDelta("main", "b", 2L));
        second.onEvent(end("end_turn", 3L));
        assertEquals(0, recorder.state().marks().get("first-run-complete").eventIndex().intValue(),
                "s2's first event is index 0, not 2");
    }
}
