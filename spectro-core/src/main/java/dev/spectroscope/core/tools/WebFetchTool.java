package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool.ToolContext;
import dev.spectroscope.core.web.HtmlText;


/**
 * The {@code web_fetch} tool: a URL in, the page's readable text out. Network
 * egress is a side effect on untrusted (model-supplied) input, so it is
 * permission-gated exactly like run_command. The HTTP call goes through an
 * injected {@link HttpFetcher} seam (a RestClient impl in production, a fake in
 * tests). HTML is reduced to text by the shared hand-rolled {@link HtmlText}
 * strip — no jsoup, so the core gains no new dependency.
 *
 * <p>Card 199 put a {@link NetFence} in front of the fetch. The URL is model
 * output, and the model reads whatever page it was last shown, so file URLs,
 * RFC-1918, the 100.64/10 tailnet and (without an explicit opt-in) loopback are
 * refused before a request leaves. The refusal names the address and the rule
 * and carries nothing else — not the path, not the query string, not the
 * userinfo, any of which a model-assembled URL may carry a token in.
 */
public final class WebFetchTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;

    private final HttpFetcher fetcher;
    private final NetFence fence;

    /**
     * Builds the tool over the injected network seam, fenced at the default:
     * loopback and the private ranges refused.
     *
     * @param fetcher {@link DefaultHttpFetcher} in production, an in-memory fake in tests
     */
    public WebFetchTool(HttpFetcher fetcher) {
        this(fetcher, NetFence.withSystemDns(false));
    }

    /**
     * The fully wired tool.
     *
     * @param fetcher {@link DefaultHttpFetcher} in production, an in-memory fake in tests
     * @param fence   where this tool may go — built from {@code allowLocalhost} in the settings
     */
    public WebFetchTool(HttpFetcher fetcher, NetFence fence) {
        this.fetcher = fetcher;
        this.fence = fence;
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
        NetFence.Refusal refusal = fence.refuse(url);
        if (refusal != null) {
            return "ERROR: web_fetch " + refusal.sentence();
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
