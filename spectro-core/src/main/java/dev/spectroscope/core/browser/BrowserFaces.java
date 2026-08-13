package dev.spectroscope.core.browser;

/**
 * Every session's browser, keyed by session id — the directory card 218 needed
 * and card 201 did not have.
 *
 * <p><b>Why this is a second interface rather than a method on
 * {@link BrowserFace}.</b> A {@code BrowserFace} is ONE browser: it is attached
 * or it is not, it is showing one address, and one verb goes to it. That is
 * exactly what {@link BrowserTools} needs and all it should ever know. Keying is
 * a different job, and it belongs to the thing that owns the channel. Splitting
 * them means the tools cannot address a session even in principle: they are
 * handed one face, already resolved, and there is no argument on any of the
 * seven schemas that could name another one. The isolation is then a property of
 * the wiring rather than a rule somebody has to keep.
 *
 * <p><b>Who chooses the key.</b> The SERVER, always — it is the session's store
 * id, minted when the session mints its store. It never comes from the model,
 * from a tool argument or from a remote caller, which is why
 * {@code browser_navigate} still refuses {@code tab_id} rather than treating it
 * as a session selector.
 */
public interface BrowserFaces {

    /**
     * Whether a desktop shell is on the other end at all.
     *
     * <p>Channel-level and therefore the same answer for every session: one
     * shell holds one control channel, and a session's browser can only exist
     * inside it.
     *
     * @return true when a shell is attached
     */
    boolean attached();

    /**
     * The browser belonging to one session, created there on first use.
     *
     * <p>Cheap and total: it never returns null and never opens anything. The
     * browser itself is built in the shell when a verb first reaches it, so a
     * session that never calls a browser tool never costs a Chromium session.
     *
     * @param sessionId the session's store id
     * @return that session's face, never null
     */
    BrowserFace forSession(String sessionId);

    /**
     * Ends one session's browser: its page, its cookies, its storage.
     *
     * <p>Fire and forget, and that is a requirement rather than a shortcut: this
     * runs on the thread tearing a socket down, and a shell that has already
     * gone must not hold it for a reply deadline.
     *
     * @param sessionId the session that closed
     */
    void closeSession(String sessionId);

    /**
     * The directory a {@code spectro web} reader has: one that hands every
     * session the same honest {@link BrowserFace#none()}.
     *
     * @return a directory in which no session has a browser
     */
    static BrowserFaces none() {
        return new BrowserFaces() {
            @Override
            public boolean attached() {
                return false;
            }

            @Override
            public BrowserFace forSession(String sessionId) {
                return BrowserFace.none();
            }

            @Override
            public void closeSession(String sessionId) {
                // Nothing was ever opened, so nothing has to be closed.
            }
        };
    }
}
