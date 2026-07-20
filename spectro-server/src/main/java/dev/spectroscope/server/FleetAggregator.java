package dev.spectroscope.server;

import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBusHub;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The server-hosted fleet hub (block C): OWNS a {@link ProcessBusHub} when —
 * and only when — the operator opted in via {@code SPECTRO_HUB_PORT}. Default
 * OFF: a listener by default would be attack surface and port conflicts for
 * everyone who never runs a fleet; the hub itself binds loopback only. An
 * invalid port value disables the hub LOUDLY (a typo must not silently turn
 * the fleet off while the operator believes it is on — the log names it).
 *
 * <p>The feed is a local tap, never a wire self-subscription: topics are
 * discovered from the {@link NodeCard}s that ride each node's handshake (no
 * discovery protocol on the wire), and each card-announced topic is
 * subscribed once through the hub's own bounded-drain local-subscriber
 * discipline. The fold keeps every node that ever joined: departures flip to
 * disconnected instead of vanishing — an operator wants to see who WAS here.
 * Replay depth is the hub ring, documented as such; fleet persistence to
 * disk is deliberately not a feature of this bean.</p>
 *
 * <p><b>Uptime growth is a deliberate limit.</b> Every context's tap and ring
 * are retained for the server's uptime: the tap stays open because closing it
 * would end the observation, and the ring stays because a just-departed node's
 * replay is exactly what the fold preserves. The opt-in fleet hub is therefore
 * a development and observation tool, not a long-lived multi-tenant service —
 * a server hosting thousands of distinct contexts without restart grows
 * without bound, and reclaiming that memory means restarting it.</p>
 */
