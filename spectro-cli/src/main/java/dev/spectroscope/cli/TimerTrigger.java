package dev.spectroscope.cli;

import java.util.function.Consumer;

/**
 * The timer trigger (card 72): one virtual thread, one fire per elapsed
 * period. No fire at boot — the prompt is written against "time passed",
 * and firing at t=0 AND t=period would be the surprising double. A tick
 * refused by a busy slot is a logged skip, the cron overlap precedent.
 */
final class TimerTrigger implements TriggerSource {

    private final long periodMs;
    private final String label;
    private final Consumer<String> log;
    private volatile boolean closed;
    private Thread thread;

    TimerTrigger(long periodMs, String label, Consumer<String> log) {
        this.periodMs = periodMs;
        this.label = label;
        this.log = log;
    }

    @Override
    public String describe() {
        return "every:" + label;
    }

    @Override
    public void start(FireSink sink) {
        thread = Thread.ofVirtual().name("spectro-trigger-every").start(() -> {
            try {
                while (!closed) {
                    Thread.sleep(periodMs);
                    if (closed) {
                        return;
                    }
                    if (sink.offer(Fire.timer(describe())) == FireSlot.Disposition.REFUSED) {
                        log.accept("timer: tick skipped — a fire is already queued (overlap skips)");
                    }
                }
            } catch (InterruptedException end) {
                // closing — the regular way out of the sleep
            }
        });
    }

    @Override
    public void close() {
        closed = true;
        if (thread != null) {
            thread.interrupt();
        }
    }
}
