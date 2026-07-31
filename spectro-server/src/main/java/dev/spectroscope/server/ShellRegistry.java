package dev.spectroscope.server;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Every live shell in this process: who is allowed one, how many, and — the part
 * the llama-server reap lesson paid for — that none of them survives the JVM.
 *
 * <p>The caps are checked BEFORE the PTY is created, which is why {@link #open}
 * takes a factory instead of a terminal: a caller over the limit never gets a
 * child process that then has to be cleaned up.</p>
 *
 * <p>The shutdown hook follows the {@link dev.spectroscope.core.local.LocalRuntime}
 * pattern exactly — registered while a child is live, deregistered when the last
 * one goes — so a SIGTERM'd server takes its shells with it, and an idle server
 * carries no hook it does not need. The helper's own stdin-EOF rule covers the
 * case where no hook ever runs at all.</p>
 */
final class ShellRegistry {

    /** Tabs one session may hold open at once. */
    static final int MAX_PER_SESSION = 8;
    /** Shells this whole server process may hold open at once. */
    static final int MAX_TOTAL = 32;

    /** Thrown when a cap would be exceeded; the caller closes the socket. */
    static final class TooManyShells extends RuntimeException {
        TooManyShells(String message) {
            super(message);
        }
    }

    /** Creates a terminal — invoked under the registry's lock, after the caps pass. */
    interface PtyFactory {
        /**
         * @return a fresh terminal
         * @throws IOException when it could not be started
         */
        PtyProvider.Pty create() throws IOException;
    }

    private record Entry(String sessionId, ShellSession shell) {}

    /** socketId → the shell that socket owns. Guarded by {@code this}. */
    private final Map<String, Entry> live = new LinkedHashMap<>();

    /** The JVM shutdown hook while at least one shell runs (visible for tests). */
    Thread reaper;

    /**
     * Open a shell for one socket.
     *
     * @param socketId  the WebSocket id — one shell per socket, one socket per tab
     * @param sessionId the chat session the tab belongs to, for the per-session cap
     * @param factory   creates the terminal once the caps allow it
     * @param sink      where the shell's output goes
     * @return the running session
     * @throws TooManyShells when a cap would be exceeded — nothing is spawned
     * @throws IOException   when the terminal could not be started
     */
    synchronized ShellSession open(String socketId, String sessionId, PtyFactory factory,
            ShellSession.Sink sink) throws IOException {
        if (live.size() >= MAX_TOTAL) {
            throw new TooManyShells("this server already runs " + MAX_TOTAL + " shells");
        }
        if (countFor(sessionId) >= MAX_PER_SESSION) {
            throw new TooManyShells("this session already runs " + MAX_PER_SESSION + " shells");
        }
        PtyProvider.Pty pty = factory.create();
        ShellSession shell;
        try {
            shell = ShellSession.start(pty, sink, socketId);
        } catch (RuntimeException failedToStart) {
            pty.close(); // never leave a child behind a failed start
            throw failedToStart;
        }
        live.put(socketId, new Entry(sessionId, shell));
        armReaper();
        return shell;
    }

    /**
     * The shell a socket owns.
     *
     * @param socketId the socket
     * @return its session, or null when there is none
     */
    synchronized ShellSession get(String socketId) {
        Entry entry = live.get(socketId);
        return entry == null ? null : entry.shell();
    }

    /**
     * Close one socket's shell. Idempotent.
     *
     * @param socketId the socket whose shell is reaped
     */
    synchronized void close(String socketId) {
        Entry entry = live.remove(socketId);
        if (entry != null) {
            entry.shell().close();
        }
        disarmReaperIfIdle();
    }

    /** Close every shell — what the shutdown hook runs. */
    synchronized void closeAll() {
        List<Entry> all = new ArrayList<>(live.values());
        live.clear();
        for (Entry entry : all) {
            entry.shell().close();
        }
        disarmReaperIfIdle();
    }

    /** @return how many shells are live right now */
    synchronized int live() {
        return live.size();
    }

    /**
     * How many shells one session holds.
     *
     * @param sessionId the session to count
     * @return the count
     */
    synchronized long countFor(String sessionId) {
        return live.values().stream().filter(e -> e.sessionId().equals(sessionId)).count();
    }

    private void armReaper() {
        if (reaper != null) {
            return;
        }
        reaper = new Thread(this::closeAll, "spectro-shell-reaper");
        Runtime.getRuntime().addShutdownHook(reaper);
    }

    private void disarmReaperIfIdle() {
        if (!live.isEmpty() || reaper == null) {
            return;
        }
        try {
            Runtime.getRuntime().removeShutdownHook(reaper);
        } catch (IllegalStateException jvmAlreadyShuttingDown) {
            // the reaper itself invoked us — nothing left to deregister
        }
        reaper = null;
    }
}
