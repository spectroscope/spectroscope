package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.tools.Tool.ToolContext;
import dev.spectroscope.core.web.HtmlText;

import java.util.Locale;

/**
 * The {@code web_fetch} tool: a URL in, the page's readable text out. Network
 * egress is a side effect on untrusted (model-supplied) input, so it is
 * permission-gated exactly like run_command. The HTTP call goes through an
 * injected {@link HttpFetcher} seam (a RestClient impl in production, a fake in
 * tests). HTML is reduced to text by the shared hand-rolled {@link HtmlText}
 * strip — no jsoup, so the core gains no new dependency.
 */
public final class WebFetchTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;

    private final HttpFetcher fetcher;

    /**
     * Builds the tool over the injected network seam.
     *
     * @param fetcher {@link DefaultHttpFetcher} in production, an in-memory fake in tests
     */
    public WebFetchTool(HttpFetcher fetcher) {
        this.fetcher = fetcher;
    }

    /** Wire name: {@code web_fetch}. */
    @Override
    public String name() {
        return "web_fetch";
    }

    /** The model-facing one-liner — announces the HTML strip, the truncation and the permission gate. */
    @Override
    public String description() {
        return "Fetches a web page over http/https and returns its readable text "
                + "(HTML stripped, truncated). Network egress — guarded by permission.";
    }

    /** One required string: {@code url}. */
    @Override
    public JsonNode inputSchema() {
        ObjectNode schema = JSON.createObjectNode();
        schema.put("type", "object");
        ObjectNode properties = JSON.createObjectNode();
        properties.set("url", JSON.createObjectNode().put("type", "string"));
        schema.set("properties", properties);
        schema.set("required", JSON.createArrayNode().add("url"));
        return schema;
    }

    /** Untrusted input reaching the network — the human stays in the loop. */
    @Override
    public boolean needsPermission() {
        return true;
    }

    /** Vets the scheme, fetches through the seam and reduces the page to clipped readable text — every failure path is an "ERROR: " string. */
    @Override
    public String execute(JsonNode input, ToolContext context) {
        String url = input.path("url").asText().strip();
        if (url.isBlank()) {
            return "ERROR: web_fetch needs a non-empty url.";
        }
        String lower = url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return "ERROR: web_fetch only supports http and https URLs.";
        }

        // The whole downstream sits in one guard (the GenerateImageTool pattern):
        // a throwing seam AND a null-returning seam both surface as an ERROR string.
        try {
            HttpFetcher.Fetched fetched = fetcher.fetch(url);
            if (fetched.status() < 200 || fetched.status() >= 300) {
                return "ERROR: web_fetch got HTTP " + fetched.status() + " for " + url + ".";
            }
            String text = HtmlText.strip(fetched.body() == null ? "" : fetched.body());
            text = ToolOutput.clip(text, MAX_OUTPUT_CHARS);
            return text.isBlank() ? "(no readable text)" : text;
        } catch (RuntimeException failure) {
            return "ERROR: web_fetch failed: " + failure.getMessage();
        }
    }
}
