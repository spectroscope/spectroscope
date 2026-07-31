package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

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

    /** A legitimate operator request: loopback peer + localhost Host (the
     *  MockHttpServletRequest defaults). */
    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    @Test
    void offWhenNoEndpointIsConfigured() {
        OtlpProbeController controller =
                new OtlpProbeController(() -> config(null, null), (e, a) -> {});
        Map<String, Object> out = controller.probe(local()).getBody();
        assertEquals(false, out.get("configured"));
        assertNull(out.get("ok"));
    }

    @Test
    void okWhenTheProbeSucceeds() {
        OtlpProbeController controller = new OtlpProbeController(
                () -> config("http://localhost:3000/api/public/otel", "pk:sk"), (e, a) -> {});
        Map<String, Object> out = controller.probe(local()).getBody();
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
        Map<String, Object> out = controller.probe(local()).getBody();
        assertEquals(true, out.get("configured"));
        assertEquals(false, out.get("ok"));
        assertTrue(String.valueOf(out.get("message")).contains("401"));
    }

    @Test
    void refusesADnsReboundHost() {
        // A rebinding page reaches loopback but carries the attacker's Host —
        // without the fence it can fingerprint a running spectro and read the
        // configured endpoint URL. Same bar as every fleet endpoint: 404.
        OtlpProbeController controller = new OtlpProbeController(
                () -> config("http://localhost:3000/api/public/otel", "pk:sk"), (e, a) -> {});
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller.probe(rebound).getStatusCode().value());
        assertNull(controller.probe(rebound).getBody(), "no fingerprint in the refusal");
    }

    @Test
    void refusesACrossSiteOrigin() {
        // A cross-site page's GET arrives via loopback with a localhost Host —
        // only the Origin header betrays it. It must not read the endpoint URL.
        OtlpProbeController controller = new OtlpProbeController(
                () -> config("http://localhost:3000/api/public/otel", null), (e, a) -> {});
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, controller.probe(crossSite).getStatusCode().value());
    }

    @Test
    void refusesANonLocalCaller() {
        OtlpProbeController controller =
                new OtlpProbeController(() -> config(null, null), (e, a) -> {});
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
        assertEquals(404, controller.probe(remote).getStatusCode().value());
    }
}
