package dev.spectroscope.server;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;

/**
 * The {@code /ws} handshake fence (card 92): the REST endpoints are all
 * loopback + Host + Origin gated, but the socket ran {@code
 * setAllowedOrigins("*")} with no check — so any page the operator had open in
 * a browser could connect and drive the local agent (user_message +
 * self-approved permission_response = RCE). This applies the SAME fence
 * ({@link FleetController#isLocalOrigin} + {@link
 * FleetController#originIsLoopbackOrAbsent}) to the handshake, one source of
 * truth. It is port-agnostic: the Origin check keys on the HOST, so every dev
 * port (vite 5173, server 8080/8090/8098) passes, an origin-less local tool
 * passes (it keeps reading every event), and only a foreign browser origin is
 * refused.
 */
public class LocalOriginHandshakeInterceptor implements HandshakeInterceptor {

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
            WebSocketHandler wsHandler, Map<String, Object> attributes) {
        if (request instanceof ServletServerHttpRequest servlet) {
            HttpServletRequest req = servlet.getServletRequest();
            boolean local = FleetController.isLocalOrigin(req)
                    && FleetController.originIsLoopbackOrAbsent(req);
            if (!local) {
                response.setStatusCode(HttpStatus.FORBIDDEN);
                return false;
            }
        }
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
            WebSocketHandler wsHandler, Exception exception) {
        // nothing to do — the gate is entirely in beforeHandshake
    }
}
