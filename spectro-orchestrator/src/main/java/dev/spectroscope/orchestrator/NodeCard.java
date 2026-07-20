package dev.spectroscope.orchestrator;

import java.util.List;
import java.util.Objects;

/**
 * A fleet node's self-description, announced when it joins the bus: the card
 * rides the connection handshake, so registration and liveness ARE the
 * connection — a roster lists the cards of currently connected nodes, and a
 * vanished connection removes its card with it. Static per process:
 * capabilities do not change mid-connection (a node that gains tools comes
 * back as its next incarnation).
 *
 * @param id           the node's sender id on the bus (= its agent id in events)
 * @param role         what the node is for, free-form ("worker", "reviewer", …)
 * @param capabilities the tool names this node's registry offers
 * @param topic        the fleet session topic the node publishes on
 */
public record NodeCard(String id, String role, List<String> capabilities, String topic) {

    public NodeCard {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(role, "role");
        capabilities = List.copyOf(Objects.requireNonNull(capabilities, "capabilities"));
        Objects.requireNonNull(topic, "topic");
    }
}
