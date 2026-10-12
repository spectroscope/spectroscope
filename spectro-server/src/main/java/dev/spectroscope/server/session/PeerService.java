package dev.spectroscope.server.session;

import dev.spectroscope.core.peer.LiveRecord;
import dev.spectroscope.core.peer.LiveRegistry;
import dev.spectroscope.core.peer.MessagesSidecar;
import dev.spectroscope.core.peer.PeerHost;
import dev.spectroscope.core.peer.PeerLimits;
import dev.spectroscope.core.peer.PeerNode;
import dev.spectroscope.core.peer.PeerSession;
import dev.spectroscope.core.peer.ProcessIdentity;
import dev.spectroscope.server.starter.StarterBundles;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * This server process's part in agent messaging (card 502): one
 * {@link PeerNode} for the process, fed by the live set, and the bridge the
 * live set reads names and other processes through.
 *
 * <p>One record per process, even when a test JVM holds several Spring
 * contexts: the node is shared by every live set of the process and closes
 * with the last one. The record is rewritten on every live set change through
 * the node's depth one queue, as {@code live_sessions} is sent. Every
 * {@link PeerLimits#ROSTER_POLL_MS} the registry is listed: dead records are
 * unlinked, names are checked for uniqueness, and the sessions of other
 * processes go to every page as {@code peer_roster}.</p>
 */
@Component
public class PeerService implements LiveSessions.Listener {

    private static final Logger log = LoggerFactory.getLogger(PeerService.class);

    /** The process-wide node, shared by every live set of this JVM. */
    private static final Object SHARED_LOCK = new Object();
    private static PeerNode sharedNode;
    private static final List<LiveSessions> SHARED_LIVE = new CopyOnWriteArrayList<>();
    private static ScheduledExecutorService sharedPoll;

    private final LiveSessions live;
    private final boolean enabled;
    private PeerNode node;
    private boolean shared;
    private ScheduledExecutorService poll;
    private final List<LiveSessions> hosted = new CopyOnWriteArrayList<>();
    /** Card 503: whether the process takes messages, from the user settings unless a test names a file. */
    private MessagingSwitch messagingSwitch = MessagingSwitch.USER;

    /**
     * @param live    this context's live set
     * @param enabled {@code spectro.peer.enabled}, true unless a deployment turns it off
     */
    public PeerService(LiveSessions live, @Value("${spectro.peer.enabled:true}") boolean enabled) {
        this.live = live;
        this.enabled = enabled;
    }

    /**
     * A service on its own registry, for a test: not shared, started at once.
     *
     * @param live       the live set
     * @param registry   the registry
     * @param self       the process identity to state
     * @param sidecar    the sidecar
     * @param heldExpiry the held message wait
     * @return the started service
     * @throws IOException when the socket cannot be bound
     */
    static PeerService started(LiveSessions live, LiveRegistry registry, ProcessIdentity self,
                               MessagesSidecar sidecar, Duration heldExpiry) throws IOException {
        return started(live, registry, self, sidecar, heldExpiry, MessagingSwitch.USER);
    }

    /**
     * A service on its own registry and its own settings file, for a test.
     *
     * @param live       the live set
     * @param registry   the registry
     * @param self       the process identity to state
     * @param sidecar    the sidecar
     * @param heldExpiry the held message wait
     * @param messaging  the switch the record and the inbox read
     * @return the started service
     * @throws IOException when the socket cannot be bound
     */
    static PeerService started(LiveSessions live, LiveRegistry registry, ProcessIdentity self,
                               MessagesSidecar sidecar, Duration heldExpiry, MessagingSwitch messaging)
            throws IOException {
        PeerService service = new PeerService(live, true);
        service.messagingSwitch = messaging;
        service.hosted.add(live);
        service.node = new PeerNode(registry, self, StarterBundles.VERSION, service.host(service.hosted), sidecar,
                heldExpiry);
        service.node.start();
        service.wire();
        return service;
    }

    /** Starts the process node, or joins it when another context of this JVM has. */
    @PostConstruct
    public void start() {
        if (!enabled) {
            return;
        }
        synchronized (SHARED_LOCK) {
            if (sharedNode == null) {
                PeerNode created = PeerNode.forThisProcess(host(SHARED_LIVE), StarterBundles.VERSION);
                try {
                    created.start();
                } catch (IOException | RuntimeException failure) {
                    log.warn("agent messaging is off for this process: {}", failure.toString());
                    return;
                }
                sharedNode = created;
                sharedPoll = Executors.newSingleThreadScheduledExecutor(r -> {
                    Thread t = new Thread(r, "spectro-peer-roster");
                    t.setDaemon(true);
                    return t;
                });
                sharedPoll.scheduleWithFixedDelay(PeerService::pollShared, PeerLimits.ROSTER_POLL_MS,
                        PeerLimits.ROSTER_POLL_MS, TimeUnit.MILLISECONDS);
            }
            SHARED_LIVE.add(live);
            node = sharedNode;
            shared = true;
        }
        wire();
    }

    /** Leaves the node; the last live set closes it and deletes the record. */
    @PreDestroy
    public void stop() {
        live.removeListener(this);
        live.bridge(null);
        if (poll != null) {
            poll.shutdownNow();
        }
        if (!shared) {
            if (node != null) {
                node.close();
            }
            return;
        }
        synchronized (SHARED_LOCK) {
            SHARED_LIVE.remove(live);
            if (SHARED_LIVE.isEmpty() && sharedNode != null) {
                sharedPoll.shutdownNow();
                sharedNode.close();
                sharedNode = null;
            }
        }
    }

    @Override
    public void onLiveSessions(List<LiveSessions.LiveSession> rows) {
        PeerNode current = node;
        if (current != null) {
            current.changed();
        }
    }

    /** Lists the registry and writes the record now; a test reads the result at once. */
    void flushForTest() {
        refresh(node, hosted.isEmpty() ? List.of(live) : hosted);
    }

    /** @return the switch the record and the inbox read */
    MessagingSwitch messagingSwitch() {
        return messagingSwitch;
    }

    /** @return the node, or null when messaging is off */
    PeerNode node() {
        return node;
    }

    private void wire() {
        live.bridge(new LiveSessions.PeerBridge() {
            @Override
            public String nameOf(String sessionId) {
                return node.nameOf(sessionId);
            }

            @Override
            public List<LiveRecord> others() {
                long self = ProcessHandle.current().pid();
                List<LiveRecord> out = new ArrayList<>();
                for (LiveRecord record : node.lastRoster()) {
                    if (record.pid() != self) {
                        out.add(record);
                    }
                }
                return out;
            }

            @Override
            public void decide(String sessionId, String msgId, boolean deliver) {
                node.decide(sessionId, msgId, deliver);
            }

            @Override
            public PeerNode node() {
                return node;
            }
        });
        live.addListener(this);
        if (!shared) {
            poll = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "spectro-peer-roster");
                t.setDaemon(true);
                return t;
            });
            poll.scheduleWithFixedDelay(() -> refresh(node, hosted), PeerLimits.ROSTER_POLL_MS,
                    PeerLimits.ROSTER_POLL_MS, TimeUnit.MILLISECONDS);
        }
    }

    private static void pollShared() {
        PeerNode current;
        synchronized (SHARED_LOCK) {
            current = sharedNode;
        }
        refresh(current, SHARED_LIVE);
    }

    private static void refresh(PeerNode current, List<LiveSessions> lives) {
        if (current == null) {
            return;
        }
        try {
            List<LiveRecord> roster = current.roster();
            current.flush();
            long self = ProcessHandle.current().pid();
            List<LiveSessions.LiveSession> rows = new ArrayList<>();
            for (LiveRecord record : roster) {
                if (record.pid() != self) {
                    rows.addAll(LiveSessions.rowsOf(record));
                }
            }
            for (LiveSessions one : lives) {
                one.publishRoster(rows);
            }
        } catch (RuntimeException failure) {
            log.warn("peer roster not refreshed: {}", failure.toString());
        }
    }

    private PeerHost host(List<LiveSessions> lives) {
        return new PeerHost() {
            @Override
            public String face() {
                return "server";
            }

            @Override
            public boolean attended() {
                return true;
            }

            @Override
            public boolean accepting() {
                return messagingSwitch.isOn();
            }

            @Override
            public List<PeerSession> sessions() {
                List<PeerSession> out = new ArrayList<>();
                for (LiveSessions one : lives) {
                    out.addAll(one.ports());
                }
                return out;
            }
        };
    }
}
