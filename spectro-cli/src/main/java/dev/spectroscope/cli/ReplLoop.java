package dev.spectroscope.cli;

import dev.spectroscope.core.loop.LoopDriver;
import dev.spectroscope.core.loop.LoopSidecar;
import dev.spectroscope.core.loop.LoopState;
import dev.spectroscope.core.loop.WakeupTimer;

import java.io.BufferedReader;
import java.io.IOException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Card 504, criterion 6: the REPL's loop. The REPL has no
 * {@code CronScheduler}; a timer thread of its own process holds the wakeup,
 * and a wakeup that fires hands the REPL's input loop its next input while
 * the REPL waits at its prompt.
 *
 * <p>The REPL reads stdin on its own thread, and the permission prompt and
 * the voice channel read the same reader, so nothing else may read stdin.
 * While a loop runs, the prompt therefore waits for whichever comes first,
 * a typed line or a fired wakeup, by asking the reader whether a line is
 * ready between short waits on the fire queue. Without a loop the prompt
 * reads the console exactly as before.</p>
 */
final class ReplLoop {

    /** How long the prompt waits on the fire queue between two looks at the console. */
    static final long POLL_MS = 100L;

    /**
     * What the prompt hands the REPL next.
     *
     * @param line  a typed line, or null at the end of the input or for a fire
     * @param fire  a fired wakeup, or null for a typed line
     * @param ended true at the end of the input
     */
    record Input(String line, Fire fire, boolean ended) {
    }

    /**
     * A fired wakeup.
     *
     * @param record what the record shows as the prompt
     * @param model  what the model reads
     */
    record Fire(String record, String model) {
    }

    private final WakeupTimer timer;
    private final LongSupplier clock;
    private final LoopSidecar sidecar;
    private final BooleanSupplier running;
    private final Consumer<String> print;
    private final BlockingQueue<Fire> fires = new LinkedBlockingQueue<>();
    private final LoopDriver.Host host = new Host();

    private volatile LoopDriver driver;
    private volatile String sessionId;
    private volatile boolean atPrompt;

    /**
     * @param timer   what holds the wakeups
     * @param clock   epoch millis
     * @param sidecar the {@code .loop.jsonl} writer
     * @param running true while the REPL runs a turn
     * @param print   where the loop's lines go
     */
    ReplLoop(WakeupTimer timer, LongSupplier clock, LoopSidecar sidecar, BooleanSupplier running,
             Consumer<String> print) {
        this.timer = timer;
        this.clock = clock;
        this.sidecar = sidecar;
        this.running = running;
        this.print = print;
    }

    /**
     * The REPL process's loop on its own daemon timer thread.
     *
     * @param running true while the REPL runs a turn
     * @param print   where the loop's lines go
     * @return the loop
     */
    static ReplLoop onTimerThread(BooleanSupplier running, Consumer<String> print) {
        return new ReplLoop(WakeupTimer.on(Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "spectro-repl-loop-timer");
            thread.setDaemon(true);
            return thread;
        })), System::currentTimeMillis, new LoopSidecar(LoopSidecar.defaultDir()), running, print);
    }

    /**
     * The session's loop, made when it has none. A new session ends the
     * loop of the old one as {@code user_abort}, so it cannot fire into the
     * new conversation.
     *
     * @param id the session
     * @return its driver
     */
    synchronized LoopDriver driver(String id) {
        if (driver != null && !id.equals(sessionId)) {
            driver.userAbort();
            driver.detach(host);
            driver = null;
        }
        if (driver == null) {
            LoopDriver restored = LoopDriver.restore(id, timer, clock, sidecar);
            driver = restored != null ? restored : new LoopDriver(id, timer, clock, sidecar);
            sessionId = id;
            driver.host(host);
        }
        return driver;
    }

    /** @return the loop, or null when the REPL never ran one */
    LoopDriver driverIfAny() {
        return driver;
    }

    /** @return true while a loop runs */
    boolean active() {
        LoopDriver current = driver;
        return current != null && current.active();
    }

    /**
     * The prompt: the next typed line, or a fired wakeup while a loop runs.
     *
     * @param console the REPL's reader
     * @return what comes next
     * @throws IOException when the console fails
     * @throws InterruptedException when the REPL thread is interrupted
     */
    Input next(BufferedReader console) throws IOException, InterruptedException {
        atPrompt = true;
        try {
            LoopDriver current = driver;
            if (current != null) {
                current.poke(); // a wakeup held while the REPL ran fires now
            }
            while (true) {
                Fire fire = fires.poll();
                if (fire != null) {
                    return new Input(null, fire, false);
                }
                if (!active() && fires.isEmpty()) {
                    String line = console.readLine();
                    return new Input(line, null, line == null);
                }
                if (console.ready()) {
                    String line = console.readLine();
                    return new Input(line, null, line == null);
                }
                fire = fires.poll(POLL_MS, TimeUnit.MILLISECONDS);
                if (fire != null) {
                    return new Input(null, fire, false);
                }
            }
        } finally {
            atPrompt = false;
        }
    }

    /** The REPL as its loop sees it: attended, idle at the prompt. */
    private final class Host implements LoopDriver.Host {
        @Override
        public boolean attached() {
            return true;
        }

        @Override
        public boolean idle() {
            return atPrompt && !running.getAsBoolean() && fires.isEmpty();
        }

        @Override
        public boolean startRun(String record, String model) {
            if (!idle()) {
                return false;
            }
            return fires.offer(new Fire(record, model));
        }

        @Override
        public void info(LoopState state) {
            print.accept(line(state));
        }
    }

    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm:ss");

    /**
     * @param state the loop
     * @return the line the terminal prints for it
     */
    static String line(LoopState state) {
        if (state.loopId() == null) {
            return "[loop] none";
        }
        if (!state.active()) {
            return "[loop] ended: " + state.endedReason();
        }
        if (state.nextAt() == null) {
            return "[loop] waiting for schedule_wakeup";
        }
        return "[loop] next wakeup at " + CLOCK.format(Instant.ofEpochMilli(state.nextAt())
                .atZone(ZoneId.systemDefault())) + (state.reason() == null ? "" : ": " + state.reason())
                + (state.held() ? " (held until the prompt is free)" : "");
    }
}
