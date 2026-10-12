package dev.spectroscope.core.peer;

/** One hosted session as a {@link PeerNode} reads and drives it (card 502). */
public interface PeerSession {

    /** @return the session id */
    String id();

    /** @return the session's folder, or null */
    String cwd();

    /** @return the session title of card 445, or null when none is set */
    String title();

    /** @return the permission mode */
    String mode();

    /** @return true while a run is in flight */
    boolean running();

    /** @return what the harness knows the session is doing, without a model call */
    String statusLine();

    /** @return the running turn, or null */
    Integer turn();

    /** @return when the session became live here, epoch millis */
    long since();

    /** @return the session's peer inbox; open while a run is up */
    PeerInbox inbox();

    /**
     * Starts a run whose prompt is the attributed text, when the session is idle.
     *
     * @param prompt one or more attribution blocks
     * @return false when a run is already up, so the caller queues instead
     */
    boolean startRun(String prompt);

    /**
     * @param name a name
     * @return true when the name is a running child of this session's run
     */
    boolean isChild(String name);

    /** @param event what the page and the record should learn */
    void onPeerEvent(PeerEvent event);

    /**
     * Card 503: the main agent's last text, which an idle notice quotes in
     * part. A face that keeps none says null.
     *
     * @return the text, or null
     */
    default String lastText() {
        return null;
    }
}
