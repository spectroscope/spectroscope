package dev.spectroscope.server.web;

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
 * The WebSocket handshake fence (card 92): the same loopback + Host + Origin
 * bar the REST endpoints wear, applied to {@code /ws}. Port-agnostic — a
 * loopback host on ANY port passes (dev vite 5173, server 8098, …); an
 * origin-less local tool passes (it keeps reading every event); a foreign
 * browser origin is refused, closing cross-site WebSocket hijacking.
 */
class LocalOriginHandshakeInterceptorTest {

    private final LocalOriginHandshakeInterceptor interceptor = new LocalOriginHandshakeInterceptor();

    /** A loopback-peer, localhost-Host handshake carrying the given Origin (null = none). */
    private boolean handshake(String origin, String serverName, String remoteAddr) {
        MockHttpServletRequest servletReq = new MockHttpServletRequest();
        servletReq.setServerName(serverName);
        servletReq.setRemoteAddr(remoteAddr);
        if (origin != null) {
            servletReq.addHeader("Origin", origin);
        }
        ServletServerHttpRequest req = new ServletServerHttpRequest(servletReq);
        ServletServerHttpResponse res = new ServletServerHttpResponse(new MockHttpServletResponse());
        return interceptor.beforeHandshake(req, res, null, new HashMap<>());
    }

    @Test
    void aLoopbackOriginOnAnyPortIsAccepted() {
        // The port changes constantly in dev — the fence keys on the HOST only.
        assertTrue(handshake("http://localhost:5173", "localhost", "127.0.0.1"));
        assertTrue(handshake("http://localhost:8098", "localhost", "127.0.0.1"));
        assertTrue(handshake("http://127.0.0.1:8090", "127.0.0.1", "127.0.0.1"));
    }

    @Test
    void anOriginlessLocalToolIsAccepted() {
        // CLI, a Node script, an observability tap — no Origin header. These are
        // exactly the "watch every event" clients the owner wants to keep open.
        assertTrue(handshake(null, "localhost", "127.0.0.1"));
    }

    @Test
    void aForeignBrowserOriginIsRefused() {
        // The cross-site WebSocket hijack: a page on evil.example connecting to
        // the local socket to drive the agent. Its Origin betrays it.
        MockHttpServletResponse raw = new MockHttpServletResponse();
        MockHttpServletRequest servletReq = new MockHttpServletRequest();
        servletReq.setServerName("localhost");
        servletReq.setRemoteAddr("127.0.0.1");
        servletReq.addHeader("Origin", "https://evil.example");
        boolean accepted = interceptor.beforeHandshake(
                new ServletServerHttpRequest(servletReq),
                new ServletServerHttpResponse(raw), null, new HashMap<>());
        assertFalse(accepted, "a foreign origin must not complete the handshake");
        assertEquals(403, raw.getStatus(), "and it is refused, not silently dropped");
    }

    @Test
    void aReboundHostIsRefused() {
        // Loopback peer + localhost origin but an attacker Host — the DNS-
        // rebinding vector the Host check exists for.
        assertFalse(handshake("http://localhost:8098", "attacker.example", "127.0.0.1"));
    }

    @Test
    void aNonLoopbackPeerIsRefused() {
        assertFalse(handshake(null, "localhost", "203.0.113.7"));
    }
}
