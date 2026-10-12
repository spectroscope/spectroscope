package dev.spectroscope.cli;

import dev.spectroscope.core.peer.PeerEvent;
import dev.spectroscope.core.peer.PeerHost;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.peer.PeerNode;
import dev.spectroscope.core.peer.PeerSession;

import java.nio.file.Path;
import java.util.List;
import java.util.function.Supplier;

/**
 * Card 502: a CLI face registers its process under {@code ~/.spectro/live} at
 * start and deletes the record at exit. The REPL is attended; {@code spectro
 * run}, {@code spectro cron} and {@code spectro node} are not, so they list
 * themselves for others to see and refuse every inbound message (concept
 * decision 5, rule 5 of {@code konzept/ORCHESTRATION.md} section 6).
 *
 * <p>Messaging never breaks a run: a socket that cannot be bound leaves the
 * face unregistered and says so in one line on stderr.</p>
 */
final class PeerFace {

    /** Test seam: sees each node right after it started. */
    static volatile java.util.function.Consumer<PeerNode> started = node -> { };

    private PeerFace() {
    }

    /**
     * Registers this process.
     *
     * @param face     {@code repl}, {@code headless}, {@code cron} or {@code node}
     * @param attended true only for the REPL
     * @param sessions the sessions to list, read at every record write
     * @return the running node, or null when it could not start
     */
    static PeerNode register(String face, boolean attended, Supplier<List<PeerSession>> sessions) {
        return register(face, attended, sessions, () -> true);
    }

    /**
     * Card 503: as {@link #register(String, boolean, Supplier)}, with the
     * agentMessaging switch, which a face reads when it starts.
     *
     * @param face      the face word
     * @param attended  whether a person is attached
     * @param sessions  the sessions to list, read at every record write
     * @param accepting false when this face takes no messages
     * @return the running node, or null when it could not start
     */
    static PeerNode register(String face, boolean attended, Supplier<List<PeerSession>> sessions,
                             java.util.function.BooleanSupplier accepting) {
        PeerHost host = new PeerHost() {
            @Override
            public String face() {
                return face;
            }

            @Override
            public boolean attended() {
                return attended;
            }

            @Override
            public boolean accepting() {
                return accepting.getAsBoolean();
            }

            @Override
            public List<PeerSession> sessions() {
                return sessions.get();
            }
        };
        PeerNode node = PeerNode.forThisProcess(host, PeerNode.productVersion());
        try {
            node.start();
        } catch (Exception failure) {
            System.err.println("agent messaging is off for this process: " + failure.getMessage());
            return null;
        }
        Runtime.getRuntime().addShutdownHook(new Thread(node::close, "spectro-peer-exit"));
        started.accept(node);
        return node;
    }

    /**
     * A session of an unattended face: listed, never started by a message.
     *
     * @param id   the session id
     * @param cwd  its folder
     * @param mode its permission mode
     * @return the port
     */
    static PeerSession unattended(String id, Path cwd, String mode) {
        PeerInbox inbox = new PeerInbox();
        long since = System.currentTimeMillis();
        return new PeerSession() {
            @Override
            public String id() {
                return id;
            }

            @Override
            public String cwd() {
                return cwd == null ? null : cwd.toString();
            }

            @Override
            public String title() {
                return null;
            }

            @Override
            public String mode() {
                return mode;
            }

            @Override
            public boolean running() {
                return true;
            }

            @Override
            public String statusLine() {
                return "working";
            }

            @Override
            public Integer turn() {
                return null;
            }

            @Override
            public long since() {
                return since;
            }

            @Override
            public PeerInbox inbox() {
                return inbox;
            }

            @Override
            public boolean startRun(String prompt) {
                return false;
            }

            @Override
            public boolean isChild(String name) {
                return false;
            }

            @Override
            public void onPeerEvent(PeerEvent event) {
            }
        };
    }

    /**
     * Closes a node if one started.
     *
     * @param node the node, or null
     */
    static void close(PeerNode node) {
        if (node != null) {
            node.close();
        }
    }
}
