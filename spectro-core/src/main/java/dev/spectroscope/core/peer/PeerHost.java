package dev.spectroscope.core.peer;

import java.util.List;

/** The face a {@link PeerNode} serves: the server, the REPL, a headless run, a cron fire or a node (card 502). */
public interface PeerHost {

    /** @return {@code server}, {@code repl}, {@code headless}, {@code cron} or {@code node} */
    String face();

    /** @return true when a person is attached; an unattended face refuses every message */
    boolean attended();

    /** @return false when this face takes no messages at all (card 503's switch) */
    boolean accepting();

    /** @return the sessions this process hosts right now */
    List<PeerSession> sessions();
}
