package dev.spectroscope.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;

import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

/**
 * The shell socket: one WebSocket per terminal tab, one terminal per WebSocket.
 * Keying it that way is what makes the card's "no orphans" promise cheap — the
 * connection closing IS the tab closing, and there is exactly one child to reap.
 *
 * <p>The wire is binary both ways. Up: {@link ShellFrame} (keystrokes, resize).
 * Down: raw terminal bytes as binary, and control notices (ready, exit, error) as
 * small JSON text frames, so the renderer never has to guess which is which.</p>
 *
 * <p>Everything arriving here is browser input and the thing behind it is a real
 * shell, so the rules are closed by default: a frame the decoder cannot name ends
 * the connection, a text frame ends the connection, and every way the connection
 * ends reaps the child. The handshake fence
 * ({@link ShellHandshakeInterceptor}) has already refused anything non-local
 * before this class sees a thing.</p>
 */
final class ShellSocketHandler extends AbstractWebSocketHandler {

    private static final int DEFAULT_ROWS = 24;
    private static final int DEFAULT_COLS = 80;

    private final ObjectMapper mapper = new ObjectMapper();
    private final ShellRegistry registry;
    private final PtyProvider provider;

    /** Supplies the configured workspace, read fresh per connection. */
    private final Supplier<String> configuredWorkspace;

    /**
     * Production wiring.
     *
     * @param registry the process-wide shell registry
     * @param provider the PTY seam
     */
    ShellSocketHandler(ShellRegistry registry, PtyProvider provider) {
        this(registry, provider,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none()).workspace());
    }

    /**
     * Seam for tests.
     *
     * @param registry            the registry
     * @param provider            the PTY seam
     * @param configuredWorkspace supplies the configured workspace path
     */
    ShellSocketHandler(ShellRegistry registry, PtyProvider provider,
            Supplier<String> configuredWorkspace) {
        this.registry = registry;
        this.provider = provider;
        this.configuredWorkspace = configuredWorkspace;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession socket) {
        // A paste is the only large frame a terminal ever receives; the container
        // default of 8 KiB would cut one in half and close the socket.
        socket.setBinaryMessageSizeLimit(ShellFrame.MAX_DATA * 4);
        String sessionId = queryParam(socket, "session");
        int rows = intParam(socket, "rows", DEFAULT_ROWS, ShellFrame.MAX_ROWS);
        int cols = intParam(socket, "cols", DEFAULT_COLS, ShellFrame.MAX_COLS);
        Path cwd;
        try {
            cwd = ShellCwd.ensure(sessionId, configuredWorkspace);
        } catch (IllegalArgumentException | IOException noWorkspace) {
            // Same reticence as the fence: the client learns nothing about why.
            refuse(socket, "no shell here");
            return;
        }
        Sink sink = new Sink(socket);
        try {
            registry.open(socket.getId(), sessionId, () -> provider.open(cwd, rows, cols), sink);
        } catch (ShellRegistry.TooManyShells tooMany) {
            refuse(socket, tooMany.getMessage());
            return;
        } catch (IOException | RuntimeException failed) {
            refuse(socket, "the shell could not be started");
            return;
        }
        Map<String, Object> ready = new LinkedHashMap<>();
        ready.put("type", "shell_ready");
        ready.put("cwd", cwd.toString());
        ready.put("shell", provider.shellPath());
        ready.put("rows", rows);
        ready.put("cols", cols);
        // The gate does not protect this pane, and pretending otherwise would be
        // the dishonest kind of safe. The client shows this verbatim.
        ready.put("note", "this shell runs with your own privileges; "
                + "the permission gate does not apply to what you type here");
        sink.statusQuietly(json(ready));
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession socket, BinaryMessage message) {
        ShellSession shell = registry.get(socket.getId());
        if (shell == null) {
            return; // the shell is already gone; nothing to type into
        }
        ByteBuffer buffer = message.getPayload();
        byte[] payload = new byte[buffer.remaining()];
        buffer.get(payload);
        ShellFrame.Frame frame;
        try {
            frame = ShellFrame.decode(payload);
        } catch (IllegalArgumentException malformed) {
            // Not tolerated, not skipped: the next byte would be typed into a shell.
            registry.close(socket.getId());
            refuse(socket, "malformed shell frame");
            return;
        }
        if (frame.kind() == ShellFrame.Kind.DATA) {
            shell.onData(frame.data());
        } else {
            shell.onResize(frame.rows(), frame.cols());
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
        // The shell wire is binary in both directions. A text frame is either a
        // confused client or somebody probing, and neither gets a second try.
        registry.close(socket.getId());
        refuse(socket, "the shell wire is binary");
    }

    @Override
    public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
        registry.close(socket.getId());
    }

    @Override
    public void handleTransportError(WebSocketSession socket, Throwable exception) {
        registry.close(socket.getId());
    }

    // ---- helpers ----------------------------------------------------------------

    /** Close the socket with a short reason and no shell behind it. */
    private void refuse(WebSocketSession socket, String reason) {
        try {
            socket.close(CloseStatus.POLICY_VIOLATION.withReason(trim(reason)));
        } catch (IOException | RuntimeException alreadyGone) {
            // the socket is closed either way, which is the point
        }
    }

    /** A close reason has a 123-byte budget in the protocol. */
    private static String trim(String reason) {
        String safe = reason == null ? "refused" : reason;
        return safe.length() <= 100 ? safe : safe.substring(0, 100);
    }

    private String json(Map<String, Object> fields) {
        try {
            return mapper.writeValueAsString(fields);
        } catch (Exception impossible) {
            return "{\"type\":\"shell_error\"}";
        }
    }

    /**
     * One query parameter from the handshake URI — no servlet request exists on a
     * WebSocket, so the query string is split by hand (same as
     * {@link SpectroSocketHandler}).
     *
     * @param socket the socket whose connect URI carries the query
     * @param name   the parameter to read
     * @return the raw value, or null when absent
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

    /** A window dimension from the query: clamped, and unparseable means default. */
    private static int intParam(WebSocketSession socket, String name, int fallback, int max) {
        String raw = queryParam(socket, name);
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        try {
            return ShellFrame.clamp(Integer.parseInt(raw.strip()), max);
        } catch (NumberFormatException notANumber) {
            return fallback;
        }
    }

    /** The socket as a {@link ShellSession.Sink}; sends are serialized per socket. */
    private static final class Sink implements ShellSession.Sink {

        private final WebSocketSession socket;

        Sink(WebSocketSession socket) {
            this.socket = socket;
        }

        @Override
        public void data(byte[] chunk) throws IOException {
            // Never logged. This is the terminal stream, and shells are where
            // passwords get typed.
            synchronized (socket) {
                socket.sendMessage(new BinaryMessage(chunk));
            }
        }

        @Override
        public void status(String json) throws IOException {
            synchronized (socket) {
                socket.sendMessage(new TextMessage(json));
            }
        }

        /** For the ready notice, where a dead socket is not worth an exception. */
        void statusQuietly(String json) {
            try {
                status(json);
            } catch (IOException | RuntimeException gone) {
                // the client hung up during the handshake reply
            }
        }

        @Override
        public void closeSocket(String reason) {
            try {
                socket.close(CloseStatus.NORMAL.withReason(trim(reason)));
            } catch (IOException | RuntimeException alreadyGone) {
                // already closed
            }
        }
    }
}
