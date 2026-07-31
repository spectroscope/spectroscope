package dev.spectroscope.cli;

import java.nio.file.ClosedWatchServiceException;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * The fs trigger (card 72): a thin thread around the {@link DirWatch} seam,
 * all logic in the pure {@link FsDebouncer}. The loop alternates draining the
 * debouncer against the injected clock and polling the seam — its poll
 * timeout is derived from the open window's deadline, so a fire is never
 * later than the quiet period plus one poll granularity.
 */
final class FsWatchTrigger implements TriggerSource {

    /** Quiet period: the first event opens it, everything inside coalesces. */
    static final long WINDOW_MS = 500;
    /** Poll granularity while no window is open. */
    static final long IDLE_POLL_MS = 2_000;

    private final Path root;
    private final DirWatch watch;
    private final FsDebouncer debouncer;
    private final LongSupplier clock;
    private final Consumer<String> log;
    private volatile boolean closed;
    private Thread thread;

    FsWatchTrigger(Path root, DirWatch watch, LongSupplier clock, Consumer<String> log) {
        this.root = root;
        this.watch = watch;
        this.clock = clock;
        this.log = log;
        this.debouncer = new FsDebouncer(describe(), WINDOW_MS, log);
    }

    @Override
    public String describe() {
        return "watch:" + root;
    }

    @Override
    public void start(FireSink sink) {
        thread = Thread.ofVirtual().name("spectro-trigger-watch").start(() -> {
            try {
                while (!closed) {
                    long now = clock.getAsLong();
                    Fire ready = debouncer.drain(now);
                    if (ready != null && sink.offer(ready) == FireSlot.Disposition.REFUSED) {
                        // Cross-kind refusal only (fs merges into fs): the next
                        // change re-fires, so the loss is a skip, not silence.
                        log.accept("watch: fire skipped — the slot already holds another kind");
                    }
                    Long deadline = debouncer.deadline();
                    long timeout = deadline == null ? IDLE_POLL_MS
                            : Math.max(1, deadline - clock.getAsLong());
                    List<FsDebouncer.Change> changes = watch.poll(timeout);
                    debouncer.offer(changes, clock.getAsLong());
                }
            } catch (InterruptedException | ClosedWatchServiceException end) {
                // closing — the loop's regular way out while parked in poll
            }
        });
    }

    @Override
    public void close() {
        closed = true;
        watch.close();
        if (thread != null) {
            thread.interrupt();
        }
    }
}
