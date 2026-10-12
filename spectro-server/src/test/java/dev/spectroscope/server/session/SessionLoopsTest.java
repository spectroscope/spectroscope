package dev.spectroscope.server.session;

import dev.spectroscope.core.loop.LoopDriver;
import dev.spectroscope.core.loop.LoopSidecar;
import dev.spectroscope.core.loop.WakeupTimer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 504 fix round 2: the holder reads a session's sidecar once. Every run
 * end, Stop and compaction of a browser session asks {@link SessionLoops#existing};
 * a session that never ran a loop, or whose loop ended and was heard, has
 * nothing to restore, and the holder remembers that instead of reading the
 * file again on each ask. The process is the only writer of its sessions'
 * loops, so a line another writer adds later is not read.
 */
class SessionLoopsTest {

    private static final WakeupTimer NO_TIMER = (task, delayMs) -> () -> { };

    private static void appendLoopStart(LoopSidecar sidecar, String sessionId) throws IOException {
        Path file = sidecar.fileFor(sessionId);
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{\"type\":\"loop_start\",\"ts\":1,\"loopId\":\"behind\",\"pacing\":\"fixed\","
                        + "\"prompt\":\"written behind the holder's back\",\"intervalSeconds\":120}\n",
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    }

    @Test
    void aSessionWithNothingToRestoreIsReadOnce(@TempDir Path dir) throws IOException {
        LoopSidecar sidecar = new LoopSidecar(dir);
        SessionLoops loops = new SessionLoops(NO_TIMER, () -> 1_000L, sidecar);
        assertThat(loops.existing("s-quiet")).isNull();
        appendLoopStart(sidecar, "s-quiet");
        assertThat(LoopDriver.restore("s-quiet", NO_TIMER, () -> 1_000L, sidecar))
                .as("premise: the line would restore a loop if read").isNotNull();
        assertThat(loops.existing("s-quiet")).as("the second ask does not read the file again").isNull();
    }

    @Test
    void aLoopStartedAfterAMissIsHeld(@TempDir Path dir) {
        SessionLoops loops = new SessionLoops(NO_TIMER, () -> 1_000L, new LoopSidecar(dir));
        assertThat(loops.existing("s-later")).isNull();
        LoopDriver made = loops.driver("s-later");
        made.start("check", 120);
        assertThat(loops.existing("s-later")).isSameAs(made);
        assertThat(loops.existing("s-later").active()).isTrue();
    }

    @Test
    void aSessionWhoseLoopIsOpenIsRestoredOnTheFirstAsk(@TempDir Path dir) throws IOException {
        // The positive beside the miss: an open loop in the file still comes back.
        LoopSidecar sidecar = new LoopSidecar(dir);
        appendLoopStart(sidecar, "s-open");
        SessionLoops loops = new SessionLoops(NO_TIMER, () -> 1_000L, sidecar);
        LoopDriver restored = loops.existing("s-open");
        assertThat(restored).isNotNull();
        assertThat(restored.active()).isTrue();
        assertThat(loops.existing("s-open")).isSameAs(restored);
    }
}
