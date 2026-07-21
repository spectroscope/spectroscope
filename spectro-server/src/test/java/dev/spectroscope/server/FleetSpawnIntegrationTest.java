package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The spawn endpoint over HTTP with spawning ENABLED: a JSON POST is Accepted
 * and the endpoint builds a FORCED-readonly node command. A capturing launcher
 * (a {@code @Primary} test bean) records the argv instead of starting a process,
 * so the test proves the HTTP → NodeSpawner wiring without a child JVM or an LLM.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"SPECTRO_HUB_PORT=0", "SPECTRO_ALLOW_SPAWN=true"})
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class FleetSpawnIntegrationTest {

    /** The commands the capturing launcher recorded — asserted by the test. */
    static final List<List<String>> CAPTURED = new CopyOnWriteArrayList<>();

    @TestConfiguration
    static class CapturingLauncherConfig {
        /** A NodeSpawner whose launcher CAPTURES the argv — no process starts. */
        @Bean
        @Primary
        NodeSpawner capturingSpawner(FleetAggregator fleet) {
            return new NodeSpawner(true, "", fleet, CAPTURED::add);
        }
    }

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate rest;

    @Test
    void aJsonSpawnPostIsAcceptedAndBuildsAReadonlyNodeCommand() {
        CAPTURED.clear();
        String url = "http://127.0.0.1:" + port + "/api/fleet/nodes";

        ResponseEntity<String> resp = rest.postForEntity(url,
                new SpawnRequest("scan the workspace", "fleet-sp", "reviewer", null, false), String.class);

        assertEquals(202, resp.getStatusCode().value(), "a spawn request is Accepted");
        assertEquals(1, CAPTURED.size(), "the endpoint invoked the launcher exactly once");
        List<String> cmd = CAPTURED.get(0);
        assertTrue(cmd.contains("node"), "the node subcommand");
        assertEquals("readonly", cmd.get(cmd.indexOf("--permissions") + 1),
                "a UI-spawned node is FORCED readonly, over HTTP as everywhere else");
        assertEquals("fleet-sp", cmd.get(cmd.indexOf("--context") + 1));
        assertEquals("reviewer", cmd.get(cmd.indexOf("--role") + 1));
    }
}
