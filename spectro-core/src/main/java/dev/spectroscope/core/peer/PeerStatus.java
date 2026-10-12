package dev.spectroscope.core.peer;

/** The six outcomes a {@code peer_message_status} frame reports (card 502 criterion 4). */
public enum PeerStatus {
    /** Waiting for the receiving operator's Deliver or Decline. */
    HELD("held"),
    /** The receiving operator declined it. */
    DENIED("denied"),
    /** Held, and nobody decided before the wait ran out. */
    EXPIRED("expired"),
    /** The receiving model has it. */
    DELIVERED("delivered"),
    /** The receiving session takes no messages. */
    REFUSED("refused"),
    /** A guard at the inbox dropped it. */
    DROPPED("dropped");

    private final String wireName;

    PeerStatus(String wireName) {
        this.wireName = wireName;
    }

    /** @return the word on the wire */
    public String wireName() {
        return wireName;
    }

    /**
     * @param word a word off the wire
     * @return the status, or null for an unknown word
     */
    public static PeerStatus of(String word) {
        for (PeerStatus status : values()) {
            if (status.wireName.equals(word)) {
                return status;
            }
        }
        return null;
    }
}
