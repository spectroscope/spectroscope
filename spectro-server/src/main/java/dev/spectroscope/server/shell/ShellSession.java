package dev.spectroscope.server.shell;

import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * One shell: the pump between a PTY and a socket, and the place the flow control
 * lives.
 *
 * <p><b>Outbound is bounded by blocking, not by dropping.</b> A {@code yes} or a
 * {@code find /} produces a screenful per millisecond; a queue that grew to keep
 * up would eat the heap, and a queue that dropped its oldest chunk would corrupt
 * the escape stream mid-sequence and leave the renderer wrong with no way to
 * resync. So the reader blocks on a full queue, the terminal's own buffer fills
 * behind it, and the shell blocks in {@code write()} — which is what a slow
 * terminal has always done to a fast program. Bytes are never lost and memory per
 * shell is capped at {@link #OUT_QUEUE_CHUNKS} × {@link #READ_CHUNK}.</p>
 *
 * <p><b>Inbound is bounded by closing.</b> Keystrokes must not be dropped either,
 * and they cannot be allowed to accumulate: a shell that stopped reading its input
 * ends the session instead. Both directions run on their own threads so no
 * container thread ever blocks on a pipe.</p>
 *
 * <p>Nothing in here logs the stream. A shell is where passwords get typed.</p>
 */
final class ShellSession {

    /** Outbound chunks in flight — 64 × 8 KiB, so half a megabyte per shell. */
    static final int OUT_QUEUE_CHUNKS = 64;
    /** Keystroke frames waiting for a shell that is not reading. */
    static final int IN_QUEUE_CHUNKS = 256;
    /** One read from the terminal. */
    static final int READ_CHUNK = 8192;

    /** Where a shell's output and status go — the socket in production. */
    interface Sink {
        /**
         * Terminal bytes, in order.
         *
         * @param chunk the bytes to transmit
         * @throws IOException when the socket is gone; the session then closes
         */
        void data(byte[] chunk) throws IOException;

        /**
         * One control message (ready, exit, error) as JSON.
         *
         * @param json the message
         * @throws IOException when the socket is gone
         */
        void status(String json) throws IOException;

        /**
         * End the connection.
         *
         * @param reason short, and never carrying terminal content
         */
        void closeSocket(String reason);
    }

    /** One queued client action: keystrokes when {@code data} is set, else a resize. */
    private record Input(byte[] data, int rows, int cols) {}

    /** The zero-length marker the reader enqueues when the shell has exited. */
    private static final byte[] END = new byte[0];

    private final PtyProvider.Pty pty;
    private final Sink sink;
    private final BlockingQueue<byte[]> outbound = new ArrayBlockingQueue<>(OUT_QUEUE_CHUNKS);
    private final BlockingQueue<Input> inbound = new ArrayBlockingQueue<>(IN_QUEUE_CHUNKS);
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile int exitCode = -1;
    private Thread reader;
    private Thread writer;
    private Thread feeder;

    private ShellSession(PtyProvider.Pty pty, Sink sink) {
        this.pty = pty;
        this.sink = sink;
    }

    /**
     * Start pumping.
     *
     * @param pty  the terminal to drive
     * @param sink where its output goes
     * @param name a short id for the thread names
     * @return the running session
     */
    static ShellSession start(PtyProvider.Pty pty, Sink sink, String name) {
        ShellSession shell = new ShellSession(pty, sink);
        shell.reader = daemon(shell::pumpOut, "spectro-shell-out-" + name);
        shell.writer = daemon(shell::pumpSink, "spectro-shell-send-" + name);
        shell.feeder = daemon(shell::pumpIn, "spectro-shell-in-" + name);
        shell.reader.start();
        shell.writer.start();
        shell.feeder.start();
        return shell;
    }

    /**
     * Queue keystrokes. Called from a container thread, so it never blocks: a full
     * queue means the shell stopped reading, and that ends the session.
     *
     * @param keystrokes the decoded bytes
     */
    void onData(byte[] keystrokes) {
        offer(new Input(keystrokes, 0, 0));
    }

    /**
     * Queue a resize. Same queue as the keystrokes on purpose — it keeps the
     * ordering honest and keeps the container thread off the pipe.
     *
     * @param rows new height
     * @param cols new width
     */
    void onResize(int rows, int cols) {
        offer(new Input(null, rows, cols));
    }

    private void offer(Input input) {
        if (closed.get()) {
            return;
        }
        if (!inbound.offer(input)) {
            sink.closeSocket("the shell stopped reading its input");
            close();
        }
    }

    /** @return whether this session has been closed */
    boolean isClosed() {
        return closed.get();
    }

    /** Reap the child and stop the pumps. Idempotent. */
    void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        pty.close();
        interrupt(reader);
        interrupt(writer);
        interrupt(feeder);
    }

    // ---- the three pumps --------------------------------------------------------

    /** Terminal to queue. The blocking put IS the flow control. */
    private void pumpOut() {
        byte[] buffer = new byte[READ_CHUNK];
        try (InputStream from = pty.output()) {
            while (!closed.get()) {
                int read = from.read(buffer, 0, buffer.length);
                if (read < 0) {
                    break;
                }
                if (read == 0) {
                    continue;
                }
                byte[] chunk = new byte[read];
                System.arraycopy(buffer, 0, chunk, 0, read);
                outbound.put(chunk);
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
            return;
        } catch (IOException ended) {
            // the terminal closed — fall through to the exit notice
        }
        exitCode = pty.awaitExit(3000);
        try {
            outbound.put(END);
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        }
    }

    /** Queue to socket. The only place that touches the sink's data channel. */
    private void pumpSink() {
        try {
            while (true) {
                byte[] chunk = outbound.take();
                if (chunk == END) {
                    sink.status("{\"type\":\"shell_exit\",\"code\":" + exitCode + "}");
                    sink.closeSocket("the shell exited");
                    close();
                    return;
                }
                sink.data(chunk);
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (IOException socketGone) {
            close();
        }
    }

    /** Queue to terminal. */
    private void pumpIn() {
        try {
            while (true) {
                Input input = inbound.take();
                if (input.data() != null) {
                    pty.write(input.data());
                } else {
                    pty.resize(input.rows(), input.cols());
                }
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (IOException terminalGone) {
            close();
        }
    }

    private static Thread daemon(Runnable body, String name) {
        Thread thread = new Thread(body, name);
        // Daemon: a stray pump must never be the reason a JVM refuses to exit.
        // Platform, not virtual: a blocking read on a process pipe pins its
        // carrier thread, so a virtual thread would buy nothing and cost clarity.
        thread.setDaemon(true);
        return thread;
    }

    private static void interrupt(Thread thread) {
        if (thread != null && thread != Thread.currentThread()) {
            thread.interrupt();
        }
    }
}
