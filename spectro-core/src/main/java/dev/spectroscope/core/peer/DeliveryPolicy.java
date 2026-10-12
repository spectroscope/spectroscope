package dev.spectroscope.core.peer;

/**
 * What a receiving session does with a message that passed the guards (card
 * 502 criterion 6, concept decisions 4 and 5).
 */
public final class DeliveryPolicy {

    /** The receiving side's move. */
    public enum Action {
        /** A run is up: the message waits for its next safe point. */
        QUEUE,
        /** Idle and of the sender's class: a run starts with the message as input. */
        START_RUN,
        /** Idle and of another class: held for Deliver or Decline. */
        HOLD,
        /** An unattended face, or a session that takes no messages. */
        REFUSE
    }

    private DeliveryPolicy() {
    }

    /**
     * @param attended    whether a person is attached to the receiving face
     * @param accepting   whether the receiving face takes messages at all
     * @param running     whether the receiving session has a run up
     * @param mode        the receiving session's permission mode
     * @param senderClass the sender's permission class, as it travelled
     * @return the move
     */
    public static Action decide(boolean attended, boolean accepting, boolean running, String mode,
                                String senderClass) {
        if (!attended || !accepting) {
            return Action.REFUSE;
        }
        if (running) {
            return Action.QUEUE;
        }
        return senderClass != null && PermissionClass.sameClass(PermissionClass.of(mode), senderClass)
                ? Action.START_RUN
                : Action.HOLD;
    }
}
