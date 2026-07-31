package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.annotation.JsonInclude;

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
 * @param trigger      additive (card 72): what a standing node waits on
 *                     ("watch:/drop", "listen:127.0.0.1:8300", "every:5m",
 *                     combined with " + "); null on every plain node —
 *                     NON_NULL keeps the pre-card-72 shape on any Jackson face
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record NodeCard(String id, String role, List<String> capabilities, String topic,
                       String trigger) {

    public NodeCard {
        Objects.requireNonNull(id, "id");
        // The id is a single REST path segment (/api/fleet/{node}/events) and a
        // roster key, so it must be URL-safe: a slash would make the node's own
        // replay URL unroutable, and "."/".." are reserved path segments.
        if (!id.matches("[A-Za-z0-9._-]+") || id.equals(".") || id.equals("..")) {
            throw new IllegalArgumentException(
                    "node id must be URL-safe [A-Za-z0-9._-] and not \".\"/\"..\", was: \"" + id + "\"");
        }
        Objects.requireNonNull(role, "role");
        capabilities = List.copyOf(Objects.requireNonNull(capabilities, "capabilities"));
        Objects.requireNonNull(topic, "topic");
    }

    /**
     * The pre-card-72 arity — a plain card, no trigger note. Every existing
     * construction site lands here unchanged.
     *
     * @param id           the node's sender id on the bus
     * @param role         what the node is for, free-form
     * @param capabilities the tool names this node's registry offers
     * @param topic        the fleet session topic the node publishes on
     */
    public NodeCard(String id, String role, List<String> capabilities, String topic) {
        this(id, role, capabilities, topic, null);
    }
}
