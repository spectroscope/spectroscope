package dev.spectroscope.cli;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * The HTTP trigger (card 72): {@code POST /trigger} wakes the node's prompt
 * with the body as fenced context. Security posture like the hub, in layers —
 * the bind is the loopback address BY CONSTRUCTION (the flag grammar already
 * refused any host), the handler re-checks the peer anyway, and every request
 * needs the per-boot bearer token, compared constant-time. An oversize body
 * is refused whole (413): truncating a payload would silently change its
 * meaning, and refusal is the honest branch. The token never rides the wire,
 * the card, or any event.
 */
final class HttpTrigger implements TriggerSource {

    /** Verbatim-or-refused cap on the request body. */
    static final int MAX_BODY = 64 * 1024;

    private final HttpServer server;
    private final String token;
    private final Consumer<String> log;
    private volatile FireSink sink;

    HttpTrigger(int port, String token, Consumer<String> log) throws IOException {
        this.token = token;
        this.log = log;
        this.server = HttpServer.create(
                new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
        server.createContext("/", this::handle);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    }

    /** @return the bound port — the flag's port, or the ephemeral one in tests */
    int port() {
        return server.getAddress().getPort();
    }

    /** @return the bound address — a test pins that it is loopback */
    InetAddress boundAddress() {
        return server.getAddress().getAddress();
    }

    @Override
    public String describe() {
        return "listen:127.0.0.1:" + port();
    }

    @Override
    public void start(FireSink sink) {
        this.sink = sink;
        server.start();
    }

    @Override
    public void close() {
        server.stop(0);
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            InetAddress remote = exchange.getRemoteAddress().getAddress();
            if (remote == null || !remote.isLoopbackAddress()) {
                // Unreachable through the loopback bind — kept anyway so a
                // future bind change cannot silently widen the surface.
                respond(exchange, 403, "{\"error\":\"loopback only\"}");
                return;
            }
            if (!"/trigger".equals(exchange.getRequestURI().getPath())) {
                respond(exchange, 404, "{\"error\":\"POST /trigger is the only route\"}");
                return;
            }
            if (!"POST".equals(exchange.getRequestMethod())) {
                respond(exchange, 405, "{\"error\":\"POST only\"}");
                return;
            }
            if (!authorized(exchange)) {
                respond(exchange, 401, "{\"error\":\"missing or wrong bearer token\"}");
                return;
            }
            byte[] body = readAtMost(exchange.getRequestBody());
            if (body == null) {
                respond(exchange, 413, "{\"error\":\"body over " + MAX_BODY
                        + " bytes — refused, never truncated\"}");
                return;
            }
            String payload = new String(body, StandardCharsets.UTF_8); // malformed bytes replaced
            FireSink current = sink;
            FireSlot.Disposition disposition = current == null
                    ? FireSlot.Disposition.REFUSED
                    : current.offer(Fire.http(describe(), payload, remote.getHostAddress()));
            if (disposition == FireSlot.Disposition.REFUSED) {
                log.accept("listen: trigger busy — answered 429, the caller retries");
                respond(exchange, 429, "{\"disposition\":\"busy\"}");
            } else {
                respond(exchange, 202, "{\"disposition\":\"accepted\"}");
            }
        }
    }

    private boolean authorized(HttpExchange exchange) {
        String header = exchange.getRequestHeaders().getFirst("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            return false;
        }
        return MessageDigest.isEqual(
                header.substring("Bearer ".length()).getBytes(StandardCharsets.UTF_8),
                token.getBytes(StandardCharsets.UTF_8));
    }

    /** @return the whole body, or null the moment it exceeds the cap */
    private static byte[] readAtMost(InputStream in) throws IOException {
        byte[] body = in.readNBytes(MAX_BODY + 1);
        return body.length > MAX_BODY ? null : body;
    }

    private static void respond(HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
