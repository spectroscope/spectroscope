package dev.spectroscope.server.shell;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A PTY that never touches the OS — the fake the card asks for ("the PTY layer
 * sits behind a seam and is unit-tested with a fake"). Three shapes in one:
 * a scripted stream (a fixed reply then EOF), an endless flood (for the
 * backpressure proof, counting every byte the session actually pulls), and a
 * write side that can be made to block (for the wedged-input proof).
 */
final class FakePty implements PtyProvider.Pty {

    /** Bytes handed to {@link #write} in order — the keystroke side. */
    final List<byte[]> written = new ArrayList<>();
    /** Resize calls as {rows, cols} pairs. */
    final List<int[]> resizes = new ArrayList<>();
    /** How many bytes the session's reader pulled out of the output stream. */
    final AtomicLong bytesRead = new AtomicLong();
    final AtomicBoolean closed = new AtomicBoolean();

    private final InputStream output;
    private final boolean blockWrites;
    private final CountDownLatch writeGate = new CountDownLatch(1);
    private int exit = 0;

    private FakePty(InputStream output, boolean blockWrites) {
        this.output = output;
        this.blockWrites = blockWrites;
    }

    /** A pty that emits {@code text} and then reaches EOF (the shell exited). */
    static FakePty scripted(String text) {
        return new FakePty(new ByteArrayInputStream(text.getBytes()), false);
    }

    /** A pty whose output never ends — the flood the outbound queue must bound. */
    static FakePty flood() {
        return new FakePty(null, false);
    }

    /** A pty whose {@link #write} blocks forever — a shell that stopped reading. */
    static FakePty wedgedInput() {
        return new FakePty(new ByteArrayInputStream(new byte[0]), true);
    }

    @Override
    public InputStream output() {
        InputStream source = output;
        return new InputStream() {
            @Override
            public int read() throws IOException {
                byte[] one = new byte[1];
                int n = read(one, 0, 1);
                return n < 0 ? -1 : one[0] & 0xff;
            }

            @Override
            public int read(byte[] buf, int off, int len) throws IOException {
                if (closed.get()) {
                    return -1;
                }
                if (source == null) { // the flood
                    java.util.Arrays.fill(buf, off, off + len, (byte) 'x');
                    bytesRead.addAndGet(len);
                    return len;
                }
                int n = source.read(buf, off, len);
                if (n > 0) {
                    bytesRead.addAndGet(n);
                }
                return n;
            }
        };
    }

    @Override
    public void write(byte[] data) throws IOException {
        if (blockWrites) {
            try {
                writeGate.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted", interrupted);
            }
        }
        synchronized (written) {
            written.add(data);
        }
    }

    @Override
    public void resize(int rows, int cols) {
        synchronized (resizes) {
            resizes.add(new int[] {rows, cols});
        }
    }

    @Override
    public boolean alive() {
        return !closed.get();
    }

    @Override
    public long pid() {
        return 0L;
    }

    @Override
    public int awaitExit(long millis) {
        return exit;
    }

    @Override
    public void close() {
        closed.set(true);
        writeGate.countDown();
    }

    /** The bytes handed to write(), flattened — order preserved. */
    String writtenText() {
        StringBuilder out = new StringBuilder();
        synchronized (written) {
            for (byte[] chunk : written) {
                out.append(new String(chunk));
            }
        }
        return out.toString();
    }
}
