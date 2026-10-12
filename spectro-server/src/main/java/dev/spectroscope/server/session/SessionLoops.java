package dev.spectroscope.server.session;

import dev.spectroscope.core.loop.LoopDriver;
import dev.spectroscope.core.loop.LoopSidecar;
import dev.spectroscope.core.loop.WakeupTimer;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.function.LongSupplier;

/**
 * Card 504, criteria 6 and 11: the loops of the browser sessions of this
 * server process, and the timer that holds their wakeups.
 *
 * <p>The process holds them, not a socket: a socket that closes releases its
 * session at once ({@code LiveSessions.release}), but the loop stays, and a
 * wakeup that falls due while no client is attached is held in
 * {@code .loop.jsonl} until a client attaches to the session again. A server
 * that restarts rebuilds an open loop from that file on the next attach.</p>
 *
 * <p>Not {@code CronScheduler}: that one fires through {@code HeadlessRunner},
 * the unattended face card 266 keeps loops away from.</p>
 */
public final class SessionLoops {

    private static volatile SessionLoops shared;

    private final WakeupTimer timer;
    private final LongSupplier clock;
    private final LoopSidecar sidecar;
    private final Map<String, LoopDriver> drivers = new ConcurrentHashMap<>();
    /**
     * Fix round 2: sessions whose sidecar had nothing to restore. Every run
     * end asks for the loop; this process writes its sessions' loops itself,
     * so one read of the file answers for the life of the process.
     */
    private final Set<String> nothingToRestore = ConcurrentHashMap.newKeySet();

    /**
     * @param timer   what holds the wakeups
     * @param clock   epoch millis
     * @param sidecar the {@code .loop.jsonl} writer
     */
    public SessionLoops(WakeupTimer timer, LongSupplier clock, LoopSidecar sidecar) {
        this.timer = timer;
        this.clock = clock;
        this.sidecar = sidecar;
    }

    /** @return the process's loops, on one daemon timer thread and the home's sidecar folder */
    public static SessionLoops shared() {
        SessionLoops loops = shared;
        if (loops == null) {
            synchronized (SessionLoops.class) {
                loops = shared;
                if (loops == null) {
                    ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
                        Thread thread = new Thread(runnable, "spectro-loop-timer");
                        thread.setDaemon(true);
                        return thread;
                    });
                    loops = new SessionLoops(WakeupTimer.on(executor), System::currentTimeMillis,
                            new LoopSidecar(LoopSidecar.defaultDir()));
                    shared = loops;
                }
            }
        }
        return loops;
    }

    /** @return the sidecar the loops write, also where the goal check ins go */
    public LoopSidecar sidecar() {
        return sidecar;
    }

    /**
     * The session's loop, made when it has none, so a {@code /loop} can start one.
     *
     * @param sessionId the session
     * @return its driver, never null
     */
    public LoopDriver driver(String sessionId) {
        LoopDriver existing = existing(sessionId);
        if (existing != null) {
            return existing;
        }
        return drivers.computeIfAbsent(sessionId, id -> new LoopDriver(id, timer, clock, sidecar));
    }

    /**
     * The session's loop, from memory or rebuilt from its sidecar. The file
     * is read once per session: a session with nothing to restore is
     * remembered as such, and a loop {@link #driver} makes later is held in
     * memory, which is asked first.
     *
     * @param sessionId the session, or null
     * @return its driver, or null when it never ran a loop or its loop ended and was heard
     */
    public LoopDriver existing(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        LoopDriver held = drivers.get(sessionId);
        if (held != null || nothingToRestore.contains(sessionId)) {
            return held;
        }
        LoopDriver restored = LoopDriver.restore(sessionId, timer, clock, sidecar);
        if (restored == null) {
            nothingToRestore.add(sessionId);
            return drivers.get(sessionId); // a /loop that started meanwhile
        }
        LoopDriver raced = drivers.putIfAbsent(sessionId, restored);
        return raced != null ? raced : restored;
    }
}
