package dev.spectroscope.server;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * The {@code /ws/shell} handshake fence (card 93) — the strictest gate in the app,
 * because past it is the operator's own shell with the operator's own privileges
 * and no permission gate (the operator types, not the agent).
 *
 * <p>It wears the two predicates every other local surface wears
 * ({@link LocalOrigin#isLocalOrigin} for loopback + Host, and
 * {@link LocalOrigin#originIsLoopbackOrAbsent} for CSRF) and differs from
 * {@code /ws} in three ways, each deliberate:</p>
 *
 * <ul>
 *   <li><b>404, not 403.</b> The Logs/Settings style: a non-local caller cannot
 *       tell a refusal from an endpoint that does not exist. The card asks for the
 *       endpoint to be absent rather than merely refusing.</li>
 *   <li><b>An Origin is required.</b> {@code /ws} accepts an Origin-less client on
 *       purpose — a CLI or an observability tap reading every event. A shell has no
 *       such client, and a browser always sends Origin on a WebSocket handshake, so
 *       requiring it costs nothing legitimate. Honest about its size: a local
 *       process can forge the header, so this is least privilege rather than a
 *       boundary. The boundary against other local processes is the OS user.</li>
 *   <li><b>Availability is part of the gate.</b> No PTY helper in this install, or
 *       the operator set {@code SPECTRO_SHELL=off}, and the endpoint is simply not
 *       there.</li>
 * </ul>
 *
 * <p>{@link LocalOriginHandshakeInterceptor} is untouched — card 92's contract and
 * its tests keep their own shape.</p>
 *
 * <p>Public since card 186: WebSocketConfig in .web adds it to the /ws/shell handshake.</p>
 */
public final class ShellHandshakeInterceptor implements HandshakeInterceptor {

    private final BooleanSupplier ptyAvailable;
    private final BooleanSupplier featureEnabled;

    /**
     * @param ptyAvailable   whether a terminal can be opened at all
     * @param featureEnabled whether the operator left the feature on
     */
    public ShellHandshakeInterceptor(BooleanSupplier ptyAvailable, BooleanSupplier featureEnabled) {
        this.ptyAvailable = ptyAvailable;
        this.featureEnabled = featureEnabled;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
            WebSocketHandler wsHandler, Map<String, Object> attributes) {
        if (!(request instanceof ServletServerHttpRequest servlet)) {
            // No servlet request means no address, Host or Origin to judge. On the
            // one endpoint that hands out a shell, unknown is a no.
            response.setStatusCode(HttpStatus.NOT_FOUND);
            return false;
        }
        HttpServletRequest req = servlet.getServletRequest();
        boolean allowed = featureEnabled.getAsBoolean()
                && ptyAvailable.getAsBoolean()
                && LocalOrigin.isLocalOrigin(req)
                && LocalOrigin.originIsLoopbackOrAbsent(req)
                && originPresent(req);
        if (!allowed) {
            response.setStatusCode(HttpStatus.NOT_FOUND); // no fingerprint in the refusal
            return false;
        }
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
            WebSocketHandler wsHandler, Exception exception) {
        // nothing to do — the gate is entirely in beforeHandshake
    }

    /**
     * The one rule {@code /ws} does not have: the header must actually be there.
     * Combined with {@link LocalOrigin#originIsLoopbackOrAbsent} above, the
     * pair means "present AND loopback".
     *
     * @param request the servlet request
     * @return whether an Origin header was sent at all
     */
    private static boolean originPresent(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        return origin != null && !origin.isBlank();
    }
}