@Component
public class FleetAggregator implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(FleetAggregator.class);

    /** One node's place in the fold: its card, liveness, and last activity. */
    public record NodeState(NodeCard card, boolean connected, long lastSeen) {
    }

    /** What the web side plugs in: roster changes and the merged live feed. */
    public interface Listener {
        /** @param roster the full fold, stable order, after every change */
        void onRoster(List<NodeState> roster);

        /** @param envelope one fleet frame as it crossed the hub */
        void onFleetEvent(BusEnvelope envelope);
    }

    private final ProcessBusHub hub; // null = opt-out (the default)
    private final Map<String, NodeState> nodes = new ConcurrentHashMap<>();
    private final Set<String> tappedTopics = ConcurrentHashMap.newKeySet();
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();

    /**
     * @param hubPort the {@code SPECTRO_HUB_PORT} value — blank keeps the hub
     *                off, {@code 0} binds an ephemeral loopback port
     */
    public FleetAggregator(@Value("${SPECTRO_HUB_PORT:}") String hubPort) {
        this.hub = openHub(hubPort);
        if (hub != null) {
            hub.onRosterChange(this::rosterChanged);
            // The accept loop is already live: a node could have joined between
            // openHub and the line above, firing into a null listener. Fold once
            // now (idempotent) so no early join stays invisible.
            rosterChanged();
            log.info("fleet hub listening on loopback port {} (SPECTRO_HUB_PORT)", hub.port());
        }
    }

    private static ProcessBusHub openHub(String hubPort) {
        if (hubPort == null || hubPort.isBlank()) {
            return null; // the documented default: no fleet, no listener
        }
        int port;
        try {
            port = Integer.parseInt(hubPort.strip());
        } catch (NumberFormatException invalid) {
            log.warn("SPECTRO_HUB_PORT is not a port number: \"{}\" — the fleet hub stays OFF",
                    hubPort);
            return null;
        }
        if (port < 0 || port > 65535) {
            // A numeric-but-impossible port joins the typo bucket (loud, off);
            // ProcessBusHub would otherwise throw IllegalArgumentException from
            // InetSocketAddress and crash the boot past both catches below.
            log.warn("SPECTRO_HUB_PORT is out of range: \"{}\" — the fleet hub stays OFF",
                    hubPort);
            return null;
        }
        try {
            return new ProcessBusHub(port);
        } catch (IOException bindFailed) {
            // The operator explicitly asked for a hub — failing the boot is
            // honest; a silently missing hub would be the worse surprise.
            throw new UncheckedIOException(
                    "SPECTRO_HUB_PORT=" + port + " could not bind", bindFailed);
        }
    }

    /** @return true when the operator opted in and the hub is listening */
    public boolean enabled() {
        return hub != null;
    }

    /** @return the actually bound loopback port (matters for port 0) */
    public int port() {
        return hub == null ? -1 : hub.port();
    }

    /**
     * Registers a listener and hands it the current roster ATOMICALLY with
     * registration: the initial {@code onRoster} runs inside the same monitor
     * {@link #rosterChanged} holds, so a join landing between "read the roster"
     * and "start listening" can neither be lost for this listener nor arrive
     * out of order. The listener therefore MUST be non-blocking — it runs
     * under the fold monitor and, for later joins, on the hub's signal thread;
     * the web seam hands frames to a per-connection queue, never a socket
     * write.
     *
     * @param listener receives the current roster now, then every change
     */
    public synchronized void addListener(Listener listener) {
        listeners.add(listener);
        listener.onRoster(snapshot()); // the connect-time roster, atomic with registration
    }

    /** @param listener the listener to detach (a closing web socket) */
    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    /** @return the live listener count — a test pins that a closed socket detaches */
    int listenerCount() {
        return listeners.size();
    }

    /**
     * One node's JSON shape — shared by the REST roster and the
     * {@code fleet_roster} socket frame, so the two faces can never drift.
     *
     * @param state the fold entry to serialize
     * @return the insertion-ordered field map Jackson turns into the wire form
     */
    public static Map<String, Object> nodeJson(NodeState state) {
        Map<String, Object> json = new java.util.LinkedHashMap<>();
        json.put("id", state.card().id());
        json.put("role", state.card().role());
        json.put("capabilities", state.card().capabilities());
        json.put("topic", state.card().topic());
        json.put("connected", state.connected());
        json.put("lastSeen", state.lastSeen());
        return json;
    }

    /** @return the fold, one entry per node ever seen, ordered by node id */
    public List<NodeState> snapshot() {
        List<NodeState> roster = new ArrayList<>(nodes.values());
        roster.sort(Comparator.comparing(state -> state.card().id()));
        return List.copyOf(roster);
    }

    /**
     * Per-node replay from the hub ring, filtered to the node's own frames,
     * plus whether the ring already evicted earlier ones (a truncated replay).
     *
     * @param nodeId the node to replay
     * @return its ring-held frames + truncated flag, or empty for an unknown node
     */
    public Optional<NodeReplay> replayFor(String nodeId) {
        NodeState state = nodes.get(nodeId);
        if (state == null || hub == null) {
            return Optional.empty();
        }
        ProcessBusHub.RingReplay ring = hub.replay(state.card().topic());
        List<BusEnvelope> frames = ring.frames().stream()
                .filter(env -> env.sender().equals(nodeId))
                .toList();
        boolean truncated = ring.gaps().stream()
                .anyMatch(gap -> gap.sender().equals(nodeId));
        return Optional.of(new NodeReplay(frames, truncated));
    }

    /**
     * One node's ring replay: the frames still held for it, and whether the
     * ring already evicted any of its earlier frames.
     *
     * @param frames    the node's ring-held frames, oldest first
     * @param truncated true when earlier frames of this node were evicted
     */
    public record NodeReplay(List<BusEnvelope> frames, boolean truncated) {
    }

    /** The hub's change signal: re-fold, tap new topics, tell the listeners.
     *  Synchronized — two connections may join/leave concurrently, and the
     *  fold must not interleave. */
    private synchronized void rosterChanged() {
        List<NodeCard> live = hub.roster();
        long now = System.currentTimeMillis();
        for (NodeCard card : live) {
            nodes.put(card.id(), new NodeState(card, true, now));
            if (tappedTopics.add(card.topic())) {
                // The card IS the topic discovery — first sighting taps it.
                hub.subscribe(card.topic(), this::fleetEvent);
            }
        }
        Set<String> liveIds = ConcurrentHashMap.newKeySet();
        live.forEach(card -> liveIds.add(card.id()));
        nodes.replaceAll((id, state) -> liveIds.contains(id)
                ? state
                : new NodeState(state.card(), false, state.lastSeen()));
        List<NodeState> roster = snapshot();
        for (Listener listener : listeners) {
            try {
                listener.onRoster(roster);
            } catch (RuntimeException broken) {
                log.warn("fleet roster listener failed: {}", broken.toString());
            }
        }
    }

    /** One frame off the tap: touch last-seen, forward to the web side. */
    private void fleetEvent(BusEnvelope envelope) {
        nodes.computeIfPresent(envelope.sender(), (id, state) ->
                new NodeState(state.card(), state.connected(), System.currentTimeMillis()));
        for (Listener listener : listeners) {
            try {
                listener.onFleetEvent(envelope);
            } catch (RuntimeException broken) {
                log.warn("fleet event listener failed: {}", broken.toString());
            }
        }
    }

    /** Spring calls this on context shutdown — the hub's port is released. */
    @Override
    public void close() {
        if (hub != null) {
            hub.close();
        }
    }
}
