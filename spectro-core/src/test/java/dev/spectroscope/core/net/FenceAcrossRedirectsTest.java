package dev.spectroscope.core.net;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.DefaultHttpFetcher;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.Tool.ToolContext;
import dev.spectroscope.core.tools.WebFetchTool;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fence across a redirect chain — the review probe of 2026-08-13, turned
 * into a test that runs anywhere.
 *
 * <p><b>What it caught.</b> The fence was asked exactly once, about the URL the
 * model typed, and the transport walked on by itself: a loopback page answering
 * {@code 302} sent the agent to the LAN and to the tailnet and handed the body
 * back, with the fence never consulted for the second address. Three probes
 * against real servers proved it. So the proof here uses a REAL socket too: a
 * real {@link HttpServer} on loopback, the real {@link DefaultHttpFetcher}, the
 * real {@link WebFetchTool}, the real {@link NetFence}. Only DNS is a table, so
 * the private addresses need not exist on the machine running this.
 *
 * <p>The refused hop is never connected to, which is what makes the test
 * hermetic: a refusal happens before a socket is opened.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class FenceAcrossRedirectsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The addresses of the review's three networks, answered from a table. */
    private static final NetFence.Resolver DNS = host -> switch (host) {
        case "lan.test" -> List.of(InetAddress.getByName("192.168.50.154"));
        case "node.tailnet" -> List.of(InetAddress.getByName("100.97.87.86"));
        case "public.test" -> List.of(InetAddress.getByName("93.184.216.34"));
        default -> List.of(InetAddress.getByName(host));
    };

    private HttpServer server;
    private final List<String> served = new CopyOnWriteArrayList<>();

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    /**
     * A loopback server that answers {@code //hop} with a 302 to {@code away}
     * and {@code /here} with a body — the shape of the review's probe page.
     *
     * @param away where the redirect points, or null for a plain page
     * @return the origin of the started server
     */
    private String start(String away) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            served.add(exchange.getRequestURI().getPath());
            byte[] body;
            if (exchange.getRequestURI().getPath().startsWith("/hop") && away != null) {
                exchange.getResponseHeaders().add("Location", away);
                body = "moved".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(302, body.length);
            } else {
                exchange.getResponseHeaders().add("Content-Type", "text/html");
                body = "<html><body>SECRET-PRIVATE-WORLD</body></html>"
                        .getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, body.length);
            }
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static Tool fetcher(boolean allowLocalhost) {
        return new WebFetchTool(new DefaultHttpFetcher(), new NetFence(allowLocalhost, DNS));
    }

    private static ToolContext context() {
        return new ToolContext(Path.of("."), new CancelSignal());
    }

    private static JsonNode urlInput(String url) {
        return JSON.createObjectNode().put("url", url);
    }

    @Test
    void aRedirectInsideTheSameHostIsFollowedAsItAlwaysWas() throws IOException {
        String origin = start("/here");

        String result = fetcher(true).execute(urlInput(origin + "/hop"), context());

        assertTrue(result.contains("SECRET-PRIVATE-WORLD"),
                "a same-host redirect is a normal page load, got: " + result);
        assertEquals(List.of("/hop", "/here"), served,
                "both hops were really requested — the tool followed, the fence allowed");
    }

    @Test
    void aRedirectOntoTheLanIsRefusedAndNeverConnectedTo() throws IOException {
        // The review's PROBE-3, verbatim in shape: loopback opted in, and the
        // page answers 302 to an RFC-1918 address.
        String origin = start("http://lan.test:9971/loot?token=secret");

        String result = fetcher(true).execute(urlInput(origin + "/hop"), context());

        assertEquals("ERROR: web_fetch refused lan.test:9971: it is a private network address, "
                + "RFC 1918 (rule: rfc1918).", result);
        assertEquals(List.of("/hop"), served, "the refused hop never left the machine");
    }

    @Test
    void aRedirectOntoTheTailnetIsRefusedAndNeverConnectedTo() throws IOException {
        // PROBE-4: the same trick, aimed at 100.64/10.
        String origin = start("http://node.tailnet:9972/loot");

        String result = fetcher(true).execute(urlInput(origin + "/hop"), context());

        assertEquals("ERROR: web_fetch refused node.tailnet:9972: it is in 100.64/10, "
                + "the range a tailnet uses (rule: cgnat-tailnet).", result);
        assertEquals(List.of("/hop"), served, "the refused hop never left the machine");
    }

    @Test
    void aRedirectThatPointsAtItselfStopsInsteadOfSpinning() throws IOException {
        String origin = start("/hop");   // every hop answers "go to /hop"

        String result = fetcher(true).execute(urlInput(origin + "/hop"), context());

        assertEquals("ERROR: web_fetch gave up after " + WebFetchTool.MAX_REDIRECTS
                + " redirects.", result);
        assertEquals(WebFetchTool.MAX_REDIRECTS + 1, served.size(),
                "the budget is hops, and it is spent exactly once: " + served);
    }
}
