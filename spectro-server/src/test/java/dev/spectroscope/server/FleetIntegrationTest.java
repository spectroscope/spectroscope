package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.BusPublisher;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fleet, end to end with the hub ENABLED (SPECTRO_HUB_PORT=0): a real
 * ProcessBus node joins the server-hosted hub, the roster surfaces on REST,
 * and a web socket hears both fleet frames — the empty roster on connect, the
 * roster again on join, and the node's events live. The sibling suite
 * (SpectroServerIntegrationTest) runs with the hub OFF and pins that no fleet
 * frame ever appears there.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "SPECTRO_HUB_PORT=0")
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class FleetIntegrationTest {

    private static final String CTX = "fleet-it";
    private static final ObjectMapper JSON = new ObjectMapper();

    @LocalServerPort
    private int port;

    @Autowired
    private FleetAggregator fleet;

    @Autowired
    private TestRestTemplate rest;

    @Test
    void aRealNodeSurfacesOnRestAndBothSocketFrames() throws Exception {
        List<JsonNode> frames = new CopyOnWriteArrayList<>();
        CountDownLatch connectRoster = new CountDownLatch(1);
        CountDownLatch rosterWithNode = new CountDownLatch(1);
        CountDownLatch eventFrame = new CountDownLatch(1);
        WebSocket.Listener listener = new WebSocket.Listener() {
            private final StringBuilder frame = new StringBuilder();

            @Override
            public CompletionStage<?> onText(WebSocket socket, CharSequence data, boolean last) {
                frame.append(data);
                if (last) {
                    try {
                        JsonNode node = JSON.readTree(frame.toString());
                        frames.add(node);
                        if ("fleet_roster".equals(node.path("type").asText())) {
                            connectRoster.countDown();
                            if (node.path("nodes").size() > 0) {
                                rosterWithNode.countDown();
                            }
                        }
                        if ("fleet_event".equals(node.path("type").asText())) {
                            eventFrame.countDown();
                        }
                    } catch (IOException ignored) {
                        // not JSON — ignore
                    }
                    frame.setLength(0);
                }
                socket.request(1);
                return null;
            }
        };

        int listenersBefore = fleet.listenerCount();

        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"), listener)
                    .join();

            // The connect-time roster arrives BEFORE any node joins — proof
            // start() sends the initial roster, not only the join-triggered one.
            // Without it this whole assertion would be vacuous.
            assertTrue(connectRoster.await(20, TimeUnit.SECONDS),
                    "a fleet_roster arrives on connect, before any node joins");
            JsonNode firstRoster = frames.stream()
                    .filter(f -> "fleet_roster".equals(f.path("type").asText()))
                    .findFirst().orElseThrow();
            assertEquals(0, firstRoster.path("nodes").size(),
                    "the connect-time roster is empty — no node has joined yet");

            NodeCard card = new NodeCard("node-it", "worker",
                    List.of("read_file"), BusEnvelope.topicFor(CTX));
            try (ProcessBus node = new ProcessBus("127.0.0.1", fleet.port(),
                    "node-it", 1024, card)) {
                assertTrue(rosterWithNode.await(20, TimeUnit.SECONDS),
                        "the join reaches the browser as a fleet_roster frame");
                new BusPublisher(node, "node-it", CTX)
                        .onEvent(new RunEvent.TextDelta("main", "live", 42L));
                assertTrue(eventFrame.await(20, TimeUnit.SECONDS),
                        "the node's event reaches the browser as a fleet_event frame");
            }
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();

            // The closed socket detaches its fleet listener — no per-connection
            // leak growing the singleton aggregator's listener list forever.
            long deadline = System.currentTimeMillis() + 10_000;
            while (fleet.listenerCount() > listenersBefore
                    && System.currentTimeMillis() < deadline) {
                Thread.sleep(20);
            }
            assertEquals(listenersBefore, fleet.listenerCount(),
                    "a closed socket detaches its fleet listener");
        }

        JsonNode event = frames.stream()
                .filter(f -> "fleet_event".equals(f.path("type").asText()))
                .findFirst().orElseThrow();
        assertEquals("node-it", event.path("frame").path("sender").asText(),
                "the frame rides in canonical envelope form");
        assertEquals("text_delta", event.path("frame").path("payload").path("type").asText());

        // REST: the roster fold and the ring replay.
        JsonNode fleetBody = JSON.readTree(rest.getForObject(
                "http://127.0.0.1:" + port + "/api/fleet", String.class));
        assertTrue(fleetBody.path("enabled").asBoolean());
        assertEquals("node-it", fleetBody.path("nodes").get(0).path("id").asText());

        JsonNode replay = JSON.readTree(rest.getForObject(
                "http://127.0.0.1:" + port + "/api/fleet/node-it/events", String.class));
        assertTrue(replay.path("ringBounded").asBoolean(), "the replay names its bound");
        assertFalse(replay.path("truncated").asBoolean(),
                "one frame, nothing evicted — a complete replay, not a truncated one");
        assertEquals(1, replay.path("events").size());

        // Pin the canonical fields EXPLICITLY: epoch and sequence must be
        // present, not coincidentally equal to Jackson's missing-node default
        // of 0 — otherwise env.toLine could drop or rename them unnoticed.
        JsonNode envelope = replay.path("events").get(0);
        assertEquals("node-it", envelope.path("sender").asText());
        assertTrue(envelope.hasNonNull("epoch"), "the canonical form carries an epoch field");
        assertTrue(envelope.hasNonNull("sequence"), "the canonical form carries a sequence field");
        assertEquals(0, envelope.path("epoch").asLong());
        assertEquals(0, envelope.path("sequence").asLong());

        ResponseEntity<String> ghost = rest.getForEntity(
                "http://127.0.0.1:" + port + "/api/fleet/ghost/events", String.class);
        assertEquals(404, ghost.getStatusCode().value(), "an unknown node is a 404");
    }
}
