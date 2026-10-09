package dev.spectroscope.server;

import dev.spectroscope.core.tools.HostGuard;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 396, criterion 3: the server's own port is in the host guard's
 * protected set, so {@code lsof -ti :PORT | xargs kill} on it is refused in
 * this very JVM.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"server.address=127.0.0.1"})
class OwnPortGuardTest {

    @LocalServerPort
    private int port;

    @Test
    void theServersOwnPortIsProtected() {
        assertTrue(HostGuard.protectedPorts().contains(port),
                "port " + port + " in " + HostGuard.protectedPorts());
        String text = HostGuard.live().refusal("lsof -ti :" + port + " | xargs kill")
                .orElseThrow(() -> new AssertionError("lsof on the server's port was not refused"));
        assertTrue(text.contains("protected PID " + ProcessHandle.current().pid() + " "), text);
    }

    @Test
    void theServersOwnPortIsTheAppPortTheBrowserFenceUses() {
        // Card 472: the browser fence lets the app's own code graph view
        // through on this port and no other.
        assertEquals(port, dev.spectroscope.server.web.OwnPort.get());
    }
}
