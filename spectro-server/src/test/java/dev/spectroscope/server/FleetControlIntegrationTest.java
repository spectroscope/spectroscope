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
import org.springframework.http.ResponseEntity;

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

    @Test
    void aStopPostDispatchesTheVerbToTheNodeAnd404sForAGhost() throws Exception {
        String base = "http://127.0.0.1:" + port;

        // A node that never joined cannot be stopped — a 404, not a silent 202.
        assertEquals(404, rest.postForEntity(base + "/api/fleet/ghost/stop", null, String.class)
                .getStatusCode().value(), "stopping an unknown node is a 404");

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

            ResponseEntity<String> resp = rest.postForEntity(
                    base + "/api/fleet/node-stop/stop", null, String.class);
            assertEquals(202, resp.getStatusCode().value(), "a dispatched stop is Accepted (best-effort)");
            assertEquals("stop", received.poll(10, TimeUnit.SECONDS),
                    "the node received the stop verb over the hub");
        }
    }
}
