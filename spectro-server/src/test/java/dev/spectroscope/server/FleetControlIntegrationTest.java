package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.http.RequestEntity;
import org.springframework.http.ResponseEntity;

import java.net.URI;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fleet CONTROL surface over HTTP (block 3): POST /api/fleet/{node}/stop
 * dispatches a ctl{stop} to a connected node and answers honestly (202 sent,
 * 404 unknown). Its own Spring context (the {@code fleet.control=on} marker
 * forces a separate cache key) so its joined node never pollutes the sibling
 * roster suite's empty-connect-roster assertion.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"SPECTRO_HUB_PORT=0", "fleet.control=on"})
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class FleetControlIntegrationTest {

    private static final String CTX = "fleet-ctl-it";
    private static final ObjectMapper JSON = new ObjectMapper();

    @LocalServerPort
    private int port;

    @Autowired
    private FleetAggregator fleet;

    @Autowired
    private TestRestTemplate rest;

    /** A local-origin JSON POST (empty body) — the shape the UI's stop button sends. */
    private ResponseEntity<String> stopPost(String url) {
        return rest.exchange(
                RequestEntity.post(URI.create(url)).contentType(MediaType.APPLICATION_JSON).build(),
                String.class);
    }

    @Test
    void aStopPostDispatchesTheVerbToTheNodeAnd404sForAGhost() throws Exception {
        String base = "http://127.0.0.1:" + port;

        // A node that never joined cannot be stopped — a 404, not a silent 202.
        assertEquals(404, stopPost(base + "/api/fleet/ghost/stop").getStatusCode().value(),
                "stopping an unknown node is a 404");

        NodeCard card = new NodeCard("node-stop", "worker",
                List.of("read_file"), BusEnvelope.topicFor(CTX));
        try (ProcessBus node = new ProcessBus("127.0.0.1", fleet.port(), "node-stop", 1024, card)) {
            BlockingQueue<String> received = new LinkedBlockingQueue<>();
            node.onControl(received::add);

            // wait until the node surfaces as connected on the REST roster
            long deadline = System.currentTimeMillis() + 20_000;
            boolean connected = false;
            while (!connected && System.currentTimeMillis() < deadline) {
                JsonNode body = JSON.readTree(rest.getForObject(base + "/api/fleet", String.class));
                for (JsonNode n : body.path("nodes")) {
                    if ("node-stop".equals(n.path("id").asText()) && n.path("connected").asBoolean()) {
                        connected = true;
                    }
                }
                if (!connected) {
                    Thread.sleep(50);
                }
            }
            assertTrue(connected, "the node joined the roster before the stop");

            ResponseEntity<String> resp = stopPost(base + "/api/fleet/node-stop/stop");
            assertEquals(202, resp.getStatusCode().value(), "a dispatched stop is Accepted (best-effort)");
            assertEquals("stop", received.poll(10, TimeUnit.SECONDS),
                    "the node received the stop verb over the hub");
        }
    }

    @Test
    void stopAlsoRejectsANonJsonBody() {
        // The stop endpoint got the same CSRF guard as spawn — a form POST is 415.
        ResponseEntity<String> nonJson = rest.exchange(
                RequestEntity.post(URI.create("http://127.0.0.1:" + port + "/api/fleet/node-x/stop"))
                        .contentType(MediaType.TEXT_PLAIN).body("x"),
                String.class);
        assertEquals(415, nonJson.getStatusCode().value(),
                "stop only accepts application/json — a browser form POST cannot reach it");
    }

    @Test
    void spawnIsHiddenWhenNotOptedInAndRejectsANonJsonBody() {
        String url = "http://127.0.0.1:" + port + "/api/fleet/nodes";

        // The hub is on here, but SPECTRO_ALLOW_SPAWN is NOT — spawning hides
        // itself behind a 404 (default off is the whole point of the opt-in).
        ResponseEntity<String> off = rest.postForEntity(url,
                new SpawnRequest("go", "fleet-x", null, null, false), String.class);
        assertEquals(404, off.getStatusCode().value(),
                "spawn is 404 unless SPECTRO_ALLOW_SPAWN is set");

        // The CSRF guard: only application/json reaches the handler, so a
        // browser <form> POST (a "simple" request, no preflight) is a 415.
        ResponseEntity<String> nonJson = rest.exchange(
                RequestEntity.post(URI.create(url)).contentType(MediaType.TEXT_PLAIN).body("prompt=go"),
                String.class);
        assertEquals(415, nonJson.getStatusCode().value(),
                "only application/json is accepted — a cross-origin form POST cannot reach it");
    }
}
