package dev.spectroscope.server;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;

/**
 * The seam the card asks for: "the PTY layer sits behind a seam and is
 * unit-tested with a fake". Production is {@link HelperPtyProvider}, which runs
 * the bundled {@code spectro-pty} helper; the tests run a fake that never touches
 * the OS. The seam also keeps the door open for a different mechanism later
 * (pty4j is the documented fallback) without the socket side noticing, and it is
 * where Windows says "unavailable" instead of pretending.
 */
public interface PtyProvider {

    /**
     * Whether this process can open a terminal at all. False makes the endpoint
     * absent rather than an endpoint that fails — a missing helper is a build
     * fact, not a runtime error the operator should have to read about.
     *
     * @return true when a PTY can be opened
     */
    boolean available();

    /**
     * The program that will be started. Reported to the client so the pane can
     * say which shell it is, and it comes from the SERVER's environment — a
     * browser never chooses the program.
     *
     * @return the absolute path of the shell, or null when none was found
     */
    String shellPath();

    /**
     * Open one terminal.
     *
     * @param cwd  the directory the shell starts in — the session's workspace
     * @param rows initial window height
     * @param cols initial window width
     * @return the live terminal; closing it reaps the child
     * @throws IOException when the helper or the shell could not be started
     */
    Pty open(Path cwd, int rows, int cols) throws IOException;

    /** One live terminal. Every method is safe to call after {@link #close}. */
    interface Pty extends AutoCloseable {

        /**
         * The terminal's output. Read it on a thread of your own; nothing here
         * is ever logged, because a shell is where passwords get typed.
         *
         * @return the byte stream from the terminal, ending when the shell exits
         */
        InputStream output();

        /**
         * Send keystrokes.
         *
         * @param data raw bytes from the client
         * @throws IOException when the terminal is gone
         */
        void write(byte[] data) throws IOException;

        /**
         * Resize the window, which raises SIGWINCH in the shell.
         *
         * @param rows new height
         * @param cols new width
         * @throws IOException when the terminal is gone
         */
        void resize(int rows, int cols) throws IOException;

        /**
         * Whether the terminal's process is still running.
         *
         * @return true while the helper lives
         */
        boolean alive();

        /**
         * The helper's process id — the handle a {@code ps} check starts from, and
         * how a test finds the shell underneath it.
         *
         * @return the pid, or 0 for a fake
         */
        long pid();

        /**
         * Wait for the shell to finish.
         *
         * @param millis how long to wait
         * @return the exit code, or -1 when it is still running or unknown
         */
        int awaitExit(long millis);

        /** Reap the child. Idempotent — the socket-close path and the registry both call it. */
        @Override
        void close();
    }
}
