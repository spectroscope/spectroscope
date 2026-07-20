package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * One agent and one session per WebSocket connection. The handler owns no run
 * state itself — it holds a SessionConnection per open socket and forwards the
 * three client messages (user_message / permission_response / abort) to it.
 * Incoming frames are parsed with Jackson, never by string matching (tool
 * inputs and client frames are untrusted input).
 */
@Component
public class SpectroSocketHandler extends TextWebSocketHandler {

    /** One shared configured mapper for the whole module (module convention). */
    private final ObjectMapper mapper = new ObjectMapper();

    /** Per-connection state, keyed by the Spring session id. */
    private final Map<String, SessionConnection> connections = new ConcurrentHashMap<>();

    /**
     * A new socket becomes a new SessionConnection — config is loaded fresh per
     * connection, an optional {@code ?resume=<id>} reopens a stored session.
     *
     * @param socket the freshly opened WebSocket session; its id keys the connection map
     */
    @Override
    public void afterConnectionEstablished(WebSocketSession socket) {
        // ?resume=<id> reopens an old session from the JSONL store; absent = new.
        String resumeId = queryParam(socket, "resume");
        // Config + provider + system prompt exactly as the CLI builds them.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
        SessionConnection connection = new SessionConnection(socket, mapper, config, resumeId);
        connections.put(socket.getId(), connection);
        // A resume that cannot load its session closes the socket itself.
        connection.start();
    }

    /**
     * Routes one client frame to the connection owning the socket: parsed as JSON
     * first, then dispatched on {@code type} — non-JSON and unknown types answer
     * a readable error event instead of throwing.
     *
     * @param socket the sending socket, resolved to its SessionConnection
     * @param message the raw text frame from the browser — untrusted input
     */
    @Override
    protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
        SessionConnection connection = connections.get(socket.getId());
        if (connection == null) {
            return;
        }
        JsonNode frame;
        try {
            frame = mapper.readTree(message.getPayload());
        } catch (Exception invalid) {
            connection.sendError("Invalid message (not JSON).");
            return;
        }
        // Never run the agent loop on this Tomcat thread — SessionConnection
        // hands the work to a virtual thread and returns immediately.
        switch (frame.path("type").asText()) {
            // user_message may carry an additive attachments array
            // ({ mediaType, dataBase64 }) — decoded and stored by the connection.
            case "user_message" -> connection.onUserMessage(
                    frame.path("text").asText(""), frame.path("attachments"));
            case "permission_response" ->
                    connection.onPermissionResponse(
                            frame.path("callId").asText(), frame.path("allowed").asBoolean(),
                            frame.path("remember").asBoolean(false),
                            frame.path("persist").asBoolean(false));
            case "abort" -> connection.onAbort();
            case "set_image_provider" ->                       // additive
                    connection.onSetImageProvider(frame.path("provider").asText());
            case "set_thinking" ->                             // thinking, additive
                    connection.onSetThinking(frame.path("enabled").asBoolean());
            case "set_provider" ->                             // provider picker, additive
                    connection.onSetProvider(
                            frame.path("provider").asText(""), frame.path("model").asText(""));
            case "set_workspace" ->                            // folder picker, additive
                    connection.onSetWorkspace(frame.path("path").asText(""));
            case "set_permission_mode" ->                      // composer gear, additive
                    connection.onSetPermissionMode(frame.path("mode").asText(""));
            default -> connection.sendError("Unknown message type.");
        }
    }

    /**
     * Drops the per-connection state when the socket goes away and lets the
     * connection cancel its run — the session's JSONL file deliberately survives.
     *
     * @param socket the closed socket whose connection entry is removed
     * @param status the container's close code — cleanup is unconditional, so unused
     */
    @Override
    public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
        // Socket gone is not session gone: the JSONL file lives on. Cancel any
        // running run and release orphaned permission questions.
        SessionConnection connection = connections.remove(socket.getId());
        if (connection != null) {
            connection.onClose();
        }
    }

    /**
     * Reads one query parameter from the socket's handshake URI — no servlet
     * request exists on a WebSocket, so the query string is split by hand.
     *
     * @param socket the socket whose connect URI carries the query string
     * @param name the parameter to look up
     * @return the raw parameter value, or {@code null} when absent
     */
    private static String queryParam(WebSocketSession socket, String name) {
        String query = socket.getUri() != null ? socket.getUri().getQuery() : null;
        if (query == null) {
            return null;
        }
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(name)) {
                return pair.substring(eq + 1);
            }
        }
        return null;
    }
}
