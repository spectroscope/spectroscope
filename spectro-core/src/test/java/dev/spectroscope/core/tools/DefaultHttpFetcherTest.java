package dev.spectroscope.core.tools;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The production fetcher against a local server: status passthrough and the body cap. */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class DefaultHttpFetcherTest {

    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    private String start(byte[] body, int status) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            exchange.getResponseHeaders().add("Content-Type", "text/html");
            exchange.sendResponseHeaders(status, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/";
    }

    @Test
    void aHugeBodyIsCappedInsteadOfBufferedInFull() throws IOException {
        byte[] big = new byte[DefaultHttpFetcher.MAX_BODY_BYTES + 100_000];
        Arrays.fill(big, (byte) 'x');

        HttpFetcher.Fetched fetched = new DefaultHttpFetcher().fetch(start(big, 200));

        assertEquals(200, fetched.status());
        assertEquals(DefaultHttpFetcher.MAX_BODY_BYTES, fetched.body().length(),
                "the raw body must be capped before the HTML strip pipeline");
    }

    /**
     * The root cause behind review finding F1: {@code HttpURLConnection} follows
     * same-protocol redirects all by itself, so the fetcher used to walk to an
     * address the fence had never been shown. A redirect must come back as DATA.
     */
    @Test
    void aRedirectComesBackAsDataInsteadOfBeingFollowed() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            boolean hop = exchange.getRequestURI().getPath().startsWith("/hop");
            byte[] body = (hop ? "moved" : "ARRIVED").getBytes(StandardCharsets.UTF_8);
            if (hop) {
                exchange.getResponseHeaders().add("Location", "/here");
            }
            exchange.sendResponseHeaders(hop ? 302 : 200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();

        HttpFetcher.Fetched fetched = new DefaultHttpFetcher()
                .fetch("http://127.0.0.1:" + server.getAddress().getPort() + "/hop");

        assertEquals(302, fetched.status(), "the transport must not follow the hop itself");
        assertEquals("/here", fetched.location(), "the Location is handed up verbatim");
    }

    @Test
    void nonOkStatusesPassThroughWithoutThrowing() throws IOException {
        HttpFetcher.Fetched fetched = new DefaultHttpFetcher()
                .fetch(start("nope".getBytes(StandardCharsets.UTF_8), 404));

        assertEquals(404, fetched.status());
        assertTrue(fetched.body().contains("nope"));
    }
}
