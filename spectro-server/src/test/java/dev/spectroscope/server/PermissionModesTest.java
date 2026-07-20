package dev.spectroscope.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * PermissionModes.decide: the mode gate consulted BEFORE the allowlist in
 * SessionConnection.parkingBroker — "auto" allows every gated call, "readonly"
 * denies every gated call, and "ask" (plus anything unrecognized) falls
 * through to the allowlist + dialog.
 */
class PermissionModesTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static PermissionRequest request(String name) {
        return new PermissionRequest("main", "call-1", name, JSON.createObjectNode(), 1L);
    }

    @Test
    void askFallsThrough() {
        assertNull(PermissionModes.decide("ask", request("write_file")));
    }

    @Test
    void autoAllowsEverything() {
        assertEquals(Boolean.TRUE, PermissionModes.decide("auto", request("run_command")));
    }

    @Test
    void readonlyDeniesEveryGatedCall() {
        assertEquals(Boolean.FALSE, PermissionModes.decide("readonly", request("write_file")));
        assertEquals(Boolean.FALSE, PermissionModes.decide("readonly", request("run_command")));
    }

    @Test
    void unknownOrNullModeFallsThrough() {
        assertNull(PermissionModes.decide(null, request("write_file")));
        assertNull(PermissionModes.decide("garbage", request("write_file")));
    }
}
