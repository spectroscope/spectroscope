package dev.spectroscope.orchestrator;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** The one strict hub-address parser (SPECTRO_HUB and --hub share it). */
class HubAddressTest {

    @Test
    void parsesHostAndPort() {
        HubAddress a = HubAddress.parse("127.0.0.1:47100");
        assertEquals("127.0.0.1", a.host());
        assertEquals(47100, a.port());
    }

    @Test
    void rejectsMalformedLoudly() {
        assertThrows(IllegalArgumentException.class, () -> HubAddress.parse("nocolon"));
        assertThrows(IllegalArgumentException.class, () -> HubAddress.parse("host:"));
        assertThrows(IllegalArgumentException.class, () -> HubAddress.parse("host:notaport"));
        assertThrows(IllegalArgumentException.class, () -> HubAddress.parse("host:70000"));
        assertThrows(IllegalArgumentException.class, () -> HubAddress.parse("host:0"));
        assertThrows(IllegalArgumentException.class, () -> HubAddress.parse("[::1]:7000"), "IPv6 refused");
        assertThrows(IllegalArgumentException.class, () -> new HubAddress("h", 0));
        assertThrows(IllegalArgumentException.class, () -> new HubAddress("h", 70000));
    }

    @Test
    void fromEnvIsNullWhenUnsetOrBlank() {
        assertNull(HubAddress.fromEnv(Map.of()));
        assertNull(HubAddress.fromEnv(Map.of("SPECTRO_HUB", "")));
        assertNull(HubAddress.fromEnv(Map.of("SPECTRO_HUB", "   ")));
    }

    @Test
    void fromEnvParsesWhenSetAndThrowsOnMalformed() {
        assertEquals(new HubAddress("127.0.0.1", 47100),
                HubAddress.fromEnv(Map.of("SPECTRO_HUB", "127.0.0.1:47100")));
        assertThrows(IllegalArgumentException.class,
                () -> HubAddress.fromEnv(Map.of("SPECTRO_HUB", "bad")));
    }
}
