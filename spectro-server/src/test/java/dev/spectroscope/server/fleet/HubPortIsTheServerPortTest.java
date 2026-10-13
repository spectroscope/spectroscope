package dev.spectroscope.server.fleet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
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
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Review D1 of card 585: the hub port is the server's own port. The hub used
 * to bind it before Tomcat did, and the server failed to start. Now the hub
 * walks to a free port, the server starts on its port, and the roster says why.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {"server.address=127.0.0.1", "SPECTRO_HUB_ENABLED=true"})
@Timeout(value = 90, unit = TimeUnit.SECONDS)
class HubPortIsTheServerPortTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    /** A free loopback port, released at once: the server and the hub are told to use it. */
    private static final int PORT = freePort();

    private static int freePort() {
        try (ServerSocket probe = new ServerSocket()) {
            probe.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
            return probe.getLocalPort();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void samePort(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> String.valueOf(PORT));
        registry.add("SPECTRO_HUB_PORT", () -> String.valueOf(PORT));
    }

    @Autowired
    private TestRestTemplate rest;

    @Test
    void theServerStartsOnItsPortAndTheHubTakesAnother() throws Exception {
        ResponseEntity<String> response = rest.getForEntity("http://localhost:" + PORT + "/api/fleet", String.class);
        assertEquals(200, response.getStatusCode().value(), "the server answers on its own port");
        JsonNode fleet = JSON.readTree(response.getBody());
        assertTrue(fleet.path("enabled").asBoolean(false), fleet.toString());
        assertNotEquals(PORT, fleet.path("hubPort").asInt(), "the hub never takes the server's port");
        assertEquals("port-server", fleet.path("hub").path("note").asText());
        assertTrue(fleet.path("hub").path("message").asText().contains(String.valueOf(PORT)));
    }
}
