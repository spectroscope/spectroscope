package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.HashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The {@code /ws/shell} handshake fence (card 93). This endpoint hands a browser
 * the operator's own shell, so it wears the two predicates {@code /ws} wears
 * ({@link FleetController#isLocalOrigin} + {@link
 * FleetController#originIsLoopbackOrAbsent}) and then goes further in three ways:
 *
 * <ul>
 *   <li>it refuses with <b>404</b>, the Logs/Settings style, not /ws's 403 — a
 *       non-local caller cannot learn that a shell endpoint exists at all;</li>
 *   <li>an <b>Origin-less</b> caller is refused. /ws deliberately accepts one (a
 *       CLI or an observability tap that reads every event); a shell has no such
 *       client, and the strictest rule that still works is the one to pick;</li>
 *   <li>the endpoint is <b>absent</b> when there is no PTY helper to run or the
 *       operator switched shells off.</li>
 * </ul>
 */
class ShellHandshakeInterceptorTest {

    /** The production-shaped fence: helper present, feature on. */
    private final ShellHandshakeInterceptor open =
            new ShellHandshakeInterceptor(() -> true, () -> true);

    private MockHttpServletResponse lastResponse;

    /** One handshake attempt; {@code origin} null means the header is absent. */
    private boolean handshake(ShellHandshakeInterceptor fence, String origin,
            String serverName, String remoteAddr) {
        MockHttpServletRequest servletReq = new MockHttpServletRequest();
        servletReq.setServerName(serverName);
        servletReq.setRemoteAddr(remoteAddr);
        if (origin != null) {
            servletReq.addHeader("Origin", origin);
        }
        lastResponse = new MockHttpServletResponse();
        return fence.beforeHandshake(new ServletServerHttpRequest(servletReq),
                new ServletServerHttpResponse(lastResponse), null, new HashMap<>());
    }

    @Test
    void theOperatorsOwnBrowserOnAnyPortIsAccepted() {
        // The port moves constantly in dev; the fence keys on the HOST only.
        assertTrue(handshake(open, "http://localhost:5173", "localhost", "127.0.0.1"));
        assertTrue(handshake(open, "http://localhost:8302", "localhost", "127.0.0.1"));
        assertTrue(handshake(open, "http://127.0.0.1:8302", "127.0.0.1", "127.0.0.1"));
    }

    @Test
    void aNonLoopbackPeerIsRefusedAsAbsent() {
        assertFalse(handshake(open, "http://localhost:8302", "localhost", "203.0.113.7"));
        assertEquals(404, lastResponse.getStatus(), "no fingerprint in the refusal");
    }

    @Test
    void aForeignBrowserOriginIsRefusedAsAbsent() {
        assertFalse(handshake(open, "https://evil.example", "localhost", "127.0.0.1"));
        assertEquals(404, lastResponse.getStatus());
    }

    @Test
    void aReboundHostIsRefusedAsAbsent() {
        // Loopback peer, loopback Origin, attacker Host — DNS rebinding.
        assertFalse(handshake(open, "http://localhost:8302", "attacker.example", "127.0.0.1"));
        assertEquals(404, lastResponse.getStatus());
    }

    @Test
    void anOriginlessCallerIsRefusedWhereWsWouldAcceptIt() {
        // This is the one rule /ws does not have. A browser always sends Origin
        // on a WebSocket handshake, so nothing legitimate loses a shell here.
        assertFalse(handshake(open, null, "localhost", "127.0.0.1"));
        assertEquals(404, lastResponse.getStatus());
        // ... and the contrast is the point: /ws keeps that client.
        assertTrue(new LocalOriginHandshakeInterceptor().beforeHandshake(
                new ServletServerHttpRequest(loopbackRequest(null)),
                new ServletServerHttpResponse(new MockHttpServletResponse()),
                null, new HashMap<>()));
    }

    @Test
    void aBlankOriginHeaderIsRefused() {
        assertFalse(handshake(open, "   ", "localhost", "127.0.0.1"));
        assertEquals(404, lastResponse.getStatus());
    }

    @Test
    void withoutAPtyHelperTheEndpointIsAbsent() {
        ShellHandshakeInterceptor noHelper =
                new ShellHandshakeInterceptor(() -> false, () -> true);
        assertFalse(handshake(noHelper, "http://localhost:8302", "localhost", "127.0.0.1"));
        assertEquals(404, lastResponse.getStatus());
    }

    @Test
    void theKillSwitchMakesTheEndpointAbsent() {
        ShellHandshakeInterceptor off =
                new ShellHandshakeInterceptor(() -> true, () -> false);
        assertFalse(handshake(off, "http://localhost:8302", "localhost", "127.0.0.1"));
        assertEquals(404, lastResponse.getStatus());
    }

    private static MockHttpServletRequest loopbackRequest(String origin) {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setServerName("localhost");
        req.setRemoteAddr("127.0.0.1");
        if (origin != null) {
            req.addHeader("Origin", origin);
        }
        return req;
    }
}
