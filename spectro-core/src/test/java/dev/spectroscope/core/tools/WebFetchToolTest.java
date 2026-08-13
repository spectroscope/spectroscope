package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * web_fetch against an in-memory HttpFetcher — no HTTP at all. Proves HTML→text
 * extraction, the output cap, the bad-scheme / non-2xx / thrown-exception ERROR
 * paths (never throws), and the permission flag. Key-free and network-free by
 * construction — the exact FakeImageProvider pattern.
 */
class WebFetchToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Answers instantly from memory — the HTTP client is not under test here. */
    private record FakeHttpFetcher(int status, String contentType, String body) implements HttpFetcher {
        @Override
        public Fetched fetch(String url) {
            return new Fetched(status, contentType, body);
        }
    }

    private static ToolContext context() {
        return new ToolContext(Path.of("."), new CancelSignal());
    }

    private static JsonNode urlInput(String url) {
        return JSON.createObjectNode().put("url", url);
    }

    @Test
    void stripsHtmlToReadableText() {
        Tool tool = new WebFetchTool(new FakeHttpFetcher(200, "text/html",
                "<html><head><style>b{color:red}</style><script>evil()</script>"
                        + "<title>T</title></head><body><h1>Hello</h1>"
                        + "<p>World &amp; more</p></body></html>"));

        String result = tool.execute(urlInput("https://example.com"), context());

        assertTrue(result.contains("Hello"), "kept body text, got: " + result);
        assertTrue(result.contains("World & more"), "decoded entity, got: " + result);
        assertFalse(result.contains("evil()"), "dropped <script>, got: " + result);
        assertFalse(result.contains("color:red"), "dropped <style>, got: " + result);
    }

    @Test
    void truncatesLongBodiesToTheOutputCap() {
        String big = "a".repeat(20_000);
        Tool tool = new WebFetchTool(new FakeHttpFetcher(200, "text/plain", big));

        String result = tool.execute(urlInput("https://example.com/big"), context());

        assertEquals(10_000, result.length(), "output capped at MAX_OUTPUT_CHARS");
    }

    @Test
    void rejectsNonHttpSchemes() {
        Tool tool = new WebFetchTool(new FakeHttpFetcher(200, "text/html", "ignored"));
        // Card 199: the net fence answers now, and its refusal names what was
        // refused, why, and which rule did it.
        assertEquals("ERROR: web_fetch refused the scheme \"ftp\": only http and https are "
                + "reachable (rule: non-http-scheme).",
                tool.execute(urlInput("ftp://example.com/x"), context()));
        assertEquals("ERROR: web_fetch refused a file:// URL: this tool reaches the network, "
                + "not the local disk (rule: file-url).",
                tool.execute(urlInput("file:///etc/passwd"), context()));
    }

    @Test
    void reportsNon2xxAsError() {
        Tool tool = new WebFetchTool(new FakeHttpFetcher(404, "text/html", "Not Found"));
        String result = tool.execute(urlInput("https://example.com/missing"), context());
        assertTrue(result.startsWith("ERROR: web_fetch got HTTP 404"), "got: " + result);
    }

    @Test
    void aThrowingFetcherBecomesAnErrorStringNeverAnException() {
        Tool tool = new WebFetchTool(url -> { throw new RuntimeException("connect timed out"); });
        assertEquals("ERROR: web_fetch failed: connect timed out",
                tool.execute(urlInput("https://example.com"), context()));
    }

    @Test
    void aNullReturningFetcherBecomesAnErrorStringNeverAnException() {
        Tool tool = new WebFetchTool(url -> null);
        String result = tool.execute(urlInput("https://example.com"), context());
        assertTrue(result.startsWith("ERROR: "), "got: " + result);
    }

    @Test
    void networkEgressNeedsPermission() {
        assertTrue(new WebFetchTool(new FakeHttpFetcher(200, "text/html", "x")).needsPermission());
    }

    // --- the fence across a redirect chain (card 199, review finding F1) ------

    /** Answers a scripted chain and records every URL it was asked for. */
    private static final class ChainFetcher implements HttpFetcher {
        private final Map<String, Fetched> pages;
        final List<String> asked = new ArrayList<>();

        ChainFetcher(Map<String, Fetched> pages) {
            this.pages = pages;
        }

        @Override
        public Fetched fetch(String url) {
            asked.add(url);
            Fetched answer = pages.get(url);
            if (answer == null) {
                throw new IllegalStateException("no page scripted for " + url);
            }
            return answer;
        }
    }

    private static HttpFetcher.Fetched moved(String location) {
        return new HttpFetcher.Fetched(302, "text/html", "moved", location);
    }

    /** A fence that answers from a table: two names, three networks. */
    private static NetFence fence(boolean allowLocalhost) {
        return new NetFence(allowLocalhost, host -> switch (host) {
            case "lan.test" -> List.of(InetAddress.getByName("10.0.0.1"));
            case "example.com", "elsewhere.example" ->
                    List.of(InetAddress.getByName("93.184.216.34"));
            default -> List.of(InetAddress.getByName(host));
        });
    }

    @Test
    void aRelativeRedirectIsResolvedAgainstTheHopItCameFrom() {
        ChainFetcher chain = new ChainFetcher(Map.of(
                "https://example.com/a", moved("/b"),
                "https://example.com/b", new HttpFetcher.Fetched(200, "text/html", "<p>done</p>")));

        Tool tool = new WebFetchTool(chain, fence(false));

        assertEquals("done", tool.execute(urlInput("https://example.com/a"), context()));
        assertEquals(List.of("https://example.com/a", "https://example.com/b"), chain.asked);
    }

    @Test
    void aRedirectOffTheHostIsJudgedBeforeItIsTaken() {
        ChainFetcher chain = new ChainFetcher(Map.of(
                "https://example.com/a", moved("https://lan.test:8080/loot"),
                "https://lan.test:8080/loot",
                new HttpFetcher.Fetched(200, "text/html", "SECRET")));

        Tool tool = new WebFetchTool(chain, fence(false));

        assertEquals("ERROR: web_fetch refused lan.test:8080: it is a private network address, "
                + "RFC 1918 (rule: rfc1918).",
                tool.execute(urlInput("https://example.com/a"), context()));
        assertEquals(List.of("https://example.com/a"), chain.asked,
                "the fenced hop was never fetched");
    }

    @Test
    void aRedirectHomeIsRefusedWhenLoopbackIsNotOptedIn() {
        ChainFetcher chain = new ChainFetcher(Map.of(
                "https://example.com/a", moved("http://127.0.0.1:8746/api/settings"),
                "http://127.0.0.1:8746/api/settings",
                new HttpFetcher.Fetched(200, "application/json", "{}")));

        Tool tool = new WebFetchTool(chain, fence(false));

        String result = tool.execute(urlInput("https://example.com/a"), context());
        assertTrue(result.startsWith("ERROR: web_fetch refused 127.0.0.1:8746:"), "got: " + result);
        assertTrue(result.endsWith("(rule: loopback)."), "got: " + result);
        assertEquals(List.of("https://example.com/a"), chain.asked);
    }

    @Test
    void aRedirectOntoANonHttpSchemeIsRefusedLikeAnyOtherAddress() {
        ChainFetcher chain = new ChainFetcher(Map.of(
                "https://example.com/a", moved("file:///etc/passwd")));

        Tool tool = new WebFetchTool(chain, fence(false));

        assertEquals("ERROR: web_fetch refused a file:// URL: this tool reaches the network, "
                + "not the local disk (rule: file-url).",
                tool.execute(urlInput("https://example.com/a"), context()));
    }

    @Test
    void aRedirectWithoutALocationIsTheEndOfTheChainNotAHop() {
        ChainFetcher chain = new ChainFetcher(Map.of(
                "https://example.com/a", new HttpFetcher.Fetched(302, "text/html", "", null)));

        Tool tool = new WebFetchTool(chain, fence(false));

        assertTrue(tool.execute(urlInput("https://example.com/a"), context())
                .startsWith("ERROR: web_fetch got HTTP 302"));
    }
}
