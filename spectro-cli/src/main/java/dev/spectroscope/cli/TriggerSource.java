package dev.spectroscope.cli;

/**
 * One thing a standing node waits on (card 72). A source runs its own thread
 * (or server) and pushes fires into the node's {@link FireSlot} through the
 * sink; the returned disposition lets a source answer its caller honestly
 * (http's 429) or log a skip (timer) — a plain source may ignore it.
 */
interface TriggerSource extends AutoCloseable {

    /** The slot's face toward the sources. */
    @FunctionalInterface
    interface FireSink {
        FireSlot.Disposition offer(Fire fire);
    }

    /**
     * Starts producing fires. Called once, before the trigger loop takes.
     *
     * @param sink the node's fire slot
     */
    void start(FireSink sink);

    /** @return the identity on the card and the boot line — "watch:/abs/path",
     *          "listen:127.0.0.1:8300" or "every:5m" */
    String describe();

    /** Narrowed: closing a source never throws — shutdown must not fail. */
    @Override
    void close();
}
