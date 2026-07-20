package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

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
        assertEquals("ERROR: web_fetch only supports http and https URLs.",
                tool.execute(urlInput("ftp://example.com/x"), context()));
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
}
