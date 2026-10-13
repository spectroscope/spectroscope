package dev.spectroscope.server.fleet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 585: the whole server boots while another socket holds the hub port it
 * was told to use. The hub stays off, the roster says why, and the port check
 * the fleet settings ask before saving answers "in use" for that port.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"server.address=127.0.0.1", "SPECTRO_HUB_ENABLED=true", "fleet.hub.held=on"})
@Timeout(value = 90, unit = TimeUnit.SECONDS)
class HubNeverStopsTheBootTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ServerSocket HELD = holdOne();

    private static ServerSocket holdOne() {
        try {
            ServerSocket held = new ServerSocket();
            held.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
            return held;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void hubPort(DynamicPropertyRegistry registry) {
        registry.add("SPECTRO_HUB_PORT", () -> String.valueOf(HELD.getLocalPort()));
    }

    @AfterAll
    static void release() throws IOException {
        HELD.close();
    }

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate rest;

    private JsonNode get(String path) throws Exception {
        ResponseEntity<String> response = rest.getForEntity("http://localhost:" + port + path, String.class);
        return JSON.readTree(response.getBody());
    }

    @Test
    void theServerStartsAndTheRosterSaysWhyTheHubIsOff() throws Exception {
        JsonNode fleet = get("/api/fleet");
        assertFalse(fleet.path("enabled").asBoolean(true), "the hub is off");
        assertTrue(fleet.path("hubPort").isNull());
        JsonNode hub = fleet.path("hub");
        assertEquals("true", hub.path("enabledSetting").asText());
        assertEquals(String.valueOf(HELD.getLocalPort()), hub.path("portSetting").asText());
        assertEquals("bind-failed", hub.path("note").asText());
        assertFalse(hub.path("reason").asText("").isBlank(), "the reason in plain words");
        assertTrue(hub.path("message").asText().contains(String.valueOf(HELD.getLocalPort())),
                hub.path("message").asText());
    }

    @Test
    void thePortCheckSaysAHeldPortIsInUse() throws Exception {
        JsonNode held = get("/api/fleet/port-check?port=" + HELD.getLocalPort());
        assertFalse(held.path("free").asBoolean(true), held.toString());
        assertFalse(held.path("thisHub").asBoolean(true));

        int free;
        try (ServerSocket probe = new ServerSocket()) {
            probe.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
            free = probe.getLocalPort();
        }
        assertTrue(get("/api/fleet/port-check?port=" + free).path("free").asBoolean(false));

        ResponseEntity<String> admin = rest.getForEntity(
                "http://localhost:" + port + "/api/fleet/port-check?port=80", String.class);
        assertEquals(400, admin.getStatusCode().value());
        assertEquals("under-1024", JSON.readTree(admin.getBody()).path("reason").asText());
    }

    @Test
    void thePortCheckRefusesTheAppsRangeAndTheServersOwnPort() throws Exception {
        // Review D1. Refused before any bind: nothing touches 8080 to 8100 here.
        for (String reserved : new String[] {"8080", "8100"}) {
            ResponseEntity<String> refused = rest.getForEntity(
                    "http://localhost:" + port + "/api/fleet/port-check?port=" + reserved, String.class);
            assertEquals(400, refused.getStatusCode().value(), reserved);
            assertEquals("app-range", JSON.readTree(refused.getBody()).path("reason").asText());
        }
        ResponseEntity<String> own = rest.getForEntity(
                "http://localhost:" + port + "/api/fleet/port-check?port=" + port, String.class);
        assertEquals(400, own.getStatusCode().value());
        assertEquals("server-port", JSON.readTree(own.getBody()).path("reason").asText());
    }
}
