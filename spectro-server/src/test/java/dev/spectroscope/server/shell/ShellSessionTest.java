package dev.spectroscope.server.shell;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * One shell: the pump between a PTY and a socket. The properties under test are
 * the ones that decide whether this feature is safe to leave running — the
 * outbound path is <b>bounded</b> (a screenful-per-millisecond {@code yes} must
 * not grow the heap), the inbound path never blocks a container thread, and
 * every exit path closes the child.
 */
class ShellSessionTest {

    /** A sink that records; optionally blocks in data() until released. */
    private static final class RecordingSink implements ShellSession.Sink {
        final List<byte[]> chunks = new ArrayList<>();
        final List<String> status = new ArrayList<>();
        final AtomicReference<String> closedWith = new AtomicReference<>();
        final CountDownLatch release;

        RecordingSink(boolean block) {
            this.release = block ? new CountDownLatch(1) : null;
        }

        @Override
        public void data(byte[] chunk) throws IOException {
            if (release != null) {
                try {
                    release.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("interrupted", interrupted);
                }
            }
            synchronized (chunks) {
                chunks.add(chunk);
            }
        }

        @Override
        public void status(String json) {
            synchronized (status) {
                status.add(json);
            }
        }

        @Override
        public void closeSocket(String reason) {
            closedWith.set(reason);
        }

        String text() {
            StringBuilder out = new StringBuilder();
            synchronized (chunks) {
                chunks.forEach(c -> out.append(new String(c)));
            }
            return out.toString();
        }

        String statusText() {
            synchronized (status) {
                return String.join("\n", status);
            }
        }
    }

    @Test
    void ptyOutputReachesTheSocketAndTheExitIsAnnounced() throws Exception {
        FakePty pty = FakePty.scripted("hello from zsh\n");
        RecordingSink sink = new RecordingSink(false);
        ShellSession shell = ShellSession.start(pty, sink, "test-1");
        try {
            waitUntil(() -> sink.text().contains("hello from zsh"));
            waitUntil(() -> sink.statusText().contains("shell_exit"));
            assertTrue(sink.statusText().contains("\"code\":0"), sink.statusText());
            assertNotNull(sink.closedWith.get(), "the socket closes when the shell exits");
        } finally {
            shell.close();
        }
    }

    @Test
    void keystrokesReachThePtyOffTheContainerThread() throws Exception {
        FakePty pty = FakePty.flood();
        RecordingSink sink = new RecordingSink(false);
        ShellSession shell = ShellSession.start(pty, sink, "test-2");
        try {
            shell.onData("echo $ZSH_THEME\n".getBytes());
            waitUntil(() -> pty.writtenText().contains("echo $ZSH_THEME"));
        } finally {
            shell.close();
        }
    }

    @Test
    void aResizeIsForwardedToThePty() throws Exception {
        FakePty pty = FakePty.flood();
        ShellSession shell = ShellSession.start(pty, new RecordingSink(false), "test-3");
        try {
            shell.onResize(48, 200);
            waitUntil(() -> !pty.resizes.isEmpty());
            assertEquals(48, pty.resizes.get(0)[0]);
            assertEquals(200, pty.resizes.get(0)[1]);
        } finally {
            shell.close();
        }
    }

    @Test
    void aFloodIntoASlowSocketIsBoundedNotBuffered() throws Exception {
        // The property: with the socket wedged, the reader stops pulling from the
        // pty once the outbound queue is full. The pty's own buffer then fills and
        // the shell blocks on write — the flow control a real terminal has. What
        // must NEVER happen is an unbounded queue eating the heap.
        FakePty pty = FakePty.flood();
        RecordingSink stuck = new RecordingSink(true);
        ShellSession shell = ShellSession.start(pty, stuck, "test-4");
        try {
            long ceiling = (long) (ShellSession.OUT_QUEUE_CHUNKS + 4) * ShellSession.READ_CHUNK;
            // Give the reader far more time than it needs to overshoot if unbounded.
            Thread.sleep(600);
            long pulled = pty.bytesRead.get();
            assertTrue(pulled > 0, "the reader did start");
            assertTrue(pulled <= ceiling,
                    "outbound is unbounded: pulled " + pulled + " bytes, ceiling " + ceiling);
            // And it stays put: a second look must not have grown.
            Thread.sleep(400);
            assertTrue(pty.bytesRead.get() <= ceiling,
                    "outbound kept growing: " + pty.bytesRead.get());
        } finally {
            stuck.release.countDown();
            shell.close();
        }
    }

    @Test
    void aWedgedShellClosesTheSessionInsteadOfQueueingForever() throws Exception {
        // Inbound is bounded too. A shell that stopped reading its input must not
        // let the browser accumulate keystrokes without limit; the session dies.
        FakePty pty = FakePty.wedgedInput();
        RecordingSink sink = new RecordingSink(false);
        ShellSession shell = ShellSession.start(pty, sink, "test-5");
        try {
            for (int i = 0; i < ShellSession.IN_QUEUE_CHUNKS * 2 + 16; i++) {
                shell.onData(new byte[] {'x'});
            }
            waitUntil(() -> sink.closedWith.get() != null);
            assertTrue(shell.isClosed(), "a wedged shell is closed, not left queueing");
        } finally {
            shell.close();
        }
    }

    @Test
    void closingTheSessionClosesThePty() throws Exception {
        FakePty pty = FakePty.flood();
        ShellSession shell = ShellSession.start(pty, new RecordingSink(false), "test-6");
        shell.close();
        assertTrue(pty.closed.get(), "close() must reap the child");
        assertTrue(shell.isClosed());
        // Idempotent — the socket-close path and the registry both call it.
        shell.close();
    }

    @Test
    void dataAfterCloseIsDropped() throws Exception {
        FakePty pty = FakePty.flood();
        ShellSession shell = ShellSession.start(pty, new RecordingSink(false), "test-7");
        shell.close();
        shell.onData("rm -rf /\n".getBytes());
        Thread.sleep(100);
        assertFalse(pty.writtenText().contains("rm -rf"), "a closed shell accepts nothing");
    }

    /** Poll a condition for up to five seconds. */
    private static void waitUntil(java.util.function.BooleanSupplier condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("condition never became true within 5s");
    }
}
