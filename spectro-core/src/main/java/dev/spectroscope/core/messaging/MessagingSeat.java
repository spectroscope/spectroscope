package dev.spectroscope.core.messaging;

import java.util.List;

/**
 * What the two messaging tools need from the face that hosts the calling
 * agent (card 503): who the caller is, whom it can reach, and how a message
 * leaves. A browser session and the REPL seat their main agent on a
 * {@link dev.spectroscope.core.peer.PeerNode}; a child sits on its run.
 */
public interface MessagingSeat {

    /** @return the name other agents address the caller by */
    String selfName();

    /** @return the ref printed after that name */
    String selfRef();

    /** @return true when the caller is a child agent of a run */
    boolean child();

    /** @return the caller's agent id */
    String agentId();

    /** @return true while agent messaging is on for the caller */
    boolean on();

    /** @return the sessions on this machine the caller can reach, its own excluded; none for a child */
    List<AgentRow> sessions();

    /** @return the agents of the caller's run: its children, or for a child its parent only */
    List<AgentRow> runAgents();

    /**
     * Whether a name is another child agent of the caller's session, running
     * or finished. A child never reaches one (hub and spoke, owner
     * 2026-10-12); the answer only picks the words of the refusal.
     *
     * @param name the name the caller wrote
     * @return true when the name is another child agent
     */
    default boolean sibling(String name) {
        return false;
    }

    /**
     * Card 581: the refusal for a child of the caller's session that has
     * ended. Such a child has no row any more, so the name alone would read
     * as unknown.
     *
     * @param name the name the caller wrote
     * @return the refusal, or null when the name is no child that has ended
     */
    default String endedChild(String name) {
        return null;
    }

    /**
     * Sends to a session.
     *
     * @param row     the session
     * @param text    the body
     * @param summary the preview line
     * @return what happened
     */
    Sent sendToSession(AgentRow row, String text, String summary);

    /**
     * Sends to an agent of the run.
     *
     * @param row     the agent
     * @param text    the body
     * @param summary the preview line
     * @return what happened
     */
    Sent sendInRun(AgentRow row, String text, String summary);

    /**
     * Sends to an agent of the run, as {@code send_message} does.
     *
     * @param row      the agent
     * @param text     the body
     * @param summary  the preview line
     * @param recorded true when the caller records the message as sent once it is delivered; the
     *                 run's stream then keeps the receiver's record of it behind that one
     * @return what happened
     */
    default Sent sendInRun(AgentRow row, String text, String summary, boolean recorded) {
        return sendInRun(row, text, summary);
    }

    /**
     * Asks a session for one notice when it is next idle.
     *
     * @param row the session
     * @return what happened
     */
    Sent notifyWhenIdle(AgentRow row);

    /**
     * What one send did.
     *
     * @param ok    true when the message or the subscription left
     * @param msgId the id, when it left
     * @param error the text for the model when it did not
     */
    record Sent(boolean ok, String msgId, String error) {

        /** @param msgId the id @return a send that left */
        public static Sent ok(String msgId) {
            return new Sent(true, msgId, null);
        }

        /** @param error the text @return a send that did not leave */
        public static Sent failed(String error) {
            return new Sent(false, null, error);
        }
    }
}
