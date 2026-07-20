package dev.spectroscope.orchestrator;

import java.util.function.Consumer;

/**
 * The transport seam (mirrored on the McpTransport
 * pattern): publish envelopes, subscribe per topic. In-memory today, a
 * process/file transport next, a broker only if reality ever demands
 * one — the panel and the aggregator never know the difference.
 */
public interface BusTransport extends AutoCloseable {

    /**
     * Publishes one envelope to its topic. Implementations deliver to every
     * current subscriber of that topic; ordering per sender is preserved by
     * the envelope's own sequence, not by the transport.
     *
     * @param frame the envelope to deliver
     */
    void publish(BusEnvelope frame);

    /**
     * Subscribes to one topic (= one fleet session).
     *
     * @param topic   the topic to listen on
     * @param onFrame receives every envelope published to the topic
     * @return a handle that removes the subscription again
     */
    AutoCloseable subscribe(String topic, Consumer<BusEnvelope> onFrame);

    /** Releases transport resources; in-memory has none. */
    @Override
    default void close() {}
}
