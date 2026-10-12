package dev.spectroscope.cli;

import dev.spectroscope.core.loop.LoopDriver;
import dev.spectroscope.core.loop.LoopPrompts;
import dev.spectroscope.core.loop.LoopSidecar;
import dev.spectroscope.core.loop.WakeupTimer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.PipedReader;
import java.io.PipedWriter;
import java.io.StringReader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criterion 6 on the REPL: a timer of the REPL process holds the
 * wakeup and a fired wakeup is the input loop's next input while it waits at
 * its prompt; a typed line still comes through, and without a loop the prompt
 * reads the console as before.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ReplLoopTest {

    private static final long T0 = 1_800_000_000_000L;

    /** A wakeup timer moved by hand. */
    static final class HandTimer implements WakeupTimer, java.util.function.LongSupplier {
        private long now = T0;
        private final List<Object[]> tasks = new ArrayList<>();

        @Override
        public synchronized long getAsLong() {
            return now;
        }

        @Override
        public synchronized Cancellable schedule(Runnable task, long delayMs) {
            Object[] entry = {now + Math.max(0, delayMs), task, Boolean.FALSE};
            tasks.add(entry);
            return () -> {
                synchronized (HandTimer.this) {
                    entry[2] = Boolean.TRUE;
                }
            };
        }

        void advanceTo(long to) {
            while (true) {
                Object[] next;
                synchronized (this) {
                    next = tasks.stream().filter(t -> !(Boolean) t[2] && (Long) t[0] <= to)
                            .min(Comparator.comparingLong(t -> (Long) t[0])).orElse(null);
                    if (next == null) {
                        now = Math.max(now, to);
                        return;
                    }
                    now = Math.max(now, (Long) next[0]);
                    next[2] = Boolean.TRUE;
                }
                ((Runnable) next[1]).run();
            }
        }
    }

    private static void awaitTrue(java.util.function.BooleanSupplier condition) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > until) {
                throw new AssertionError("timed out");
            }
            Thread.sleep(5);
        }
    }

    @Test
    void aWakeupThatFallsDueAtThePromptIsTheNextInput(@TempDir Path dir) throws Exception {
        HandTimer timer = new HandTimer();
        List<String> printed = new CopyOnWriteArrayList<>();
        AtomicBoolean running = new AtomicBoolean(false);
        ReplLoop loop = new ReplLoop(timer, timer, new LoopSidecar(dir), running::get, printed::add);
        LoopDriver driver = loop.driver("s-repl");
        LoopDriver.Start start = driver.start("check the build", 120);
        assertTrue(start.modelText().startsWith("check the build"));
        driver.runEnded(); // the command's own run

        try (PipedWriter typed = new PipedWriter(); PipedReader reader = new PipedReader(typed)) {
            BufferedReader console = new BufferedReader(reader);
            CompletableFuture<ReplLoop.Input> next = CompletableFuture.supplyAsync(() -> {
                try {
                    return loop.next(console);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            Thread.sleep(3 * ReplLoop.POLL_MS);
            assertFalse(next.isDone(), "nothing typed and nothing due");
            timer.advanceTo(driver.state().nextAt());
            ReplLoop.Input input = next.get(10, TimeUnit.SECONDS);
            assertNotNull(input.fire(), "the fired wakeup is the next input");
            assertEquals("check the build", input.fire().record());
            assertTrue(input.fire().model().startsWith("check the build"), input.fire().model());
        }
        assertTrue(printed.stream().anyMatch(line -> line.startsWith("[loop] next wakeup at ")), printed.toString());
    }

    @Test
    void aTypedLineStillComesThroughWhileALoopRuns(@TempDir Path dir) throws Exception {
        HandTimer timer = new HandTimer();
        ReplLoop loop = new ReplLoop(timer, timer, new LoopSidecar(dir), () -> false, line -> { });
        loop.driver("s-repl").start("watch", null);
        ReplLoop.Input input = loop.next(new BufferedReader(new StringReader("hello\n")));
        assertEquals("hello", input.line());
        assertNull(input.fire());
    }

    @Test
    void withoutALoopThePromptReadsTheConsoleAsBefore(@TempDir Path dir) throws Exception {
        HandTimer timer = new HandTimer();
        ReplLoop loop = new ReplLoop(timer, timer, new LoopSidecar(dir), () -> false, line -> { });
        ReplLoop.Input input = loop.next(new BufferedReader(new StringReader("")));
        assertTrue(input.ended(), "the end of the input ends the REPL as before");
        assertNull(input.line());
    }

    @Test
    void aWakeupDueWhileTheReplRunsIsHeldUntilThePromptIsFree(@TempDir Path dir) throws Exception {
        HandTimer timer = new HandTimer();
        AtomicBoolean running = new AtomicBoolean(true);
        ReplLoop loop = new ReplLoop(timer, timer, new LoopSidecar(dir), running::get, line -> { });
        LoopDriver driver = loop.driver("s-repl");
        driver.start("watch the build", null);
        driver.schedule(60.0, "one minute", LoopPrompts.SENTINEL, false);
        timer.advanceTo(driver.state().nextAt());
        assertTrue(driver.state().held(), "held while the REPL runs");
        running.set(false);
        driver.runEnded();
        ReplLoop.Input input = loop.next(new BufferedReader(new StringReader("")));
        assertNotNull(input.fire(), "the held wakeup fires at the next prompt");
        assertTrue(input.fire().model().startsWith(LoopPrompts.FULL_HEADING), input.fire().model());
    }

    @Test
    void theReplsWakeupsRunOnATimerThreadOfItsOwnProcess() throws Exception {
        ReplLoop loop = ReplLoop.onTimerThread(() -> false, line -> { });
        assertNotNull(loop);
        CompletableFuture<Thread> ran = new CompletableFuture<>();
        java.lang.reflect.Field field = ReplLoop.class.getDeclaredField("timer");
        field.setAccessible(true);
        ((WakeupTimer) field.get(loop)).schedule(() -> ran.complete(Thread.currentThread()), 0);
        Thread thread = ran.get(5, TimeUnit.SECONDS);
        assertEquals("spectro-repl-loop-timer", thread.getName());
        assertTrue(thread.isDaemon(), "the REPL exits with its last line, not with its timer");
    }

    @Test
    void aNewSessionEndsTheOldSessionsLoop(@TempDir Path dir) throws Exception {
        HandTimer timer = new HandTimer();
        ReplLoop loop = new ReplLoop(timer, timer, new LoopSidecar(dir), () -> false, line -> { });
        LoopDriver old = loop.driver("s-old");
        old.start("watch", 120);
        LoopDriver fresh = loop.driver("s-new");
        assertFalse(old.active());
        assertEquals(LoopDriver.USER_ABORT, old.state().endedReason());
        assertFalse(fresh.active());
        awaitTrue(() -> true);
    }
}
