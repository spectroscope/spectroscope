package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.orchestrator.BusEnvelope;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The fleet's REST face (block C): the roster fold and per-node ring replay.
 * Honest by construction — {@code enabled:false} with an empty roster is a
 * valid answer (the hub is opt-in), and the replay names its bound: the hub
 * ring is the whole story, there is no fleet store behind it.
 */
@RestController
public class FleetController {

    private final FleetAggregator fleet;
    /** One shared configured mapper for the whole module (module convention). */
    private final ObjectMapper mapper = new ObjectMapper();

    FleetController(FleetAggregator fleet) {
        this.fleet = fleet;
    }

    /** @return whether the hub is on, plus every node ever seen this uptime */
    @GetMapping("/api/fleet")
    public Map<String, Object> fleet() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("enabled", fleet.enabled());
        body.put("nodes", fleet.snapshot().stream().map(FleetAggregator::nodeJson).toList());
        return body;
    }

    /**
     * Per-node replay from the hub ring — bounded by the ring, and saying so.
     *
     * @param node the node id from the roster
     * @return its ring-held frames in canonical envelope form, or 404 for a
     *         node the fold has never seen
     */
    @GetMapping("/api/fleet/{node}/events")
    public ResponseEntity<Map<String, Object>> events(@PathVariable("node") String node) {
        return fleet.replayFor(node)
                .map(replay -> {
                    Map<String, Object> body = new LinkedHashMap<>();
                    body.put("node", node);
                    body.put("ringBounded", true); // the ring IS the replay story
                    body.put("truncated", replay.truncated()); // did the ring evict earlier frames?
                    body.put("events", replay.frames().stream().map(this::canonical).toList());
                    return ResponseEntity.ok(body);
                })
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** The envelope's canonical line IS the frame format — reuse it verbatim. */
    private JsonNode canonical(BusEnvelope envelope) {
        try {
            return mapper.readTree(envelope.toLine(mapper));
        } catch (IOException impossible) {
            throw new UncheckedIOException(
                    "own envelope line unreadable: " + envelope.id(), impossible);
        }
    }
}
