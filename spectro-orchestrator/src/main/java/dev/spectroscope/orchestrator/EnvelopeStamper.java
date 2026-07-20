package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;

/**
 * One stamper per sender: wraps RunEvents into envelopes with a monotonic
 * sequence and the causal chain (each envelope's parent is the sender's
 * previous envelope — the bus-proof's publish-time chain, provable by
 * walking parentId back to the root marker).
 *
 * <p>Not thread-safe on purpose: a sender is one lane on one virtual
 * thread; two threads sharing a stamper would interleave one causal chain.</p>
 */
final class EnvelopeStamper {

    private final String sender;
    private final String contextId;
    private final String topic;
    private long sequence = 0;
    private String lastId = BusEnvelope.CHAIN_ROOT;

    EnvelopeStamper(String sender, String contextId, String topic) {
        this.sender = sender;
        this.contextId = contextId;
        this.topic = topic;
    }

    /**
     * Wraps one event; sequence advances, the causal chain links to the
     * sender's previous envelope.
     *
     * @param taskId the assignment this event belongs to (bus correlation)
     * @param event  the RunEvent to carry verbatim
     * @return the stamped envelope, ready to publish
     */
    BusEnvelope stamp(String taskId, RunEvent event) {
        BusEnvelope env = new BusEnvelope(
                sender, contextId, taskId, sequence++, lastId, topic,
                System.currentTimeMillis(), event);
        lastId = env.id();
        return env;
    }
}
