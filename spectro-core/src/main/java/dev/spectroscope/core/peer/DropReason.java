package dev.spectroscope.core.peer;

/**
 * Why the inbox dropped a message (card 502 criterion 7). The texts are the
 * house wording of reader 01, Delivery item 4, and travel in the
 * {@code peer_message_status} frame as {@code drop_reason}.
 */
public enum DropReason {
    /** The sender's token bucket is empty. */
    RATE_LIMITED("rate_limited", "the sender exceeded this session's message rate limit"),
    /** The same words as the sender's previous message, inside the window. */
    DUPLICATE("duplicate", "identical to the previous message from this sender"),
    /** The hop chain names this session too often. */
    LOOP("loop", "this message has already passed through this session"),
    /** The hop chain is longer than the limit. */
    RUNAWAY("runaway", "the relay chain of this message is too long"),
    /** The session's queue of undelivered messages is at its cap. */
    QUEUE_FULL("queue_full", "this session has too many undelivered messages queued");

    private final String wireName;
    private final String text;

    DropReason(String wireName, String text) {
        this.wireName = wireName;
        this.text = text;
    }

    /** @return the name on the wire */
    public String wireName() {
        return wireName;
    }

    /** @return the reason in words, for the sender's notice */
    public String text() {
        return text;
    }
}
