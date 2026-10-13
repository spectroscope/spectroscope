package dev.spectroscope.core.net;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ConnectException;
import java.net.Socket;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Card 582: a dead port is dead at 127.0.0.1, the address the tests dial. */
class LoopbackPortsTest {

    @Test
    void aDeadPortIsNeverOneALoopbackListenerHolds() throws IOException {
        try (LoopbackPorts.Held held = LoopbackPorts.holdNext(64)) {
            assumeTrue(held.blindsAWildcardProbe(),
                    "this kernel did not hand a wildcard bind a held port, so it cannot show the defect");

            int port = LoopbackPorts.dead();

            assertFalse(held.contains(port), "dead() returned " + port + ", which a 127.0.0.1 listener holds");
            assertThrows(ConnectException.class, () -> new Socket(LoopbackPorts.loopback(), port).close(),
                    "nothing answers on the dead port " + port);
        }
    }
}
