package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The doctor's OTLP probe endpoint, exercised directly with seams. */
class OtlpProbeControllerTest {

    private static SpectroConfig config(String endpoint, String auth) {
        return new SpectroConfig("anthropic", "m", null, 100000, "ask", List.of(), "gemini",
                false, List.of(), 2, false, List.of(), null, "info", null, null, null,
                endpoint, auth);
    }

    @Test
    void offWhenNoEndpointIsConfigured() {
        OtlpProbeController controller =
                new OtlpProbeController(() -> config(null, null), (e, a) -> {});
        Map<String, Object> out = controller.probe();
        assertEquals(false, out.get("configured"));
        assertNull(out.get("ok"));
    }

    @Test
    void okWhenTheProbeSucceeds() {
        OtlpProbeController controller = new OtlpProbeController(
                () -> config("http://localhost:3000/api/public/otel", "pk:sk"), (e, a) -> {});
        Map<String, Object> out = controller.probe();
        assertEquals(true, out.get("configured"));
        assertEquals(true, out.get("ok"));
        assertEquals("http://localhost:3000/api/public/otel", out.get("endpoint"));
        assertFalse(out.containsKey("message"));
        assertFalse(out.toString().contains("sk"), "auth never echoed");
    }

    @Test
    void readableFailureWhenTheEndpointRejects() {
        OtlpProbeController controller = new OtlpProbeController(
                () -> config("http://down:1/api", null),
                (e, a) -> { throw new IllegalStateException("HTTP 401"); });
        Map<String, Object> out = controller.probe();
        assertEquals(true, out.get("configured"));
        assertEquals(false, out.get("ok"));
        assertTrue(String.valueOf(out.get("message")).contains("401"));
    }
}
